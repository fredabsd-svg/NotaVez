// Testes ponta a ponta: API do NotaVez + Sefin SIMULADA (TLS mútuo).
process.env.NODE_ENV = 'test';
process.env.NOTAVEZ_ESPERA_REENVIO_MS = '0';
process.env.NOTAVEZ_TIMEOUT_SEFIN_MS = '1500';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gerarCertificadoTeste } from './apoio/certificado-teste.js';
import { iniciarSefinSimulada } from './apoio/sefin-simulada.js';

const { criarApp } = await import('../src/app.js');
const { criarClienteSefin } = await import('../src/fiscal/sefin/cliente.js');
const { ambientesSefin } = await import('../src/config.js');

const cert = gerarCertificadoTeste({ cnpj: '11222333000181' });
let sefin; let app;

before(async () => {
  sefin = await iniciarSefinSimulada({ caPem: cert.caPem, caChavePem: cert.caChavePem, certClientePem: cert.certPem });
  ambientesSefin.producao_restrita.sefin = sefin.baseUrl;
  app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, fabricaCliente: (o) => criarClienteSefin({ ...o, ca: sefin.ca }) });
});
after(async () => { await app.close(); await sefin.fechar(); });

function sessao() {
  let cookie = '';
  const chamar = async (method, url, payload) => {
    const r = await app.inject({ method, url, payload, headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}) } });
    const sc = r.headers['set-cookie'];
    if (sc) cookie = (Array.isArray(sc) ? sc : [sc]).map((c) => c.split(';')[0]).join('; ');
    return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body, headers: r.headers };
  };
  return chamar;
}

async function usuarioPronto(email, { comCertificado = true, opSimpNac = '2' } = {}) {
  const api = sessao();
  assert.equal((await api('POST', '/api/conta/cadastrar', { email, senha: 'senha-segura-1' })).status, 200);
  const p = await api('PUT', '/api/perfil', { documento: '11.222.333/0001-81', nome: 'MEI Teste', municipioIbge: '3550308', opSimpNac });
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

test('não-MEI: emissão direta bloqueada, rascunho permitido', async () => {
  const u = await usuarioPronto('me@exemplo.com', { opSimpNac: '3' });
  const nota = await novoRascunho(u);
  const e = await u.api('POST', `/api/notas/${nota.id}/emitir`);
  assert.equal(e.status, 403);
  assert.ok(e.body.pendencias.some((p) => p.id === 'mei'));
});

test('fluxo completo: emitir, baixar XML e clonar como novo rascunho', async () => {
  const u = await usuarioPronto('mei@exemplo.com');
  const nota = await novoRascunho(u);
  assert.equal(nota.valor, '350.00', 'valor padrão do serviço salvo');
  assert.equal(nota.rascunho.tomador.nome, 'Maria da Silva');

  const v = await u.api('POST', `/api/notas/${nota.id}/validar`);
  assert.deepEqual(v.body, { ok: true, erros: [] });

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
