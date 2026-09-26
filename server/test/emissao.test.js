// Testes ponta a ponta: API do NotaVez + Sefin SIMULADA (TLS mútuo).
process.env.NODE_ENV = 'test';
process.env.NOTAVEZ_ESPERA_REENVIO_MS = '0';
process.env.NOTAVEZ_TIMEOUT_SEFIN_MS = '1500';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { gerarCertificadoTeste } from './apoio/certificado-teste.js';
import { iniciarSefinSimulada } from './apoio/sefin-simulada.js';

const { criarApp } = await import('../src/app.js');
const { criarClienteSefin } = await import('../src/fiscal/sefin/cliente.js');
const { ambientesSefin } = await import('../src/config.js');
const { montarConteudo, lerXmlNfse } = await import('../src/fiscal/danfse/index.js');

// Conta as páginas do PDF (os dicionários de página não ficam comprimidos).
const paginasPdf = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
// NOTAVEZ_SALVAR_DANFSE=<pasta> grava os PDFs gerados nos testes, para conferência visual.
const salvarPdf = (nome, buf) => { if (process.env.NOTAVEZ_SALVAR_DANFSE) writeFileSync(`${process.env.NOTAVEZ_SALVAR_DANFSE}/danfse-${nome}.pdf`, buf); };

const cert = gerarCertificadoTeste({ cnpj: '11222333000181' });
let sefin; let app;

before(async () => {
  sefin = await iniciarSefinSimulada({ caPem: cert.caPem, caChavePem: cert.caChavePem, certClientePem: cert.certPem });
  ambientesSefin.producao_restrita.sefin = sefin.baseUrl;
  ambientesSefin.producao_restrita.parametros = sefin.baseParametros;
  app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, fabricaCliente: (o) => criarClienteSefin({ ...o, ca: sefin.ca }) });
});
after(async () => { await app.close(); await sefin.fechar(); });

function sessao() {
  let cookie = '';
  const chamar = async (method, url, payload) => {
    const r = await app.inject({ method, url, payload, headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}) } });
    const sc = r.headers['set-cookie'];
    if (sc) cookie = (Array.isArray(sc) ? sc : [sc]).map((c) => c.split(';')[0]).join('; ');
    return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body, headers: r.headers, rawPayload: r.rawPayload };
  };
  return chamar;
}

async function usuarioPronto(email, { comCertificado = true, opSimpNac = '2', municipioIbge = '3550308', simples = {} } = {}) {
  const api = sessao();
  assert.equal((await api('POST', '/api/conta/cadastrar', { email, senha: 'senha-segura-1' })).status, 200);
  const p = await api('PUT', '/api/perfil', { documento: '11.222.333/0001-81', nome: 'Empresa Teste', municipioIbge, opSimpNac, ...simples });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  if (comCertificado) {
    const c = await api('POST', '/api/certificado', { pfxBase64: cert.pfx.toString('base64'), senha: cert.senha, consentimento: true });
    assert.equal(c.status, 200, JSON.stringify(c.body));
  }
  const cli = await api('POST', '/api/clientes', { documento: '529.982.247-25', nome: 'Maria da Silva', email: 'maria@exemplo.com' });
  assert.equal(cli.status, 200, JSON.stringify(cli.body));
  const serv = await api('POST', '/api/servicos', { apelido: 'Site', cTribNac: '010101', descricao: 'Criação e manutenção de site', valorPadrao: '350,00' });
  assert.equal(serv.status, 200, JSON.stringify(serv.body));
  return { api, clienteId: cli.body.cliente.id, servicoId: serv.body.servico.id };
}

async function novoRascunho(u, extra = {}) {
  const r = await u.api('POST', '/api/notas', { rascunho: { clienteId: u.clienteId, servicoId: u.servicoId, ...extra } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.nota;
}

test('sem certificado: só rascunho, com a lista do que falta', async () => {
  const u = await usuarioPronto('semcert@exemplo.com', { comCertificado: false });
  const perfil = await u.api('GET', '/api/perfil');
  assert.equal(perfil.body.elegibilidade.podeEmitir, false);
  assert.ok(perfil.body.elegibilidade.pendencias.some((p) => p.id === 'certificado'));
  const nota = await novoRascunho(u);
  assert.equal(nota.situacao, 'rascunho');
  const e = await u.api('POST', `/api/notas/${nota.id}/emitir`);
  assert.equal(e.status, 403);
  assert.ok(e.body.pendencias.length > 0);
  assert.equal(sefin.estado.recebidas.length, 0, 'nada foi enviado à Sefin');
});

test('Lucro Presumido/Real: perfil exige PIS/COFINS e percentuais aproximados', async () => {
  const api = sessao();
  await api('POST', '/api/conta/cadastrar', { email: 'presumido-perfil@exemplo.com', senha: 'senha-segura-1' });
  const r = await api('PUT', '/api/perfil', { documento: '11.222.333/0001-81', municipioIbge: '3550308', opSimpNac: '1' });
  assert.equal(r.status, 422);
  assert.ok(r.body.campos.cstPisCofins && r.body.campos.pTotTribFed && r.body.campos.pTotTribMun);
  const r2 = await api('PUT', '/api/perfil', { documento: '11.222.333/0001-81', municipioIbge: '3550308', opSimpNac: '1', cstPisCofins: '01', pTotTribFed: '13,45', pTotTribMun: '2' });
  assert.ok(r2.body.campos.aliqPis && r2.body.campos.aliqCofins, 'CST 01 exige alíquotas');
});

test('fluxo completo: emitir, baixar XML e clonar como novo rascunho', async () => {
  const u = await usuarioPronto('mei@exemplo.com');
  const nota = await novoRascunho(u);
  assert.equal(nota.valor, '350.00', 'valor padrão do serviço salvo');
  assert.equal(nota.rascunho.tomador.nome, 'Maria da Silva');

  const v = await u.api('POST', `/api/notas/${nota.id}/validar`);
  assert.equal(v.body.ok, true);
  assert.deepEqual(v.body.erros, []);
  assert.equal(v.body.exigencias.aliquota.modo, 'proibida', 'MEI nunca informa alíquota');

  const e = await u.api('POST', `/api/notas/${nota.id}/emitir`);
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.nota.situacao, 'emitida');
  assert.equal(e.body.nota.rotulo, 'Emitida');
  assert.match(e.body.nota.chaveAcesso, /^\d{50}$/);
  assert.ok(e.body.nota.documentos.xml);
  const idOriginal = e.body.nota.dps.id;

  const xml = await u.api('GET', `/api/notas/${nota.id}/xml`);
  assert.equal(xml.status, 200);
  assert.match(xml.body, /<NFSe/);

  // DANFSe (NT 008): PDF de uma página gerado a partir do XML oficial.
  assert.equal(e.body.nota.documentos.danfse, true);
  const pdf = await u.api('GET', `/api/notas/${nota.id}/danfse`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.match(pdf.headers['content-disposition'], /^inline; filename="DANFSe-\d{50}\.pdf"$/);
  assert.equal(paginasPdf(pdf.rawPayload), 1);
  salvarPdf('mei', pdf.rawPayload);
  const dan = montarConteudo(lerXmlNfse(xml.body));
  assert.equal(dan.cabecalho.homologacao, true, 'produção restrita: NFS-e SEM VALIDADE JURÍDICA');
  assert.equal(dan.dados.cStat, 'NFS-e MEI');
  assert.equal(dan.dados.tpEmit, 'Prestador');
  assert.equal(dan.prestador.simples, 'Optante - Microempreendedor Indivi...', 'NT 008: reticências acima de 37 caracteres');
  assert.equal(dan.prestador.nome, 'EMPRESA SIMULADA MEI', 'dados do emitente vêm de infNFSe/emit');
  assert.equal(dan.destinatarioAviso, 'DESTINATÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e', 'MEI sem grupo IBS/CBS');
  assert.equal(dan.intermediario, null);
  assert.equal(dan.ibscbs.bc, '-', 'campos sem informação no XML: traço');

  // Nota emitida não pode ser alterada nem reenviada.
  assert.equal((await u.api('PUT', `/api/notas/${nota.id}`, { rascunho: { valor: '1' } })).status, 409);
  assert.equal((await u.api('POST', `/api/notas/${nota.id}/emitir`)).status, 409);

  const inicio = await u.api('GET', '/api/inicio');
  assert.equal(inicio.body.ultima.situacao, 'emitida');
  assert.equal(inicio.body.podeClonar, true);

  // Clonar: novos identificadores, nada da situação original, revisão obrigatória.
  const c = await u.api('POST', '/api/notas/clonar-ultima');
  const clone = c.body.nota;
  assert.notEqual(clone.id, nota.id);
  assert.equal(clone.situacao, 'rascunho');
  assert.equal(clone.chaveAcesso, null);
  assert.equal(clone.nNfse, null);
  assert.equal(clone.dps, null);
  assert.equal(clone.origemId, nota.id);
  assert.deepEqual(clone.rascunho.revisar, ['competencia', 'valor', 'descricao', 'tributacao']);
  assert.equal(clone.rascunho.clienteId, u.clienteId);

  const semRevisar = await u.api('POST', `/api/notas/${clone.id}/emitir`);
  assert.equal(semRevisar.status, 422, 'exige revisar competência, valor, descrição e tributação');

  const revisado = await u.api('PUT', `/api/notas/${clone.id}`, { rascunho: { ...clone.rascunho, valor: '400,00', revisar: [] }, versao: clone.versao });
  assert.equal(revisado.status, 200, JSON.stringify(revisado.body));
  const e2 = await u.api('POST', `/api/notas/${clone.id}/emitir`);
  assert.equal(e2.body.nota.situacao, 'emitida');
  assert.notEqual(e2.body.nota.dps.id, idOriginal, 'novo número de DPS');
  assert.notEqual(e2.body.nota.chaveAcesso, e.body.nota.chaveAcesso);
});

test('rejeição oficial: explica o motivo e permite corrigir sem reutilizar número', async () => {
  const u = await usuarioPronto('rejeita@exemplo.com');
  const nota = await novoRascunho(u);
  sefin.estado.cenario.push('rejeitar');
  const e = await u.api('POST', `/api/notas/${nota.id}/emitir`);
  assert.equal(e.body.nota.situacao, 'rejeitada');
  assert.equal(e.body.nota.chaveAcesso, null);
  assert.equal(e.body.nota.erros[0].codigo, 'E0082');
  assert.match(e.body.nota.erros[0].mensagem, /CNPJ/);
  assert.ok(e.body.nota.erros[0].proximoPasso);
  const ultimoId = sefin.estado.recebidas.at(-1).match(/Id="(DPS\d+)"/)[1];

  const e2 = await u.api('POST', `/api/notas/${nota.id}/emitir`);
  assert.equal(e2.body.nota.situacao, 'emitida');
  assert.notEqual(e2.body.nota.dps.id, ultimoId);
});

test('resposta perdida após processar: pendente → consulta → emitida (sem reenviar)', async () => {
  const u = await usuarioPronto('timeout1@exemplo.com');
  const nota = await novoRascunho(u);
  sefin.estado.cenario.push('timeout_apos_processar');
  const antes = sefin.estado.recebidas.length;
  const e = await u.api('POST', `/api/notas/${nota.id}/emitir`);
  assert.equal(e.body.nota.situacao, 'pendente');
  assert.equal(e.body.nota.rotulo, 'Pendente de confirmação');
  assert.equal(e.body.nota.chaveAcesso, null);
  assert.equal((await u.api('POST', `/api/notas/${nota.id}/emitir`)).status, 409, 'não permite emitir de novo');

  const v = await u.api('POST', `/api/notas/${nota.id}/verificar`);
  assert.equal(v.body.nota.situacao, 'emitida');
  assert.match(v.body.nota.chaveAcesso, /^\d{50}$/);
  assert.equal(sefin.estado.recebidas.length, antes + 1, 'um único envio');
  assert.deepEqual(v.body.nota.historicoEnvio.map((h) => h.operacao), ['envio', 'consulta_dps', 'consulta_nfse']);
});

test('sem resposta e não processada: consulta, não encontra e reenvia a MESMA DPS', async () => {
  const u = await usuarioPronto('timeout2@exemplo.com');
  const nota = await novoRascunho(u);
  sefin.estado.cenario.push('timeout_sem_processar');
  const antes = sefin.estado.recebidas.length;
  const e = await u.api('POST', `/api/notas/${nota.id}/emitir`);
  assert.equal(e.body.nota.situacao, 'pendente');
  const v = await u.api('POST', `/api/notas/${nota.id}/verificar`);
  assert.equal(v.body.nota.situacao, 'emitida');
  const [primeiro, segundo] = sefin.estado.recebidas.slice(antes);
  assert.equal(primeiro, segundo, 'reenvio idêntico (mesmo Id, mesma assinatura)');
  assert.deepEqual(v.body.nota.historicoEnvio.map((h) => h.operacao), ['envio', 'consulta_dps', 'reenvio']);
});

test('erro 500 da Sefin vira pendente; duplicidade (E0014) é resolvida por consulta', async () => {
  const u = await usuarioPronto('erro500@exemplo.com');
  const nota = await novoRascunho(u);
  sefin.estado.cenario.push('erro500');
  const e = await u.api('POST', `/api/notas/${nota.id}/emitir`);
  assert.equal(e.body.nota.situacao, 'pendente');
  const v = await u.api('POST', `/api/notas/${nota.id}/verificar`);
  assert.equal(v.body.nota.situacao, 'emitida');
});

test('rascunho criado offline sincroniza com o mesmo id', async () => {
  const u = await usuarioPronto('offline@exemplo.com', { comCertificado: false });
  const id = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f';
  const r1 = await u.api('POST', '/api/notas', { id, rascunho: { clienteId: u.clienteId, valor: '10,00' } });
  const r2 = await u.api('POST', '/api/notas', { id, rascunho: { clienteId: u.clienteId, valor: '10,00' } });
  assert.equal(r1.body.nota.id, id);
  assert.equal(r2.body.nota.id, id, 'idempotente');
  assert.equal((await u.api('GET', '/api/notas')).body.notas.length, 1);
});

test('segurança: login, CSRF, isolamento entre contas e dados cifrados em repouso', async () => {
  const anon = sessao();
  assert.equal((await anon('GET', '/api/notas')).status, 401);
  const u = await usuarioPronto('seguro@exemplo.com', { comCertificado: false });
  const r = await app.inject({ method: 'POST', url: '/api/clientes', payload: { documento: '11444777000161', nome: 'X' } });
  assert.equal(r.statusCode, 403, 'sem cabeçalho anti-CSRF');

  const outro = await usuarioPronto('outro@exemplo.com', { comCertificado: false });
  const nota = await novoRascunho(u);
  assert.equal((await outro.api('GET', `/api/notas/${nota.id}`)).status, 404);
  assert.equal((await outro.api('GET', `/api/clientes/${u.clienteId}`)).status, 404);

  const { db } = app.ctx;
  const linhas = JSON.stringify([...db.all('SELECT * FROM clientes'), ...db.all('SELECT * FROM prestadores'), ...db.all('SELECT * FROM notas'), ...db.all('SELECT * FROM auditoria')]);
  assert.ok(!linhas.includes('52998224725'), 'CPF do cliente não aparece em claro');
  assert.ok(!linhas.includes('Maria da Silva'), 'nome do cliente não aparece em claro');
  assert.ok(!linhas.includes('11222333000181'), 'CNPJ não aparece em claro');
  const certRow = JSON.stringify(db.all('SELECT * FROM certificados'));
  assert.ok(!certRow.includes(cert.senha + '"'), 'senha do certificado não aparece em claro');

  const tentativas = [];
  for (let i = 0; i < 6; i++) tentativas.push((await anon('POST', '/api/conta/entrar', { email: 'seguro@exemplo.com', senha: 'errada' })).status);
  assert.equal(tentativas.at(-1), 429, 'limite de tentativas de login');
});

test('certificado de outro CNPJ é recusado', async () => {
  const api = sessao();
  await api('POST', '/api/conta/cadastrar', { email: 'outrocnpj@exemplo.com', senha: 'senha-segura-1' });
  await api('PUT', '/api/perfil', { documento: '11.444.777/0001-61', municipioIbge: '3550308', opSimpNac: '2' });
  const c = await api('POST', '/api/certificado', { pfxBase64: cert.pfx.toString('base64'), senha: cert.senha, consentimento: true });
  assert.equal(c.status, 422);
  assert.match(c.body.problemas.join(), /diferente/);
});

// ---------------- ME/EPP ----------------
const SIMPLES = { regApTribSN: '1', pTotTribSN: '6,00', aliqIssSN: '2,00' };

async function clienteEmpresa(u) {
  const r = await u.api('POST', '/api/clientes', {
    documento: '11.444.777/0001-61', nome: 'Cliente Empresa Ltda',
    endereco: { cep: '01001000', municipioIbge: '3550308', logradouro: 'Praça da Sé', numero: '100', bairro: 'Sé' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.cliente.id;
}

test('ME/EPP: perfil exige regime de apuração e percentual do Simples', async () => {
  const api = sessao();
  await api('POST', '/api/conta/cadastrar', { email: 'me-perfil@exemplo.com', senha: 'senha-segura-1' });
  const r = await api('PUT', '/api/perfil', { documento: '11.222.333/0001-81', municipioIbge: '3550308', opSimpNac: '3' });
  assert.equal(r.status, 422);
  assert.ok(r.body.campos.regApTribSN && r.body.campos.pTotTribSN);
  const r2 = await api('PUT', '/api/perfil', { documento: '11.222.333/0001-81', municipioIbge: '3550308', opSimpNac: '3', ...SIMPLES, aliqIssSN: '7' });
  assert.ok(r2.body.campos.aliqIssSN, 'alíquota de retenção fora de 1,8%–5%');
});

test('ME/EPP pelo Simples: emite sem retenção e com ISS retido pelo cliente', async () => {
  const u = await usuarioPronto('me-sn@exemplo.com', { opSimpNac: '3', simples: SIMPLES });
  const perfil = await u.api('GET', '/api/perfil');
  assert.equal(perfil.body.elegibilidade.podeEmitir, true, JSON.stringify(perfil.body.elegibilidade.pendencias));
  assert.ok(perfil.body.elegibilidade.itens.find((i) => i.id === 'convenio').ok);

  const n1 = await novoRascunho(u);
  const v = await u.api('POST', `/api/notas/${n1.id}/validar`);
  assert.equal(v.body.exigencias.aliquota.modo, 'proibida');
  const e1 = await u.api('POST', `/api/notas/${n1.id}/emitir`);
  assert.equal(e1.body.nota.situacao, 'emitida', JSON.stringify(e1.body));
  const xml1 = sefin.estado.recebidas.at(-1);
  assert.match(xml1, /<regApTribSN>1<\/regApTribSN>/);
  assert.match(xml1, /<pTotTribSN>6.00<\/pTotTribSN>/);
  assert.ok(!/<pAliq>/.test(xml1));

  const clienteId = await clienteEmpresa(u);
  const n2 = (await u.api('POST', '/api/notas', { rascunho: { clienteId, servicoId: u.servicoId, issRetido: true } })).body.nota;
  const v2 = await u.api('POST', `/api/notas/${n2.id}/validar`);
  assert.equal(v2.body.exigencias.aliquota.modo, 'obrigatoria');
  const e2 = await u.api('POST', `/api/notas/${n2.id}/emitir`);
  assert.equal(e2.body.nota?.situacao, 'emitida', JSON.stringify(e2.body));
  assert.match(sefin.estado.recebidas.at(-1), /<tpRetISSQN>2<\/tpRetISSQN><pAliq>2.00<\/pAliq>/);

  // Retenção com cliente pessoa física: barrada antes do envio.
  const n3 = (await u.api('POST', '/api/notas', { rascunho: { clienteId: u.clienteId, servicoId: u.servicoId, issRetido: true } })).body.nota;
  const e3 = await u.api('POST', `/api/notas/${n3.id}/emitir`);
  assert.equal(e3.status, 422);
  assert.ok(e3.body.erros.some((x) => x.regra === 'E0667'));
});

test('ME/EPP em município sem convênio: só rascunho, com o motivo (E0037)', async () => {
  const antes = sefin.estado.recebidas.length;
  const u = await usuarioPronto('me-sem-convenio@exemplo.com', { opSimpNac: '3', simples: SIMPLES, municipioIbge: '3304557' });
  const perfil = await u.api('GET', '/api/perfil');
  const conv = perfil.body.elegibilidade.itens.find((i) => i.id === 'convenio');
  assert.equal(conv.ok, false);
  assert.match(conv.comoResolver, /prefeitura/);
  const consultas = sefin.estado.consultasParametros;
  await u.api('GET', '/api/perfil');
  assert.equal(sefin.estado.consultasParametros, consultas, 'convênio em cache');
  const n = await novoRascunho(u);
  const e = await u.api('POST', `/api/notas/${n.id}/emitir`);
  assert.equal(e.status, 403);
  assert.ok(e.body.pendencias.some((p) => p.id === 'convenio'));
  assert.equal(sefin.estado.recebidas.length, antes, 'nada enviado');
});

test('ME/EPP com ISS fora do Simples: alíquota só quando o município de incidência não é conveniado', async () => {
  const u = await usuarioPronto('me-fora@exemplo.com', { opSimpNac: '3', simples: { ...SIMPLES, regApTribSN: '2' } });
  // Serviço com incidência no local da prestação (070901), prestado no Rio (não conveniado no simulador).
  const base = { clienteId: u.clienteId, cTribNac: '070901', descricao: 'Coleta de resíduos', valor: '500,00', localPrestacaoIbge: '3304557' };
  const n = (await u.api('POST', '/api/notas', { rascunho: base })).body.nota;
  const v = await u.api('POST', `/api/notas/${n.id}/validar`);
  assert.equal(v.body.exigencias.aliquota.modo, 'obrigatoria');
  assert.equal((await u.api('POST', `/api/notas/${n.id}/emitir`)).status, 422, 'sem alíquota → E0640 antes do envio');
  await u.api('PUT', `/api/notas/${n.id}`, { rascunho: { ...n.rascunho, pAliq: '3,00' } });
  const e = await u.api('POST', `/api/notas/${n.id}/emitir`);
  assert.equal(e.body.nota?.situacao, 'emitida', JSON.stringify(e.body));
  assert.match(sefin.estado.recebidas.at(-1), /<pAliq>3.00<\/pAliq>/);

  // Mesmo serviço prestado em São Paulo (conveniado): alíquota não vai na nota (E0635).
  const n2 = (await u.api('POST', '/api/notas', { rascunho: { ...base, localPrestacaoIbge: '3550308', pAliq: '3,00' } })).body.nota;
  const e2 = await u.api('POST', `/api/notas/${n2.id}/emitir`);
  assert.equal(e2.body.nota?.situacao, 'emitida', JSON.stringify(e2.body));
  assert.ok(!/<pAliq>/.test(sefin.estado.recebidas.at(-1)));
});

// ---------------- Lucro Presumido / Real (não optante) ----------------
const PRESUMIDO = { apuracao: 'presumido', cstPisCofins: '01', aliqPis: '0,65', aliqCofins: '3,00', pTotTribFed: '13,45', pTotTribMun: '2,00', aliqIss: '5,00' };

test('Lucro Presumido: emite com PIS/COFINS, retenções federais e grupo IBS/CBS', async () => {
  const u = await usuarioPronto('presumido@exemplo.com', { opSimpNac: '1', simples: PRESUMIDO });
  const perfil = await u.api('GET', '/api/perfil');
  assert.equal(perfil.body.elegibilidade.podeEmitir, true, JSON.stringify(perfil.body.elegibilidade.pendencias));
  const clienteId = await clienteEmpresa(u);
  // Serviço 17.01 (consultoria): 23 NBS possíveis → o usuário precisa escolher (E0322).
  const base = { clienteId, cTribNac: '170101', descricao: 'Consultoria em gestão', valor: '10.000,00', issRetido: true,
    retencoesFederais: { pis: true, cofins: true, csll: true, valorContribuicoes: '465,00', irrf: '150,00' } };
  const n = (await u.api('POST', '/api/notas', { rascunho: base })).body.nota;
  const v = await u.api('POST', `/api/notas/${n.id}/validar`);
  assert.ok(v.body.erros.some((x) => x.regra === 'E0322'), 'NBS obrigatória');
  assert.equal(v.body.exigencias.ibscbs.opcoes.length, 23);
  assert.equal((await u.api('POST', `/api/notas/${n.id}/emitir`)).status, 422);

  await u.api('PUT', `/api/notas/${n.id}`, { rascunho: { ...n.rascunho, cNBS: '110014000' } });
  const v2 = await u.api('POST', `/api/notas/${n.id}/validar`);
  assert.deepEqual(v2.body.erros, []);
  assert.equal(v2.body.exigencias.aliquota.modo, 'proibida', 'São Paulo conveniado: E0617');
  const e = await u.api('POST', `/api/notas/${n.id}/emitir`);
  assert.equal(e.body.nota?.situacao, 'emitida', JSON.stringify(e.body));
  const xml = sefin.estado.recebidas.at(-1);
  assert.match(xml, /<opSimpNac>1<\/opSimpNac><regEspTrib>0<\/regEspTrib>/);
  assert.match(xml, /<tpRetISSQN>2<\/tpRetISSQN><\/tribMun>/, 'ISS retido, sem alíquota (convênio ativo)');
  assert.match(xml, /<piscofins><CST>01<\/CST><vBCPisCofins>10000.00<\/vBCPisCofins><pAliqPis>0.65<\/pAliqPis><pAliqCofins>3.00<\/pAliqCofins><vPis>65.00<\/vPis><vCofins>300.00<\/vCofins><tpRetPisCofins>3<\/tpRetPisCofins><\/piscofins>/);
  assert.match(xml, /<vRetIRRF>150.00<\/vRetIRRF><vRetCSLL>465.00<\/vRetCSLL>/, 'NT 007: PIS+COFINS+CSLL retidos somados em vRetCSLL');
  assert.match(xml, /<pTotTrib><pTotTribFed>13.45<\/pTotTribFed><pTotTribEst>0.00<\/pTotTribEst><pTotTribMun>2.00<\/pTotTribMun><\/pTotTrib>/);
  assert.match(xml, /<cNBS>110014000<\/cNBS>/);

  // DANFSe do Lucro Presumido: tributação federal, IBS/CBS e totais.
  const nfse = await u.api('GET', `/api/notas/${n.id}/xml`);
  const c = montarConteudo(lerXmlNfse(nfse.body));
  assert.equal(c.dados.cStat, 'NFS-e Gerada');
  assert.equal(c.dados.finNFSe, 'NFS-e regular');
  assert.equal(c.prestador.simples, 'Não Optante');
  assert.match(c.tomador.doc, /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/);
  assert.equal(c.destinatarioAviso, 'O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO', 'indDest = 0');
  assert.equal(c.servico.codigo, '17.01.01');
  assert.equal(c.servico.nbs, '1.1001.40.00');
  assert.equal(c.issqn.retencao, 'Retido pelo Tomador');
  assert.equal(c.federal.irrf, 'R$ 150,00');
  assert.equal(c.federal.contribuicoes, 'R$ 465,00', 'tpRetPisCofins 3: vRetCSLL');
  assert.equal(c.federal.pis, 'R$ 65,00');
  assert.equal(c.federal.descricao, 'PIS/COFINS/CSLL Retidos');
  assert.equal(c.ibscbs.cst, '000 / 000001');
  assert.match(c.ibscbs.operacao, /^100301 \/ 3550308 \/ São Paulo \/ SP$/);
  assert.equal(c.totais.vServ, 'R$ 10.000,00');
  assert.match(c.informacoes.totais, /Lei nº 12\.741\/2012: Federais: 13,45% ; Estaduais: 0,00% ; Municipais: 2,00%$/);
  const pdf = await u.api('GET', `/api/notas/${n.id}/danfse?baixar=1`);
  assert.match(pdf.headers['content-disposition'], /^attachment;/);
  assert.equal(paginasPdf(pdf.rawPayload), 1);
  salvarPdf('presumido', pdf.rawPayload);
  assert.match(xml, /<IBSCBS><finNFSe>0<\/finNFSe><indFinal>0<\/indFinal><cIndOp>100301<\/cIndOp><indDest>0<\/indDest><valores><trib><gIBSCBS><CST>000<\/CST><cClassTrib>000001<\/cClassTrib><\/gIBSCBS><\/trib><\/valores><\/IBSCBS>/);
});

test('Lucro Real em município de incidência não conveniado: alíquota obrigatória (E0619) vinda do perfil', async () => {
  const u = await usuarioPronto('real@exemplo.com', { opSimpNac: '1', simples: { ...PRESUMIDO, apuracao: 'real', aliqPis: '1,65', aliqCofins: '7,60', aliqIss: '3,00' } });
  // 07.09.01 (coleta de resíduos) tem incidência no local da prestação: Rio (não conveniado no simulador).
  const n = (await u.api('POST', '/api/notas', { rascunho: { clienteId: u.clienteId, cTribNac: '070901', cNBS: '124033200', cIndOp: '050101', descricao: 'Coleta', valor: '1.000,00', localPrestacaoIbge: '3304557' } })).body.nota;
  const v = await u.api('POST', `/api/notas/${n.id}/validar`);
  assert.equal(v.body.exigencias.aliquota.modo, 'obrigatoria');
  const e = await u.api('POST', `/api/notas/${n.id}/emitir`);
  assert.equal(e.body.nota?.situacao, 'emitida', JSON.stringify(e.body));
  const xml = sefin.estado.recebidas.at(-1);
  assert.match(xml, /<pAliq>3.00<\/pAliq>/);
  assert.match(xml, /<vPis>16.50<\/vPis><vCofins>76.00<\/vCofins><tpRetPisCofins>0<\/tpRetPisCofins>/);
  assert.ok(!/<vRetCSLL>/.test(xml), 'sem retenção → sem vRetCSLL (E0720)');
  assert.match(xml, /<indFinal>1<\/indFinal>/, 'cliente pessoa física: uso ou consumo pessoal');
});

test('Lucro Presumido: retenções federais só com cliente CNPJ e valores coerentes (E0724, E0720)', async () => {
  const u = await usuarioPronto('presumido-ret@exemplo.com', { opSimpNac: '1', simples: PRESUMIDO });
  const base = { clienteId: u.clienteId, cTribNac: '010101', cNBS: '115021000', descricao: 'Sistema', valor: '1.000,00' };
  const casos = [
    [{ retencoesFederais: { irrf: '15,00' } }, 'Regra'],
    [{ retencoesFederais: { pis: true } }, 'E0724'],
  ];
  for (const [extra, regra] of casos) {
    const n = (await u.api('POST', '/api/notas', { rascunho: { ...base, ...extra } })).body.nota;
    const v = await u.api('POST', `/api/notas/${n.id}/validar`);
    assert.ok(v.body.erros.some((x) => x.regra === regra), `${regra}: ${JSON.stringify(v.body.erros)}`);
  }
});
