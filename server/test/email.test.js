// E-mail da nota ao cliente: cliente SMTP (anexos, STARTTLS, AUTH PLAIN, recusas), proteção contra servidores
// internos, texto escrito pela IA (com os fatos do XML oficial) ou pelo modelo simples, envio com PDF e XML,
// histórico por nota, sigilo no banco e na auditoria.
process.env.NODE_ENV = 'test';
process.env.NOTAVEZ_ESPERA_REENVIO_MS = '0';
process.env.NOTAVEZ_TIMEOUT_SEFIN_MS = '1500';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import forge from 'node-forge';
import { gerarCertificadoTeste } from './apoio/certificado-teste.js';
import { iniciarSefinSimulada } from './apoio/sefin-simulada.js';

const { criarApp } = await import('../src/app.js');
const { criarClienteSefin } = await import('../src/fiscal/sefin/cliente.js');
const { ambientesSefin } = await import('../src/config.js');
const smtp = await import('../src/security/smtp.js');
const { lerRedacao, faltasNoTexto, nomeNatural, emailsDoCliente, SISTEMA_EMAIL } = await import('../src/email/nota.js');

const cert = gerarCertificadoTeste({ cnpj: '11222333000181' });

// ------------------------------------------------------------------ servidor SMTP de teste
// Certificado para "localhost"; modo 'ssl' (TLS desde o início) ou 'starttls'; grava cada mensagem recebida.
const chaveTls = forge.pki.rsa.generateKeyPair(2048);
const certTls = (() => {
  const c = forge.pki.createCertificate();
  c.publicKey = chaveTls.publicKey; c.serialNumber = '01';
  c.validity.notBefore = new Date(Date.now() - 86400_000); c.validity.notAfter = new Date(Date.now() + 86400_000);
  c.setSubject([{ name: 'commonName', value: 'localhost' }]); c.setIssuer([{ name: 'commonName', value: 'localhost' }]);
  c.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }]);
  c.sign(chaveTls.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(c);
})();
const opcoesTls = { key: forge.pki.privateKeyToPem(chaveTls.privateKey), cert: certTls };

function servidorSmtp({ modo = 'ssl', auth = 'LOGIN PLAIN', senhaCerta = 's3nh@-de-app', recusarRcpt = null } = {}) {
  const estado = { mensagens: [], conversas: [] };
  const atender = (s, { inicio = true, protegido = modo === 'ssl', conversa = [] } = {}) => {
    let buf = ''; let dados = null; let msg = null; let authEtapa = null; let usuario = '';
    estado.conversas.push(conversa);
    if (inicio) s.write('220 teste ESMTP\r\n');
    const fim = (linha) => s.write(`${linha}\r\n`);
    s.on('error', () => {});
    s.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const linha = buf.slice(0, i); buf = buf.slice(i + 2);
        if (dados !== null) {
          if (linha === '.') { msg.dados = dados; estado.mensagens.push(msg); dados = null; fim('250 2.0.0 OK fila 123'); } else dados += `${linha.startsWith('..') ? linha.slice(1) : linha}\r\n`;
          continue;
        }
        conversa.push(linha);
        if (authEtapa === 'usuario') { usuario = Buffer.from(linha, 'base64').toString(); authEtapa = 'senha'; fim('334 UGFzc3dvcmQ6'); continue; }
        if (authEtapa === 'senha') { authEtapa = null; fim(Buffer.from(linha, 'base64').toString() === senhaCerta ? '235 ok' : (servidor.respostaAuth || '535 5.7.8 Username and Password not accepted')); continue; }
        if (/^EHLO/.test(linha)) {
          const extras = [...(!protegido && modo === 'starttls' ? ['STARTTLS'] : []), ...(protegido ? [`AUTH ${auth}`] : [])];
          s.write(['teste', ...extras].map((x, k, a) => `250${k === a.length - 1 ? ' ' : '-'}${x}\r\n`).join(''));
        } else if (linha === 'STARTTLS') {
          fim('220 pronto');
          s.removeAllListeners('data');
          const seguro = new tls.TLSSocket(s, { isServer: true, ...opcoesTls });
          atender(seguro, { inicio: false, protegido: true, conversa: [] });
          return;
        } else if (linha === 'AUTH LOGIN') { authEtapa = 'usuario'; fim('334 VXNlcm5hbWU6'); }
        else if (linha.startsWith('AUTH PLAIN ')) {
          const [, u, p] = Buffer.from(linha.slice(11), 'base64').toString().split('\0');
          usuario = u; fim(p === senhaCerta ? '235 ok' : '535 5.7.8 Username and Password not accepted');
        } else if (linha.startsWith('MAIL FROM')) { msg = { de: linha, para: [], usuario, protegido }; fim('250 ok'); }
        else if (linha.startsWith('RCPT TO')) {
          const e = /<(.*)>/.exec(linha)[1];
          if (recusarRcpt && e === recusarRcpt) fim('550 5.1.1 The email account that you tried to reach does not exist');
          else { msg.para.push(e); fim('250 ok'); }
        } else if (linha === 'DATA') { dados = ''; fim('354 envie'); }
        else if (linha === 'QUIT') { fim('221 tchau'); s.end(); }
        else fim('500 comando desconhecido');
      }
    });
  };
  const srv = modo === 'ssl' ? tls.createServer(opcoesTls, (s) => atender(s)) : net.createServer((s) => atender(s));
  const servidor = {
    estado, respostaAuth: null,
    iniciar: () => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port))),
    fechar: () => new Promise((ok) => srv.close(ok)),
  };
  return servidor;
}

// Lê uma mensagem MIME simples (cabeçalhos + partes base64).
function lerMime(bruto) {
  const [cabBruto, ...resto] = bruto.split('\r\n\r\n');
  const cab = {};
  for (const l of cabBruto.replace(/\r\n[ \t]/g, ' ').split('\r\n')) { const k = l.indexOf(':'); cab[l.slice(0, k).toLowerCase()] = l.slice(k + 1).trim(); }
  const decodificar = (v) => v.replace(/\?=\s+=\?/g, '?==?').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
  const corpo = resto.join('\r\n\r\n');
  const fronteira = /boundary="([^"]+)"/.exec(cab['content-type'] || '')?.[1];
  const partes = fronteira
    ? corpo.split(`--${fronteira}`).slice(1, -1).map((p) => {
      const [h, ...c] = p.replace(/^\r\n/, '').split('\r\n\r\n');
      return { cabecalho: h, conteudo: Buffer.from(c.join('').replace(/\s/g, ''), 'base64'), nome: /filename="([^"]+)"/.exec(h)?.[1] || null };
    })
    : [{ cabecalho: cab['content-type'], conteudo: Buffer.from(corpo.replace(/\s/g, ''), 'base64'), nome: null }];
  return { cab, assunto: decodificar(cab.subject || ''), de: decodificar(cab.from || ''), partes, texto: partes[0].conteudo.toString('utf8') };
}

// ------------------------------------------------------------------ app de teste
let sefin; let app; let sslSrv; let portaSsl;
const ia = { chamadas: [], resposta: null, erro: null };
before(async () => {
  sefin = await iniciarSefinSimulada({ caPem: cert.caPem, caChavePem: cert.caChavePem, certClientePem: cert.certPem });
  Object.assign(ambientesSefin.producao_restrita, { sefin: sefin.baseUrl, parametros: sefin.baseParametros, adn: sefin.baseAdn });
  sslSrv = servidorSmtp();
  portaSsl = await sslSrv.iniciar();
  app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, fabricaCliente: (o) => criarClienteSefin({ ...o, ca: sefin.ca, timeoutMs: 1500 }),
    chamarIa: async (o) => { ia.chamadas.push(o); if (ia.erro) throw ia.erro; return { texto: ia.resposta, chamadas: [], fim: 'fim', nativo: null, modeloUsado: 'modelo-teste' }; },
    enviarEmail: (o) => smtp.enviarEmail({ ...o, ca: certTls }) });
});
after(async () => { await app.close(); await sefin.fechar(); await sslSrv.fechar(); });

let ips = 0;
function sessao() {
  const remoteAddress = `198.51.100.${++ips}`;
  let cookie = '';
  const api = async (method, url, payload) => {
    if (method === 'POST' && url.endsWith('/emitir') && payload === undefined) {
      const v = await api('POST', url.replace(/emitir$/, 'validar'));
      payload = { versao: v.body.versao, revisao: v.body.revisao };
    }
    const r = await app.inject({ method, url, payload, remoteAddress, headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}) } });
    if (r.headers['set-cookie']) cookie = [r.headers['set-cookie']].flat().map((c) => c.split(';')[0]).join('; ');
    let body; try { body = r.json(); } catch { body = r.body; }
    return { status: r.statusCode, body };
  };
  return api;
}

// Conta com empresa ME/EPP (Simples), certificado, cliente empresa com e-mail e uma nota emitida COM ISS retido.
async function contaComNota(email) {
  const api = sessao();
  assert.equal((await api('POST', '/api/conta/cadastrar', { email, senha: 'senha-segura-1' })).status, 200);
  const p = await api('PUT', '/api/perfil', { documento: '11.222.333/0001-81', nome: 'ESTUDIO WEB LTDA', municipioIbge: '3550308', opSimpNac: '3', regApTribSN: '1', pTotTribSN: '6,00', aliqIssSN: '2,00' });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal((await api('POST', '/api/certificado', { pfxBase64: cert.pfx.toString('base64'), senha: cert.senha, consentimento: true })).status, 200);
  const cli = await api('POST', '/api/clientes', { documento: '11.444.777/0001-61', nome: 'PADARIA CENTRAL LTDA', email: 'financeiro@padaria.test',
    endereco: { cep: '01001000', municipioIbge: '3550308', logradouro: 'Praça da Sé', numero: '100', bairro: 'Sé' } });
  assert.equal(cli.status, 200, JSON.stringify(cli.body));
  const serv = (await api('POST', '/api/servicos', { apelido: 'Site', cTribNac: '010101', descricao: 'Criação e manutenção de site', valorPadrao: '1.500,00' })).body.servico;
  const n = (await api('POST', '/api/notas', { rascunho: { clienteId: cli.body.cliente.id, servicoId: serv.id, issRetido: true, competencia: '2026-10-31' } })).body.nota;
  const e = await api('POST', `/api/notas/${n.id}/emitir`);
  assert.equal(e.body.nota?.situacao, 'emitida', JSON.stringify(e.body).slice(0, 400));
  return { api, nota: e.body.nota, servicoId: serv.id, clienteId: cli.body.cliente.id };
}

const CONFIG = (porta, extra = {}) => ({ host: 'localhost', porta, seguranca: 'ssl', usuario: 'contato@estudio.test', senha: 's3nh@-de-app',
  remetenteEmail: 'contato@estudio.test', remetenteNome: '', responderPara: 'financeiro@estudio.test', copiaParaMim: true, ...extra });

// ------------------------------------------------------------------ unidades
test('mensagem MIME: assunto acentuado codificado, anexos em base64 e cabeçalho sem injeção', () => {
  const pdf = Buffer.from('%PDF-1.4 conteúdo binário \x00\x01\x02');
  const bruto = smtp.montarMensagem({ de: 'a@b.test', nomeRemetente: 'Estúdio Web', para: ['c@d.test', 'e@f.test'], responderPara: 'r@b.test',
    assunto: 'Nota fiscal nº 12 - outubro/2026\r\nBcc: intruso@mal.test', texto: 'Olá!\n.\nLinha com ponto', anexos: [{ nome: 'DANFSe 1.pdf', tipo: 'application/pdf', conteudo: pdf }] });
  assert.ok(!/^Bcc:/mi.test(bruto), 'quebra de linha no assunto não vira cabeçalho');
  const m = lerMime(bruto);
  assert.equal(m.assunto, 'Nota fiscal nº 12 - outubro/2026 Bcc: intruso@mal.test');
  assert.match(m.de, /Estúdio Web <a@b\.test>/);
  assert.equal(m.cab.to, '<c@d.test>, <e@f.test>');
  assert.equal(m.cab['reply-to'], '<r@b.test>');
  assert.equal(m.texto, 'Olá!\r\n.\r\nLinha com ponto');
  assert.equal(m.partes[1].nome, 'DANFSe_1.pdf');
  assert.deepEqual(m.partes[1].conteudo, pdf);
  // Assunto longo: palavras codificadas de até 75 caracteres, dobradas.
  const longo = smtp.cabecalhoUtf8('Ação '.repeat(40));
  assert.ok(longo.split('\r\n ').every((p) => p.length <= 75));
});

test('servidor interno, porta estranha e endereço inválido são recusados antes de conectar', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.0.10', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1', '0.0.0.0']) {
    assert.equal(smtp.enderecoInterno(ip), true, ip);
  }
  for (const ip of ['142.250.0.108', '40.97.0.1', '2607:f8b0::1']) assert.equal(smtp.enderecoInterno(ip), false, ip);
  // Nome público que resolve para a rede interna (DNS malicioso): recusado.
  const resolver = async () => [{ address: '169.254.169.254', family: 4 }];
  await assert.rejects(smtp.resolverServidor('smtp.exemplo.test', { resolver }), /endereço interno/);
  // IPv4 antes do IPv6 (sem saída IPv6, o primeiro endereço do DNS falharia) e todos os endereços conferidos.
  assert.deepEqual(await smtp.resolverServidor('smtp.exemplo.test', { resolver: async () => [{ address: '2607:f8b0::1', family: 6 }, { address: '142.250.0.108', family: 4 }] }),
    { nome: 'smtp.exemplo.test', ip: '142.250.0.108', ips: ['142.250.0.108', '2607:f8b0::1'] });
  await assert.rejects(smtp.resolverServidor('smtp.exemplo.test', { resolver: async () => [{ address: '142.250.0.108', family: 4 }, { address: 'fd00::1', family: 6 }] }), /endereço interno/);
  const base = { host: '127.0.0.1', porta: portaSsl, de: 'a@b.test', para: ['c@d.test'], assunto: 'x', texto: 'y', ca: certTls };
  await assert.rejects(smtp.enviarEmail(base), /Porta de e-mail não aceita/);
  await assert.rejects(smtp.enviarEmail({ ...base, porta: 465 }), /endereço interno/);
  await assert.rejects(smtp.enviarEmail({ ...base, para: ['sem-arroba'] }), /inválido/);
  await assert.rejects(smtp.enviarEmail({ ...base, para: ['x@y.test\r\nRCPT TO:<z@w.test>'] }), /inválido/);
});

test('conexão: prefere IPv4 e, se um endereço não responde, tenta o próximo (sem saída IPv6 o envio não pode falhar)', async () => {
  const base = { host: 'localhost', porta: portaSsl, de: 'a@b.test', para: ['c@d.test'], assunto: 'x', texto: 'y', ca: certTls, permitirRedeLocal: true };
  const antes = sslSrv.estado.mensagens.length;
  // O DNS lista o IPv6 primeiro (onde nada atende): vai direto ao IPv4.
  await smtp.enviarEmail({ ...base, resolver: async () => [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }] });
  // O primeiro IPv4 recusa a conexão: passa para o próximo endereço conferido.
  await smtp.enviarEmail({ ...base, resolver: async () => [{ address: '127.0.0.2', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  assert.equal(sslSrv.estado.mensagens.length, antes + 2);
  // Nenhum endereço atende: mensagem clara.
  await assert.rejects(smtp.enviarEmail({ ...base, resolver: async () => [{ address: '127.0.0.2', family: 4 }] }), /Não consegui conectar/);
});

test('texto: leitura da resposta da IA, nomes naturais e conferência do que precisa estar no e-mail', () => {
  assert.equal(nomeNatural('ESTUDIO WEB LTDA'), 'Estudio Web Ltda');
  assert.equal(nomeNatural('PADARIA DO JOAO E FILHOS ME'), 'Padaria do Joao e Filhos ME');
  assert.equal(nomeNatural('Estúdio Web'), 'Estúdio Web');
  assert.deepEqual(emailsDoCliente('A@x.test; b@y.test', null, 'a@x.test', 'ruim'), ['a@x.test', 'b@y.test']);
  const r = lerRedacao('Aqui está:\n```json\n{"assunto": "Nota fiscal nº 7 — outubro/2026", "corpo": "Olá, tudo bem?\\n\\n**Segue** a nota."}\n```');
  assert.deepEqual(r, { assunto: 'Nota fiscal nº 7 - outubro/2026', corpo: 'Olá, tudo bem?\n\nSegue a nota.' });
  assert.equal(lerRedacao('não é json'), null);
  const fatos = { nota: { numero: '7', competencia: '10/2026', valorServico: 'R$ 1.500,00' } };
  assert.deepEqual(faltasNoTexto(fatos, 'Segue a nota nº 7 de outubro de 2026, valor R$ 1.500,00. Não houve retenção.'), []);
  assert.deepEqual(faltasNoTexto(fatos, 'Segue a nota 17.'), ['o número da nota', 'a competência', 'o valor do serviço', 'se houve retenção']);
  // O system prompt pede o essencial e proíbe o jeito de robô.
  for (const trecho of ['número da nota', 'competência', 'valor do serviço', 'retenção', 'agradecimento', 'Espero que este e-mail o encontre bem', 'emojis', 'invente']) {
    assert.ok(SISTEMA_EMAIL.includes(trecho), trecho);
  }
});

// ------------------------------------------------------------------ fluxo completo
test('enviar ao cliente: destinatário do cadastro, texto pela IA com os fatos da nota, envio com PDF e XML e histórico', async () => {
  const { api, nota } = await contaComNota('envio@exemplo.test');

  // Sem configuração de e-mail: a tela abre (destinatário do cadastro) e avisa; enviar é recusado.
  const prep = await api('GET', `/api/notas/${nota.id}/email`);
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  assert.deepEqual(prep.body.para, ['financeiro@padaria.test']);
  assert.equal(prep.body.config.configurado, false);
  assert.equal(prep.body.iaConfigurada, false);
  assert.deepEqual(prep.body.anexos.map((a) => a.id), ['pdf', 'xml']);
  assert.equal(prep.body.resumo.retencao.houve, true);
  assert.equal(prep.body.resumo.retencao.itens[0].tributo, 'ISS');
  const semCfg = await api('POST', `/api/notas/${nota.id}/email`, { para: ['financeiro@padaria.test'], assunto: 'x', corpo: 'y' });
  assert.equal(semCfg.status, 409);
  assert.equal(semCfg.body.codigo, 'EMAIL_NAO_CONFIGURADO');

  // Sem IA: modelo simples, com número, competência, valor e retenção.
  const modelo = await api('POST', `/api/notas/${nota.id}/email/texto`, {});
  assert.equal(modelo.status, 200, JSON.stringify(modelo.body));
  assert.equal(modelo.body.origem, 'modelo');
  assert.match(modelo.body.corpo, new RegExp(`nº ${nota.nNfse}\\b`));
  assert.match(modelo.body.corpo, /outubro de 2026/);
  assert.match(modelo.body.corpo, /R\$ 1\.500,00/);
  assert.match(modelo.body.corpo, /retenção de ISS \(R\$ 30,00\).*R\$ 1\.470,00/);
  assert.match(modelo.body.corpo, /\nEmpresa Simulada Ltda$/, 'assinado com o nome da empresa na nota, sem caixa alta');
  assert.deepEqual(modelo.body.faltas, []);

  // Com IA: o modelo recebe o system prompt do e-mail e os fatos do XML oficial; a resposta vira assunto e corpo.
  assert.equal((await api('PUT', '/api/ia/config', { provedor: 'anthropic', modelo: 'claude-opus-5-5', chave: 'sk-ant-teste-123456' })).status, 200);
  ia.resposta = JSON.stringify({ assunto: `Nota fiscal nº ${nota.nNfse} - outubro/2026`,
    corpo: `Oi, pessoal da Padaria Central, tudo bem?\n\nSegue a nota nº ${nota.nNfse}, do serviço de outubro de 2026, no valor de R$ 1.500,00. Teve retenção de ISS de R$ 30,00, então o líquido fica R$ 1.470,00.\n\nO PDF e o XML vão em anexo. Obrigado pela parceria de sempre!\n\nAbraço,\nEstudio Web Ltda` });
  const comIa = await api('POST', `/api/notas/${nota.id}/email/texto`, { instrucao: 'mais curto', anexos: ['pdf'] });
  assert.equal(comIa.status, 200, JSON.stringify(comIa.body));
  assert.equal(comIa.body.origem, 'ia');
  assert.deepEqual(comIa.body.faltas, []);
  const chamada = ia.chamadas.at(-1);
  assert.equal(chamada.sistemaFixo, SISTEMA_EMAIL);
  assert.deepEqual(chamada.ferramentas, [], 'sem ferramentas: só escreve');
  const pedido = chamada.historico[0].texto;
  const fatos = JSON.parse(/<fatos>\n([\s\S]*)\n<\/fatos>/.exec(pedido)[1]);
  assert.equal(fatos.nota.numero, nota.nNfse);
  assert.equal(fatos.nota.competencia, '10/2026');
  assert.equal(fatos.nota.valorServico, 'R$ 1.500,00');
  assert.deepEqual(fatos.retencao, { houve: true, itens: [{ tributo: 'ISS', valor: 'R$ 30,00', detalhe: 'retido pelo tomador (o cliente recolhe o ISS)' }], totalRetido: 'R$ 30,00', valorLiquido: 'R$ 1.470,00' });
  assert.deepEqual(fatos.anexos, ['PDF (DANFSe)']);
  assert.equal(fatos.cliente.nomeNatural, 'Padaria Central Ltda');
  assert.equal(fatos.teste, 'nota de teste da Receita (homologação), sem valor fiscal');
  assert.match(pedido, /<preferencias>\nmais curto\n<\/preferencias>/);
  assert.ok(!pedido.includes('financeiro@padaria.test'), 'o e-mail do cliente não vai para a IA');

  // IA fora do ar ou fora do formato: modelo simples, com aviso.
  ia.resposta = 'Claro! Aqui vai o e-mail: Olá...';
  const torto = await api('POST', `/api/notas/${nota.id}/email/texto`, {});
  assert.equal(torto.body.origem, 'modelo');
  assert.match(torto.body.aviso, /fora do formato/);
  ia.erro = new Error('caiu');
  const caiu = await api('POST', `/api/notas/${nota.id}/email/texto`, {});
  assert.equal(caiu.body.origem, 'modelo');
  assert.match(caiu.body.aviso, /não conseguiu escrever/);
  ia.erro = null;

  // Configuração: validada, senha nunca volta para a tela.
  const ruim = await api('PUT', '/api/email/config', { host: 'smtp', porta: 22, seguranca: 'x', remetenteEmail: 'nada' });
  assert.equal(ruim.status, 422);
  // (porta livre só porque o teste roda no próprio computador; em produção, só 25, 465, 587 e 2525)
  assert.deepEqual(Object.keys(ruim.body.campos).sort(), ['host', 'remetenteEmail', 'seguranca']);
  const cfg = await api('PUT', '/api/email/config', CONFIG(portaSsl));
  assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
  assert.equal(cfg.body.config.temSenha, true);
  assert.ok(!JSON.stringify(cfg.body).includes('s3nh@'), 'a senha não volta');
  // Editar sem informar a senha mantém a guardada.
  assert.equal((await api('PUT', '/api/email/config', { ...CONFIG(portaSsl), senha: '' })).body.config.temSenha, true);

  // E-mail de teste para o próprio remetente.
  const teste = await api('POST', '/api/email/config/testar', {});
  assert.equal(teste.status, 200, JSON.stringify(teste.body));
  assert.deepEqual(sslSrv.estado.mensagens.at(-1).para, ['contato@estudio.test']);
  assert.equal(sslSrv.estado.mensagens.at(-1).usuario, 'contato@estudio.test');

  // Envio: destinatário alterado + outro, cópia para mim, texto editado, PDF e XML.
  const antes = sslSrv.estado.mensagens.length;
  const corpo = `Olá, pessoal!\n\nSegue a nota nº ${nota.nNfse} de outubro/2026, R$ 1.500,00, com ISS retido de R$ 30,00.\n\nAbraço,\nEstúdio Web`;
  const env = await api('POST', `/api/notas/${nota.id}/email`, { para: ['Compras@Padaria.test', 'financeiro@padaria.test'], copiaParaMim: true,
    assunto: `Nota fiscal nº ${nota.nNfse} - outubro/2026`, corpo, anexos: ['pdf', 'xml'] });
  assert.equal(env.status, 200, JSON.stringify(env.body));
  assert.equal(sslSrv.estado.mensagens.length, antes + 1);
  const recebida = sslSrv.estado.mensagens.at(-1);
  assert.deepEqual(recebida.para, ['compras@padaria.test', 'financeiro@padaria.test', 'contato@estudio.test']);
  const m = lerMime(recebida.dados);
  assert.equal(m.assunto, `Nota fiscal nº ${nota.nNfse} - outubro/2026`);
  assert.match(m.de, /Empresa Simulada Ltda" <contato@estudio\.test>/, 'sem nome configurado: o nome da empresa');
  assert.equal(m.cab.to, '<compras@padaria.test>, <financeiro@padaria.test>');
  assert.ok(!m.cab.bcc && !m.cab.cc, 'a cópia para mim é oculta');
  assert.equal(m.cab['reply-to'], '<financeiro@estudio.test>');
  assert.equal(m.texto, corpo.replace(/\n/g, '\r\n'));
  assert.deepEqual(m.partes.slice(1).map((p) => p.nome), [`DANFSe-${nota.chaveAcesso}.pdf`, `NFSe-${nota.chaveAcesso}.xml`]);
  assert.equal(m.partes[1].conteudo.subarray(0, 5).toString(), '%PDF-');
  const xmlOficial = await api('GET', `/api/notas/${nota.id}/xml`);
  assert.equal(m.partes[2].conteudo.toString('utf8'), xmlOficial.body);

  // Histórico na nota (tela da nota e da janela de envio).
  assert.equal(env.body.envios.length, 1);
  const tela = await api('GET', `/api/notas/${nota.id}`);
  assert.deepEqual(tela.body.nota.emails.map((e) => e.para), [['compras@padaria.test', 'financeiro@padaria.test']]);
  assert.equal((await api('GET', `/api/notas/${nota.id}/email`)).body.envios[0].assunto, `Nota fiscal nº ${nota.nNfse} - outubro/2026`);

  // Sigilo: nada de e-mail, senha ou assunto em claro no banco nem na auditoria.
  const db = app.ctx.db;
  const linhas = JSON.stringify([...await db.all('SELECT * FROM email_config'), ...await db.all('SELECT * FROM notas_emails'), ...await db.all("SELECT * FROM auditoria WHERE acao LIKE 'email.%' OR acao LIKE 'nota.email%'")]);
  for (const segredo of ['padaria.test', 'estudio.test', 's3nh@', 'localhost', 'outubro']) assert.ok(!linhas.includes(segredo), segredo);
  const aud = await db.get("SELECT detalhes FROM auditoria WHERE acao = 'nota.email_enviado'");
  assert.deepEqual(JSON.parse(aud.detalhes), { destinatarios: 2, copia: 1, anexos: ['pdf', 'xml'] });
});

test('envio: STARTTLS com AUTH PLAIN, recusas do servidor explicadas e nada registrado quando falha', async () => {
  const { api, nota } = await contaComNota('recusas@exemplo.test');
  const st = servidorSmtp({ modo: 'starttls', auth: 'PLAIN', recusarRcpt: 'naoexiste@padaria.test' });
  const porta = await st.iniciar();
  try {
    assert.equal((await api('PUT', '/api/email/config', CONFIG(porta, { seguranca: 'starttls', copiaParaMim: false }))).status, 200);
    const base = { assunto: 'Nota', corpo: 'Segue a nota.', anexos: ['xml'] };
    const ok = await api('POST', `/api/notas/${nota.id}/email`, { ...base, para: ['financeiro@padaria.test'] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const conversa = st.estado.conversas.at(-1);
    assert.ok(conversa.some((l) => l.startsWith('AUTH PLAIN ')), 'servidor só com PLAIN: usa PLAIN');
    assert.ok(st.estado.conversas.at(-2).includes('STARTTLS') && !st.estado.conversas.at(-2).some((l) => l.startsWith('AUTH')), 'nada de senha antes do TLS');
    assert.equal(st.estado.mensagens.at(-1).protegido, true);
    assert.equal(lerMime(st.estado.mensagens.at(-1).dados).partes.length, 2, 'só o XML anexado');

    // Destinatário inexistente: recusa explicada, nenhuma mensagem enviada, nada no histórico.
    const antes = st.estado.mensagens.length;
    const recusado = await api('POST', `/api/notas/${nota.id}/email`, { ...base, para: ['naoexiste@padaria.test'] });
    assert.equal(recusado.status, 502);
    assert.equal(recusado.body.codigo, 'EMAIL_RECUSADO');
    assert.match(recusado.body.erro, /destinatário naoexiste@padaria\.test/);
    assert.equal(st.estado.mensagens.length, antes);
    assert.equal((await api('GET', `/api/notas/${nota.id}/email`)).body.envios.length, 1);

    // Senha errada: explica a "senha de app".
    assert.equal((await api('PUT', '/api/email/config', CONFIG(porta, { seguranca: 'starttls', senha: 'errada' }))).status, 200);
    const auth = await api('POST', '/api/email/config/testar', {});
    assert.equal(auth.status, 502);
    assert.match(auth.body.erro, /senha de app/);
    // Microsoft 365 com o "SMTP autenticado" desligado: explica e aponta o botão "Entrar com a Microsoft".
    const m365 = servidorSmtp({ modo: 'starttls', auth: 'LOGIN', senhaCerta: 'nunca' });
    const portaM365 = await m365.iniciar();
    try {
      m365.respostaAuth = '535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant. Visit https://aka.ms/smtp_auth_disabled for more information.';
      assert.equal((await api('PUT', '/api/email/config', CONFIG(portaM365, { seguranca: 'starttls' }))).status, 200);
      const desligado = await api('POST', '/api/email/config/testar', {});
      assert.equal(desligado.status, 502);
      assert.match(desligado.body.erro, /SMTP autenticado.*desligado.*Entrar com a Microsoft/);
      assert.equal(desligado.body.etapa, 'smtp_desligado');
    } finally { await m365.fechar(); }
    // Segurança trocada (SSL numa porta STARTTLS): mensagem clara, sem travar.
    assert.equal((await api('PUT', '/api/email/config', CONFIG(porta, { seguranca: 'ssl' }))).status, 200);
    const trocada = await api('POST', '/api/email/config/testar', {});
    assert.equal(trocada.status, 502);
    assert.match(trocada.body.erro, /SSL\/TLS na porta 465|não respondeu|conexão/);
  } finally { await st.fechar(); }
});

test('só nota emitida da própria conta: rascunho e nota de outra conta são recusados', async () => {
  const a = await contaComNota('dona@exemplo.test');
  const b = await contaComNota('outra@exemplo.test');
  assert.equal((await b.api('GET', `/api/notas/${a.nota.id}/email`)).status, 404);
  assert.equal((await b.api('POST', `/api/notas/${a.nota.id}/email/texto`, {})).status, 404);
  assert.equal((await b.api('PUT', '/api/email/config', CONFIG(portaSsl))).status, 200);
  assert.equal((await b.api('POST', `/api/notas/${a.nota.id}/email`, { para: ['x@y.test'], assunto: 'a', corpo: 'b' })).status, 404);
  const rasc = (await a.api('POST', '/api/notas', { rascunho: { clienteId: a.clienteId, servicoId: a.servicoId } })).body.nota;
  const r = await a.api('GET', `/api/notas/${rasc.id}/email`);
  assert.equal(r.status, 409);
  assert.match(r.body.erro, /já emitida/);
});
