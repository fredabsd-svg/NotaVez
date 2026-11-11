// Recuperação de senha sem depender de serviço externo: código de recuperação,
// link no terminal (uso local) e e-mail direto por SMTP. E a consulta de CNPJ
// com vários serviços públicos (um fora do ar não impede o cadastro).
process.env.NODE_ENV = 'test';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import forge from 'node-forge';

const { criarApp } = await import('../src/app.js');
const { criarEntregaRecuperacao } = await import('../src/security/recuperacao-entrega.js');
const { enviarEmailSmtp } = await import('../src/security/smtp.js');
const { criarConsultaCnpj, PROVEDORES } = await import('../src/cadastro/consulta-cnpj.js');

let ip = 0;
function cliente(app) {
  const remoteAddress = `198.19.0.${++ip}`;
  let cookie = '';
  return async (method, url, payload) => {
    const r = await app.inject({ method, url, payload, remoteAddress, headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}) } });
    if (r.headers['set-cookie']) cookie = [r.headers['set-cookie']].flat().map((c) => c.split(';')[0]).join('; ');
    return { status: r.statusCode, body: r.json() };
  };
}

test('código de recuperação: dado no primeiro acesso, troca a senha sem e-mail e vale uma vez só', async () => {
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false });
  try {
    const api = cliente(app);
    const c = await api('POST', '/api/conta/cadastrar', { email: 'cod@exemplo.test', documento: '52998224725', senha: 'senha-antiga-1' });
    const codigo = c.body.codigoRecuperacao;
    assert.match(codigo, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    assert.equal((await api('GET', '/api/conta')).body.temCodigoRecuperacao, true);

    const outro = cliente(app);
    // Código errado: recusa sem dizer se a conta existe.
    const errado = await outro('POST', '/api/conta/redefinir-codigo', { usuario: 'cod@exemplo.test', codigo: 'AAAAA-AAAAA-AAAAA-AAAAA', senha: 'senha-nova-123' });
    assert.equal(errado.status, 422);
    assert.equal((await outro('POST', '/api/conta/redefinir-codigo', { usuario: 'ninguem@exemplo.test', codigo, senha: 'senha-nova-123' })).body.erro, errado.body.erro);

    // Aceita minúsculas e sem hífens; entra pelo CPF.
    const r = await outro('POST', '/api/conta/redefinir-codigo', { usuario: '529.982.247-25', codigo: codigo.toLowerCase().replace(/-/g, ' '), senha: 'senha-nova-123' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.notEqual(r.body.codigoRecuperacao, codigo, 'devolve um código novo');
    assert.equal((await api('GET', '/api/conta')).status, 401, 'sessões antigas caem');
    assert.equal((await outro('POST', '/api/conta/entrar', { usuario: 'cod@exemplo.test', senha: 'senha-antiga-1' })).status, 401);
    assert.equal((await outro('POST', '/api/conta/entrar', { usuario: 'cod@exemplo.test', senha: 'senha-nova-123' })).status, 200);
    // O código usado não vale de novo.
    assert.equal((await cliente(app)('POST', '/api/conta/redefinir-codigo', { usuario: 'cod@exemplo.test', codigo, senha: 'outra-senha-99' })).status, 422);

    // Em Conta: gerar outro pede a senha atual e invalida o anterior.
    assert.equal((await outro('POST', '/api/conta/codigo-recuperacao', { senha: 'errada-errada' })).status, 401);
    const novo = await outro('POST', '/api/conta/codigo-recuperacao', { senha: 'senha-nova-123' });
    assert.equal(novo.status, 200);
    assert.equal((await cliente(app)('POST', '/api/conta/redefinir-codigo', { usuario: 'cod@exemplo.test', codigo: r.body.codigoRecuperacao, senha: 'outra-senha-99' })).status, 422);
    assert.equal((await cliente(app)('POST', '/api/conta/redefinir-codigo', { usuario: 'cod@exemplo.test', codigo: novo.body.codigoRecuperacao, senha: 'outra-senha-99' })).status, 200);
  } finally { await app.close(); }
});

test('tentativas de código são limitadas', async () => {
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false });
  try {
    const api = cliente(app);
    await api('POST', '/api/conta/cadastrar', { email: 'lim@exemplo.test', senha: 'senha-segura-1' });
    const status = [];
    for (let i = 0; i < 7; i++) status.push((await api('POST', '/api/conta/redefinir-codigo', { usuario: 'lim@exemplo.test', codigo: `AAAAA-AAAAA-AAAAA-AAAA${i}`, senha: 'senha-nova-123' })).status);
    assert.ok(status.includes(429), status.join(','));
  } finally { await app.close(); }
});

test('sem e-mail configurado, no computador local o link aparece no terminal', async () => {
  const saida = [];
  const entregar = criarEntregaRecuperacao({ url: '', smtpUrl: '', local: true, porta: 8080, escrever: (t) => saida.push(t) });
  assert.equal(entregar.modo, 'terminal');
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, entregarRecuperacao: entregar });
  try {
    const api = cliente(app);
    await api('POST', '/api/conta/cadastrar', { email: 'term@exemplo.test', senha: 'senha-segura-1' });
    assert.equal((await api('GET', '/api/conta/recuperacao')).body.modo, 'terminal');
    const r = await api('POST', '/api/conta/recuperar', { usuario: 'term@exemplo.test' });
    assert.match(r.body.mensagem, /terminal/);
    const token = saida.join('').match(/recuperar-conta\.html#token=([A-Za-z0-9_-]{43})/)?.[1];
    assert.ok(token, saida.join(''));
    assert.equal((await api('POST', '/api/conta/redefinir', { token, senha: 'senha-nova-123' })).status, 200);
    assert.equal((await cliente(app)('POST', '/api/conta/entrar', { usuario: 'term@exemplo.test', senha: 'senha-nova-123' })).status, 200);
  } finally { await app.close(); }
  // Em servidor publicado (não local) e sem configuração: não há entrega; a tela indica o código.
  assert.equal(criarEntregaRecuperacao({ url: '', smtpUrl: '', local: false, modo: '' }), undefined);
});

// Servidor SMTP de teste (TLS desde o início) que grava a conversa.
function servidorSmtp() {
  const ca = forge.pki.rsa.generateKeyPair(2048); const c = forge.pki.createCertificate();
  c.publicKey = ca.publicKey; c.serialNumber = '01';
  c.validity.notBefore = new Date(Date.now() - 86400_000); c.validity.notAfter = new Date(Date.now() + 86400_000);
  c.setSubject([{ name: 'commonName', value: 'localhost' }]); c.setIssuer([{ name: 'commonName', value: 'localhost' }]);
  c.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }]);
  c.sign(ca.privateKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(c);
  const recebido = { linhas: [], dados: '' };
  const srv = tls.createServer({ key: forge.pki.privateKeyToPem(ca.privateKey), cert: certPem }, (s) => {
    let emDados = false; let buf = '';
    s.write('220 teste ESMTP\r\n');
    s.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const linha = buf.slice(0, i); buf = buf.slice(i + 2);
        if (emDados) {
          if (linha === '.') { emDados = false; s.write('250 ok fila\r\n'); } else recebido.dados += `${linha}\n`;
          continue;
        }
        recebido.linhas.push(linha);
        if (linha.startsWith('EHLO')) s.write('250-teste\r\n250 AUTH LOGIN\r\n');
        else if (linha === 'AUTH LOGIN') s.write('334 VXNlcm5hbWU6\r\n');
        else if (recebido.linhas.at(-2) === 'AUTH LOGIN') s.write('334 UGFzc3dvcmQ6\r\n');
        else if (recebido.linhas.at(-3) === 'AUTH LOGIN') s.write('235 ok\r\n');
        else if (linha.startsWith('MAIL FROM') || linha.startsWith('RCPT TO')) s.write('250 ok\r\n');
        else if (linha === 'DATA') { emDados = true; s.write('354 envie\r\n'); }
        else if (linha === 'QUIT') { s.write('221 tchau\r\n'); s.end(); }
      }
    });
  });
  return { srv, certPem, recebido };
}

test('e-mail de recuperação por SMTP: autentica com TLS e manda o link com o endereço público', async () => {
  const { srv, certPem, recebido } = servidorSmtp();
  await new Promise((ok) => srv.listen(0, 'localhost', ok));
  try {
    const url = `smtps://app%40exemplo.test:s3nh%40@localhost:${srv.address().port}`;
    const entregar = criarEntregaRecuperacao({ url: '', smtpUrl: url, smtpDe: 'nao-responda@exemplo.test', urlPublica: 'https://app.exemplo.test',
      enviarEmail: (o) => enviarEmailSmtp({ ...o, ca: certPem }) });
    assert.equal(entregar.modo, 'email');
    await entregar({ email: 'dono@exemplo.test', token: 'T'.repeat(43), expiraEm: new Date(Date.now() + 1800_000).toISOString() });
    const auth = recebido.linhas.slice(recebido.linhas.indexOf('AUTH LOGIN') + 1, recebido.linhas.indexOf('AUTH LOGIN') + 3).map((x) => Buffer.from(x, 'base64').toString());
    assert.deepEqual(auth, ['app@exemplo.test', 's3nh@']);
    assert.ok(recebido.linhas.includes('RCPT TO:<dono@exemplo.test>'));
    const corpo = Buffer.from(recebido.dados.split('\n\n').slice(1).join('').replace(/\s/g, ''), 'base64').toString();
    assert.match(corpo, /https:\/\/app\.exemplo\.test\/recuperar-conta\.html#token=T{43}/);
  } finally { srv.close(); }
  // Sem endereço público https, não sobe (o link precisa apontar para o app publicado).
  assert.throws(() => criarEntregaRecuperacao({ url: '', smtpUrl: 'smtps://x:y@localhost:465', smtpDe: 'a@b.test', urlPublica: '' }), /NOTAVEZ_URL_PUBLICA/);
});

test('SMTP sem TLS nunca envia senha: exige STARTTLS', async () => {
  const srv = net.createServer((s) => { s.write('220 ok\r\n'); s.on('data', (d) => { if (String(d).startsWith('EHLO')) s.write('250 PIPELINING\r\n'); }); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    await assert.rejects(enviarEmailSmtp({ url: `smtp://u:p@127.0.0.1:${srv.address().port}`, de: 'a@b.test', para: 'c@d.test', assunto: 'x', texto: 'y' }), /STARTTLS/);
  } finally { srv.close(); }
});

test('consulta de CNPJ: serviço fora do ar passa para o próximo e o enquadramento é completado por outro', async () => {
  const brasilApi = { razao_social: 'EMPRESA EXEMPLO LTDA', codigo_municipio_ibge: 3550308, municipio: 'SAO PAULO', uf: 'SP', cep: '01001000', opcao_pelo_simples: null, opcao_pelo_mei: null };
  const receitaWs = { status: 'OK', nome: 'EMPRESA EXEMPLO LTDA', municipio: 'SAO PAULO', uf: 'SP', cep: '01.001-000', abertura: '10/02/2015', simples: { optante: true }, simei: { optante: false } };
  const chamadas = [];
  const buscar = async (url) => {
    chamadas.push(new URL(url).hostname);
    if (url.includes('brasilapi')) return new Response('limite', { status: 429 });
    if (url.includes('minhareceita')) return Response.json(brasilApi);
    if (url.includes('cnpj.ws')) throw new TypeError('fetch failed');
    return Response.json(receitaWs);
  };
  const r = await criarConsultaCnpj({ buscar, avisar: () => {} })('11222333000181');
  assert.equal(r.razaoSocial, 'EMPRESA EXEMPLO LTDA');
  assert.equal(r.fonte, 'Minha Receita');
  assert.equal(r.enquadramento.opSimpNac, '3', 'Simples vindo da ReceitaWS');
  assert.deepEqual(chamadas, ['brasilapi.com.br', 'minhareceita.org', 'publica.cnpj.ws', 'receitaws.com.br']);
  assert.equal(PROVEDORES.length, 4);

  // ReceitaWS sozinha: lê data dd/mm/aaaa e CEP com pontuação; "ERROR" de CNPJ inexistente vira 404.
  const so = criarConsultaCnpj({ buscar: async () => Response.json(receitaWs), provedores: [PROVEDORES[3]], avisar: () => {} });
  const d = await so('11222333000181');
  assert.equal(d.abertura, '2015-02-10');
  assert.equal(d.endereco.cep, '01001000');
  assert.equal(d.municipio.ibge, '3550308');
  const inexistente = criarConsultaCnpj({ buscar: async () => Response.json({ status: 'ERROR', message: 'CNPJ inválido' }), provedores: [PROVEDORES[3]], avisar: () => {} });
  await assert.rejects(inexistente('11222333000181'), (e) => e.statusCode === 404 || e.status === 404 || /não encontrado/.test(e.message));
  // Todos fora: mensagem diz o que fazer.
  const fora = criarConsultaCnpj({ buscar: async () => { throw new TypeError('fetch failed'); }, avisar: () => {} });
  await assert.rejects(fora('11222333000181'), /Buscar dados/);
});
