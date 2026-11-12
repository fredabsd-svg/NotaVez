// Sincronização com o ADN: além das notas tomadas, as notas que a empresa emitiu FORA do app
// (Emissor Nacional, outro sistema) entram em "Notas" com o XML oficial; cancelamentos feitos no
// portal aparecem; nada é duplicado; e o escritório busca todas as empresas de uma vez.
process.env.NODE_ENV = 'test';
process.env.NOTAVEZ_ESPERA_REENVIO_MS = '0';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gerarCertificadoTeste } from './apoio/certificado-teste.js';
import { iniciarSefinSimulada } from './apoio/sefin-simulada.js';

const { criarApp } = await import('../src/app.js');
const { criarClienteSefin } = await import('../src/fiscal/sefin/cliente.js');
const { ambientesSefin } = await import('../src/config.js');
const { hojeBrasilia } = await import('../src/fiscal/dps.js');

const EMPRESA = '11222333000181';
const OUTRA = '11444777000161';
const CLIENTE = '22333444000181';
const cert = gerarCertificadoTeste({ cnpj: EMPRESA, nome: 'EMPRESA TESTE' });
let sefin; let app;
before(async () => {
  sefin = await iniciarSefinSimulada({ caPem: cert.caPem, caChavePem: cert.caChavePem, certClientePem: cert.certPem });
  Object.assign(ambientesSefin.producao_restrita, { sefin: sefin.baseUrl, parametros: sefin.baseParametros, adn: sefin.baseAdn });
  // Sem espera entre buscas: os testes consultam a mesma empresa várias vezes seguidas.
  app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, pausaEntreEmpresasMs: 0, intervaloSincronizacaoMs: 0,
    fabricaCliente: (o) => criarClienteSefin({ ...o, ca: sefin.ca, timeoutMs: 1500 }) });
});
after(async () => { await app.close(); await sefin.fechar(); });

function sessao() {
  let cookie = '';
  return async (method, url, payload, headers = {}) => {
    const r = await app.inject({ method, url, payload, remoteAddress: '192.0.2.88', headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}), ...headers } });
    if (r.headers['set-cookie']) cookie = [r.headers['set-cookie']].flat().map((c) => c.split(';')[0]).join('; ');
    return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body };
  };
}
const pfx = (c) => ({ pfxBase64: c.pfx.toString('base64'), senha: c.senha, consentimento: true });
const mesPassado = () => { const d = new Date(`${hojeBrasilia().slice(0, 7)}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); };

// Cada teste começa com a fila do ADN vazia: todos usam o mesmo CNPJ (o do certificado aceito pela
// Receita simulada) e, sem isso, a empresa de um teste receberia as notas emitidas nos anteriores.
const filaVazia = () => { sefin.estado.distribuicao.length = 0; };

async function contaComEmpresa(email) {
  filaVazia();
  const api = sessao();
  await api('POST', '/api/conta/cadastrar', { email, senha: 'senha-segura-1' });
  const { empresaId } = (await api('POST', '/api/empresas', { documento: EMPRESA, nome: 'Empresa Teste', municipioIbge: '3550308', opSimpNac: '2' })).body;
  const h = { 'x-notavez-prestador': empresaId };
  assert.equal((await api('POST', '/api/certificado', pfx(cert), h)).status, 200);
  return { api, h, empresaId };
}

test('nota emitida fora do app entra em Notas pela sincronização, com XML oficial, DANFSe e auditoria', async () => {
  const { api, h, empresaId } = await contaComEmpresa('fora-do-app@exemplo.com');
  const competencia = mesPassado();
  sefin.adicionarTomada({ tomador: EMPRESA, nome: 'FORNECEDOR DA EMPRESA', valor: '90.00' });
  const fora = sefin.adicionarTomada({ prestador: EMPRESA, tomador: CLIENTE, valor: '750.00', competencia, cTribNac: '010101', descricao: 'Site institucional' });
  sefin.adicionarTomada({ prestador: OUTRA, tomador: CLIENTE, valor: '10.00' }); // nota em que a empresa não é parte: ignorada

  const s = await api('POST', '/api/notas/sincronizar', {}, h);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.novas, 1, 'uma nota tomada');
  assert.equal(s.body.emitidas, 1, 'uma nota emitida fora do app');
  assert.equal(s.body.ilegiveis, 0);

  const lista = (await api('GET', '/api/notas', undefined, h)).body;
  assert.equal(lista.notas.length, 1);
  assert.equal(lista.canceladas, 0);
  // Na lista, a nota fica na data em que a Receita a autorizou (e não no topo, como se fosse de agora).
  assert.equal(lista.notas[0].atualizadoEm, new Date(lista.notas[0].emitidaEm).toISOString());
  const n = lista.notas[0];
  assert.equal(n.situacao, 'emitida');
  assert.equal(n.rotulo, 'Emitida (fora do app)');
  assert.equal(n.canal, 'sincronizada');
  assert.equal(n.valor, '750.00');
  assert.equal(n.competencia, competencia);
  assert.equal(n.chaveAcesso, fora.chave);
  assert.equal(n.clienteNome, 'EMPRESA TOMADORA');
  assert.ok(lista.sincronizacao.sincronizadoEm, 'a lista informa quando a Receita foi consultada');
  assert.equal(lista.temCertificado, true);

  const detalhe = (await api('GET', `/api/notas/${n.id}`, undefined, h)).body.nota;
  assert.match(detalhe.aviso, /fora deste app/);
  assert.equal(detalhe.documentos.xml, true);
  const xml = await api('GET', `/api/notas/${n.id}/xml`, undefined, h);
  assert.equal(xml.status, 200);
  assert.equal(xml.body, fora.xml, 'guarda o XML exatamente como a Receita entregou');
  assert.equal((await app.inject({ url: `/api/notas/${n.id}/danfse`, headers: { cookie: '', ...h } })).statusCode, 401, 'DANFSe exige sessão');

  // Entra nos totais do painel e pode ser clonada como qualquer emitida.
  const inicio = (await api('GET', '/api/inicio', undefined, h)).body;
  assert.equal(inicio.emitidas, 1);
  assert.equal(inicio.painel.meses.find((m) => m.mes === competencia.slice(0, 7)).total, '750.00');
  assert.equal(inicio.podeClonar, true);
  const clone = await api('POST', `/api/notas/${n.id}/clonar`, {}, h);
  assert.equal(clone.status, 200, JSON.stringify(clone.body));
  assert.equal(clone.body.nota.situacao, 'rascunho');

  // Auditoria: a entrada automática fica registrada.
  const registros = app.ctx.db.all("SELECT acao, entidade_id FROM auditoria WHERE prestador_id = ? AND acao = 'nota.sincronizada'", empresaId);
  assert.deepEqual(registros.map((r) => r.entidade_id), [n.id]);

  // Buscar de novo não traz nada de novo nem duplica.
  const de_novo = await api('POST', '/api/tomadas/sincronizar', {}, h);
  assert.equal(de_novo.body.emitidas, 0);
  assert.equal(de_novo.body.novas, 0);
  assert.equal((await api('GET', '/api/notas?situacao=emitida', undefined, h)).body.notas.length, 1);
});

test('nota emitida pelo próprio app não é duplicada quando aparece na fila do ADN; pendente segue com a verificação', async () => {
  const { api, h } = await contaComEmpresa('do-app@exemplo.com');
  const criar = async () => {
    const nota = (await api('POST', '/api/notas', { rascunho: { tomador: { tipo: 'CPF', documento: '52998224725', nome: 'Maria' }, cTribNac: '010101', descricao: 'Site', valor: '200,00' } }, h)).body.nota;
    const v = await api('POST', `/api/notas/${nota.id}/validar`, { versao: nota.versao }, h);
    return api('POST', `/api/notas/${nota.id}/emitir`, { versao: v.body.versao, revisao: v.body.revisao }, h);
  };
  const emitida = (await criar()).body.nota;
  assert.equal(emitida.situacao, 'emitida');
  sefin.distribuirGerada(emitida.dps.id);
  // A segunda fica pendente: a Receita processou, mas a resposta se perdeu.
  sefin.estado.cenario.push('timeout_apos_processar');
  const pendente = (await criar()).body.nota;
  assert.equal(pendente.situacao, 'pendente');
  sefin.distribuirGerada(pendente.dps.id);

  const s = await api('POST', '/api/notas/sincronizar', {}, h);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.emitidas, 0, 'nada novo: as duas são do app');
  const notas = (await api('GET', '/api/notas', undefined, h)).body.notas;
  assert.equal(notas.length, 2, 'sem duplicatas');
  assert.equal(notas.find((n) => n.id === pendente.id).situacao, 'pendente', 'a pendente continua com a verificação própria');
  const verificada = await api('POST', `/api/notas/${pendente.id}/verificar`, {}, h);
  assert.equal(verificada.body.nota.situacao, 'emitida');
  assert.equal((await api('GET', '/api/notas', undefined, h)).body.notas.length, 2);
});

test('cancelamento feito no portal: a nota vira "Cancelada", sai dos totais e mantém o XML', async () => {
  const { api, h, empresaId } = await contaComEmpresa('cancelada@exemplo.com');
  const competencia = hojeBrasilia();
  const fora = sefin.adicionarTomada({ prestador: EMPRESA, tomador: CLIENTE, valor: '400.00', competencia });
  assert.equal((await api('POST', '/api/notas/sincronizar', {}, h)).body.emitidas, 1);
  assert.equal((await api('GET', '/api/inicio', undefined, h)).body.painel.ano.total, '400.00');

  sefin.cancelarTomada(fora.chave);
  const s = await api('POST', '/api/notas/sincronizar', {}, h);
  assert.equal(s.body.emitidasCanceladas, 1);
  assert.equal(s.body.canceladas, 0, 'não é uma nota tomada');
  const n = (await api('GET', '/api/notas', undefined, h)).body.notas[0];
  assert.equal(n.situacao, 'cancelada');
  assert.equal(n.rotulo, 'Cancelada');
  // O filtro "Canceladas" aparece e traz a nota; ela não entra em "Emitidas".
  const filtradas = (await api('GET', '/api/notas?situacao=cancelada', undefined, h)).body;
  assert.equal(filtradas.canceladas, 1);
  assert.deepEqual(filtradas.notas.map((x) => x.id), [n.id]);
  assert.equal((await api('GET', '/api/notas?situacao=emitida', undefined, h)).body.notas.length, 0);
  const inicio = (await api('GET', '/api/inicio', undefined, h)).body;
  assert.equal(inicio.painel.ano.total, '0.00', 'cancelada não soma');
  assert.equal(inicio.emitidas, 0);
  assert.equal(inicio.podeClonar, false, 'a cancelada não é "a última emitida"');
  assert.equal((await api('GET', `/api/notas/${n.id}/xml`, undefined, h)).status, 200, 'o XML continua disponível');
  assert.equal(app.ctx.db.all("SELECT 1 FROM auditoria WHERE prestador_id = ? AND acao = 'nota.cancelada_no_portal'", empresaId).length, 1);
  // Repetir o evento não muda nada.
  assert.equal((await api('POST', '/api/notas/sincronizar', {}, h)).body.emitidasCanceladas, 0);
});

test('fila já lida por versão anterior (só tomadas) é relida uma única vez para trazer as emitidas', async () => {
  const { api, h, empresaId } = await contaComEmpresa('releitura@exemplo.com');
  const fora = sefin.adicionarTomada({ prestador: EMPRESA, tomador: CLIENTE, valor: '120.00', competencia: mesPassado() });
  // Estado deixado pela versão anterior: fila toda lida, só as tomadas guardadas.
  const p = app.ctx.repo.prestador(empresaId);
  app.ctx.repo.gravarDistribuicao(p.id, p.ambiente, p.documento, fora.nsu);
  app.ctx.db.run('UPDATE distribuicao_dfe SET leitura = 1 WHERE prestador_id = ?', p.id);
  assert.equal(app.ctx.repo.distribuicao(p.id, p.ambiente, p.documento).leitura, 1);

  const antes = sefin.estado.consultasDistribuicao.length;
  const s = await api('POST', '/api/notas/sincronizar', {}, h);
  assert.equal(s.body.emitidas, 1, JSON.stringify(s.body));
  assert.equal(sefin.estado.consultasDistribuicao[antes].nsu, 0, 'recomeça do início');
  assert.equal(app.ctx.repo.distribuicao(p.id, p.ambiente, p.documento).leitura, 2);
  assert.ok(app.ctx.repo.distribuicao(p.id, p.ambiente, p.documento).ultimoNsu >= fora.nsu);
  // Na vez seguinte continua de onde parou.
  const depois = sefin.estado.consultasDistribuicao.length;
  await api('POST', '/api/notas/sincronizar', {}, h);
  assert.ok(sefin.estado.consultasDistribuicao[depois].nsu >= fora.nsu, 'não relê de novo');
});

test('Receita recusa a consulta: a mensagem dela aparece (com a dica da procuração) e nada é gravado', async () => {
  const { api, h, empresaId } = await contaComEmpresa('recusa@exemplo.com');
  const p = app.ctx.repo.prestador(empresaId);
  const servico = app.ctx.tomadas;
  const original = app.ctx.emissao.distribuirDfe;
  app.ctx.emissao.distribuirDfe = async () => ({ tipo: 'falha', http: 403, ms: 1, erros: [{ codigo: 'E403', descricao: 'Procuração eletrônica não localizada para o contribuinte.' }] });
  try {
    await assert.rejects(servico.sincronizar({ ...p, usaProcuracao: true }), (e) => e.status === 502 && /Procuração eletrônica não localizada/.test(e.message) && /procuração eletrônica NFS-e desta empresa/.test(e.message));
  } finally { app.ctx.emissao.distribuirDfe = original; }
  assert.equal((await api('GET', '/api/notas', undefined, h)).body.notas.length, 0);
});

test('escritório: procuração em lote, empresa que já nasce por procuração e busca de todas as empresas', async () => {
  filaVazia();
  const api = sessao();
  await api('POST', '/api/conta/cadastrar', { email: 'escritorio-lote@exemplo.com', senha: 'senha-segura-1' });
  const empresa = async (documento, nome, extra = {}) => (await api('POST', '/api/empresas', { documento, nome, municipioIbge: '3550308', opSimpNac: '2', ...extra })).body;

  // Sem certificado do escritório, nada de procuração.
  const semCertificado = await api('POST', '/api/empresas', { documento: EMPRESA, nome: 'A', municipioIbge: '3550308', opSimpNac: '2', usaProcuracao: true });
  assert.equal(semCertificado.status, 409);
  const a = (await empresa(EMPRESA, 'Cliente A')).empresaId;
  const b = (await empresa(OUTRA, 'Cliente B')).empresaId;
  assert.equal((await api('PUT', '/api/procurador/empresas', { empresas: [a, b], ativa: true })).status, 409, 'precisa do certificado do escritório');

  // O certificado aceito pela Receita simulada faz o papel do certificado do escritório.
  assert.equal((await api('POST', '/api/procurador/certificado', pfx(cert))).status, 200);
  const lote = await api('PUT', '/api/procurador/empresas', { empresas: [a, b, 'nao-existe'], ativa: true });
  assert.equal(lote.status, 200, JSON.stringify(lote.body));
  assert.equal(lote.body.alteradas, 2);
  assert.ok(lote.body.empresas.every((e) => e.porProcuracao && e.certificadoValidoAte && !e.certificadoProprio));
  assert.equal((await api('PUT', '/api/procurador/empresas', { empresas: [a], ativa: true })).body.alteradas, 0, 'já estava ligada');
  assert.equal((await api('PUT', '/api/procurador/empresas', { empresas: [], ativa: true })).status, 422);

  // Empresa nova já por procuração.
  const c = await api('POST', '/api/empresas', { documento: CLIENTE, nome: 'Cliente C', municipioIbge: '3550308', opSimpNac: '2', usaProcuracao: true });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.empresa.usaProcuracao, true);
  // Uma quarta, sem procuração e sem certificado, fica de fora da busca.
  await empresa('33444555000181', 'Cliente D');

  const inicio = sefin.estado.distribuicao.length;
  sefin.adicionarTomada({ tomador: EMPRESA, nome: 'FORNECEDOR DE A' });
  sefin.adicionarTomada({ prestador: OUTRA, tomador: EMPRESA, valor: '310.00', competencia: mesPassado() }); // emitida por B, tomada por A
  assert.ok(sefin.estado.distribuicao.length === inicio + 2);

  const comeco = await api('POST', '/api/empresas/sincronizar', {});
  assert.equal(comeco.status, 200, JSON.stringify(comeco.body));
  assert.equal(comeco.body.total, 3, 'A, B e C têm o certificado do escritório; D não');
  let situacao;
  for (let i = 0; i < 100; i++) {
    situacao = (await api('GET', '/api/empresas/sincronizacao')).body;
    if (!situacao.emAndamento) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(situacao.emAndamento, false);
  assert.equal(situacao.feitas, 3);
  assert.deepEqual(situacao.falhas, []);
  assert.ok(situacao.tomadas >= 2, `tomadas de A: ${situacao.tomadas}`);
  assert.ok(situacao.emitidas >= 1, `emitidas fora do app de B: ${situacao.emitidas}`);
  assert.ok(situacao.terminadaEm);
  // Cada empresa só recebeu o que é dela.
  const notasB = (await api('GET', '/api/notas', undefined, { 'x-notavez-prestador': b })).body.notas;
  assert.ok(notasB.some((n) => n.valor === '310.00' && n.canal === 'sincronizada'));
  assert.equal((await api('GET', '/api/notas', undefined, { 'x-notavez-prestador': c.body.empresaId })).body.notas.length, 0);
  const lista = (await api('GET', '/api/empresas')).body.empresas;
  assert.ok(lista.filter((e) => e.porProcuracao).every((e) => e.sincronizadoEm), 'a lista mostra quando cada empresa foi consultada');
  assert.equal(lista.find((e) => e.nome === 'Cliente D').sincronizadoEm, null);

  // Desligar em lote volta a exigir o certificado de cada empresa.
  assert.equal((await api('PUT', '/api/procurador/empresas', { empresas: [a, b], ativa: false })).body.alteradas, 2);
  assert.equal((await api('POST', '/api/empresas/sincronizar', {})).body.total, 1, 'só C continua por procuração');
  // Empresa que só tem cópias vindas da Receita (nada enviado pelo app) pode sair da conta; as notas continuam na Receita.
  assert.equal((await api('DELETE', `/api/empresas/${b}`)).status, 200);
  assert.equal(app.ctx.db.get('SELECT COUNT(*) n FROM notas WHERE prestador_id = ?', b).n, 0);
});

test('tarefa periódica: consulta todas as empresas com certificado válido e não para em falhas', async () => {
  const antes = sefin.estado.consultasDistribuicao.length;
  const r = await app.ctx.tomadas.sincronizarTodas();
  assert.ok(r.empresas >= 1);
  assert.ok(sefin.estado.consultasDistribuicao.length > antes);
  sefin.estado.falharDistribuicao = true;
  try { assert.equal((await app.ctx.tomadas.sincronizarTodas()).empresas, 0, 'falhas não derrubam a rodada'); } finally { sefin.estado.falharDistribuicao = false; }
});
