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
  const registros = await app.ctx.db.all("SELECT acao, entidade_id FROM auditoria WHERE prestador_id = ? AND acao = 'nota.sincronizada'", empresaId);
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

test('numeração de DPS já usada por outro sistema da empresa: a nota do app não vira emitida com a nota dele', async () => {
  const { api, h } = await contaComEmpresa('outro-sistema@exemplo.com');
  const rascunho = async () => (await api('POST', '/api/notas', { rascunho: { tomador: { tipo: 'CPF', documento: '52998224725', nome: 'Maria' }, cTribNac: '010101', descricao: 'Site', valor: '200,00' } }, h)).body.nota;
  const emitir = async (id) => {
    const n = (await api('GET', `/api/notas/${id}`, undefined, h)).body.nota;
    const v = await api('POST', `/api/notas/${id}/validar`, { versao: n.versao }, h);
    return (await api('POST', `/api/notas/${id}/emitir`, { versao: v.body.versao, revisao: v.body.revisao }, h)).body.nota;
  };
  const primeira = await emitir((await rascunho()).id);
  assert.equal(primeira.situacao, 'emitida');
  // O ERP da empresa já emitiu, na mesma série, a nota com o próximo número que o app vai usar.
  const dele = sefin.adicionarTomada({ prestador: EMPRESA, tomador: CLIENTE, valor: '999.00', serie: primeira.dps.serie, numero: Number(primeira.dps.numero) + 1 });

  const segunda = await rascunho();
  const resultado = await emitir(segunda.id);
  assert.equal(resultado.situacao, 'rejeitada', 'a Receita recusou por duplicidade e a nota encontrada não é a do app');
  assert.equal(resultado.chaveAcesso, null);
  assert.notEqual(resultado.chaveAcesso, dele.chave);
  assert.equal(resultado.erros[0].codigo, 'DPS_DE_OUTRO_SISTEMA');
  assert.equal((await api('GET', '/api/inicio', undefined, h)).body.emitidas, 1, 'só a primeira conta como emitida');
  assert.equal((await api('GET', `/api/notas/${segunda.id}/xml`, undefined, h)).status, 404);

  // A nota do outro sistema entra pelo lugar certo: emitida fora do app, na sincronização.
  const s = await api('POST', '/api/notas/sincronizar', {}, h);
  assert.equal(s.body.emitidas, 1);
  const notas = (await api('GET', '/api/notas', undefined, h)).body.notas;
  assert.ok(notas.some((n) => n.canal === 'sincronizada' && n.valor === '999.00' && n.chaveAcesso === dele.chave));

  // Enviada de novo, a nota do app sai com o número seguinte e é emitida de verdade.
  const reenviada = await emitir(segunda.id);
  assert.equal(reenviada.situacao, 'emitida');
  assert.equal(Number(reenviada.dps.numero), Number(primeira.dps.numero) + 2);
  assert.notEqual(reenviada.chaveAcesso, dele.chave);
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
  assert.equal((await app.ctx.db.all("SELECT 1 FROM auditoria WHERE prestador_id = ? AND acao = 'nota.cancelada_no_portal'", empresaId)).length, 1);
  // Repetir o evento não muda nada.
  assert.equal((await api('POST', '/api/notas/sincronizar', {}, h)).body.emitidasCanceladas, 0);
});

test('fila já lida por versão anterior (só tomadas) é relida uma única vez para trazer as emitidas', async () => {
  const { api, h, empresaId } = await contaComEmpresa('releitura@exemplo.com');
  const fora = sefin.adicionarTomada({ prestador: EMPRESA, tomador: CLIENTE, valor: '120.00', competencia: mesPassado() });
  // Estado deixado pela versão anterior: fila toda lida, só as tomadas guardadas.
  const p = await app.ctx.repo.prestador(empresaId);
  await app.ctx.repo.gravarDistribuicao(p.id, p.ambiente, p.documento, fora.nsu);
  await app.ctx.db.run('UPDATE distribuicao_dfe SET leitura = 1 WHERE prestador_id = ?', p.id);
  assert.equal((await app.ctx.repo.distribuicao(p.id, p.ambiente, p.documento)).leitura, 1);

  const antes = sefin.estado.consultasDistribuicao.length;
  const s = await api('POST', '/api/notas/sincronizar', {}, h);
  assert.equal(s.body.emitidas, 1, JSON.stringify(s.body));
  assert.equal(sefin.estado.consultasDistribuicao[antes].nsu, 0, 'recomeça do início');
  assert.equal((await app.ctx.repo.distribuicao(p.id, p.ambiente, p.documento)).leitura, 2);
  assert.ok((await app.ctx.repo.distribuicao(p.id, p.ambiente, p.documento)).ultimoNsu >= fora.nsu);
  // Na vez seguinte continua de onde parou.
  const depois = sefin.estado.consultasDistribuicao.length;
  await api('POST', '/api/notas/sincronizar', {}, h);
  assert.ok(sefin.estado.consultasDistribuicao[depois].nsu >= fora.nsu, 'não relê de novo');
});

test('Receita recusa a consulta: a mensagem dela aparece (com a dica da procuração) e nada é gravado', async () => {
  const { api, h, empresaId } = await contaComEmpresa('recusa@exemplo.com');
  const p = await app.ctx.repo.prestador(empresaId);
  const servico = app.ctx.tomadas;
  const original = app.ctx.emissao.distribuirDfe;
  app.ctx.emissao.distribuirDfe = async () => ({ tipo: 'falha', http: 403, ms: 1, erros: [{ codigo: 'E403', descricao: 'Procuração eletrônica não localizada para o contribuinte.' }] });
  try {
    await assert.rejects(servico.sincronizar({ ...p, usaProcuracao: true }), (e) => e.status === 502 && /Procuração eletrônica não localizada/.test(e.message) && /procuração eletrônica NFS-e desta empresa/.test(e.message));
  } finally { app.ctx.emissao.distribuirDfe = original; }
  const lista = (await api('GET', '/api/notas', undefined, h)).body;
  assert.equal(lista.notas.length, 0);
  // A recusa fica guardada (motivo cifrado) e aparece nas telas até uma consulta dar certo.
  assert.ok(lista.sincronizacao.recusadaEm);
  assert.match(lista.sincronizacao.recusaMotivo, /Procuração eletrônica não localizada/);
  const linha = await app.ctx.db.get('SELECT falha_cifrada f FROM distribuicao_dfe WHERE prestador_id = ?', empresaId);
  assert.ok(linha.f && !/Procura/.test(linha.f), 'o motivo dado pela Receita não fica em claro no banco');
  const naLista = (await api('GET', '/api/empresas')).body.empresas.find((e) => e.id === empresaId);
  assert.ok(naLista.consultaRecusadaEm);
  assert.match(naLista.consultaRecusadaMotivo, /Procuração eletrônica não localizada/);
  assert.ok((await api('GET', '/api/inicio', undefined, h)).body.receita.recusadaEm);
  assert.ok((await api('GET', '/api/perfil', undefined, h)).body.receita.recusadaEm);
  // A consulta seguinte dá certo: a recusa some.
  assert.equal((await api('POST', '/api/notas/sincronizar', {}, h)).status, 200);
  const depois = (await api('GET', '/api/empresas')).body.empresas.find((e) => e.id === empresaId);
  assert.equal(depois.consultaRecusadaEm, null);
  assert.ok(depois.sincronizadoEm);
  const receita = (await api('GET', '/api/perfil', undefined, h)).body.receita;
  assert.equal(receita.recusadaEm, null);
  assert.ok(receita.consultadaEm);
});

test('produção é o ambiente padrão quando liberada: empresa nova, troca em lote e edição sem mudar de ambiente', async () => {
  const { config, producaoLiberadaEm } = await import('../src/config.js');
  // Regra do servidor: produção por padrão; 0 prende aos testes; desenvolvimento só com 1; demonstração nunca.
  assert.equal(producaoLiberadaEm({}), true);
  assert.equal(producaoLiberadaEm({ variavel: '0' }), false);
  assert.equal(producaoLiberadaEm({ dev: true }), false);
  assert.equal(producaoLiberadaEm({ dev: true, variavel: '1' }), true);
  assert.equal(producaoLiberadaEm({ demo: true, variavel: '1' }), false, 'simulação nunca vira nota real');
  assert.equal(config.producaoLiberada, false, 'nos testes automatizados a produção fica fechada');
  assert.equal(config.ambientePadrao, 'producao_restrita');

  const api = sessao();
  await api('POST', '/api/conta/cadastrar', { email: 'producao@exemplo.com', senha: 'senha-segura-1' });
  const dados = (documento, nome, extra = {}) => ({ documento, nome, municipioIbge: '3550308', opSimpNac: '2', ...extra });
  // Com a produção fechada: a empresa nasce em testes e não entra em produção.
  const a = (await api('POST', '/api/empresas', dados(EMPRESA, 'Em testes'))).body;
  assert.equal(a.empresa.ambiente, 'producao_restrita');
  assert.equal((await api('POST', '/api/empresas', dados(OUTRA, 'Quer produção', { ambiente: 'producao' }))).status, 422);
  assert.equal((await api('PUT', '/api/empresas/ambiente', { empresas: [a.empresaId], ambiente: 'producao' })).status, 409);
  assert.equal((await api('GET', '/api/empresas')).body.producaoLiberada, false);

  config.producaoLiberada = true;
  try {
    assert.equal(config.ambientePadrao, 'producao');
    assert.equal((await api('GET', '/api/empresas')).body.producaoLiberada, true);
    // Empresa nova já nasce em produção; quem pede testes continua podendo.
    const b = (await api('POST', '/api/empresas', dados(OUTRA, 'Nova em produção'))).body;
    assert.equal(b.empresa.ambiente, 'producao');
    const c = (await api('POST', '/api/empresas', dados(CLIENTE, 'Pediu testes', { ambiente: 'producao_restrita' }))).body;
    assert.equal(c.empresa.ambiente, 'producao_restrita');
    assert.equal((await api('GET', '/api/perfil', undefined, { 'x-notavez-prestador': b.empresaId })).body.ambientePadrao, 'producao');

    // As que ficaram em testes passam para a produção de uma vez; ids de fora são ignorados.
    assert.equal((await api('PUT', '/api/empresas/ambiente', { empresas: [], ambiente: 'producao' })).status, 422);
    const lote = await api('PUT', '/api/empresas/ambiente', { empresas: [a.empresaId, b.empresaId, c.empresaId, 'nao-existe'], ambiente: 'producao' });
    assert.equal(lote.status, 200, JSON.stringify(lote.body));
    assert.equal(lote.body.alteradas, 2, 'A e C estavam em testes; B já estava em produção');
    assert.ok(lote.body.empresas.every((e) => e.ambiente === 'producao'));
    assert.equal((await app.ctx.db.all("SELECT 1 FROM auditoria WHERE acao = 'empresa.ambiente_alterado' AND prestador_id IN (?, ?)", a.empresaId, c.empresaId)).length, 2);

    // Editar os dados sem dizer o ambiente não tira a empresa de onde ela está.
    const h = { 'x-notavez-prestador': a.empresaId };
    const editada = await api('PUT', '/api/perfil', dados(EMPRESA, 'Nome novo'), h);
    assert.equal(editada.status, 200, JSON.stringify(editada.body));
    assert.equal(editada.body.perfil.ambiente, 'producao');
    // Voltar para testes também fica registrado.
    assert.equal((await api('PUT', '/api/perfil', dados(EMPRESA, 'Nome novo', { ambiente: 'producao_restrita' }), h)).body.perfil.ambiente, 'producao_restrita');
    assert.equal((await app.ctx.db.all("SELECT 1 FROM auditoria WHERE acao = 'empresa.ambiente_alterado' AND prestador_id = ?", a.empresaId)).length, 2);
  } finally { config.producaoLiberada = false; }
});

test('por procuração: a conta sabe que a empresa é atendida assim e a recusa do certificado fala da procuração', async () => {
  const { explicar, explicarPorProcuracao } = await import('../src/fiscal/mensagens.js');
  const recusa = { codigo: 'E0718', descricao: 'Assinatura deve ser do emitente.' };
  assert.match(explicar(recusa).proximoPasso, /certificado A1 do CNPJ/);
  const porProcuracao = explicarPorProcuracao(recusa);
  assert.match(porProcuracao.mensagem, /não reconheceu a procuração/);
  assert.match(porProcuracao.proximoPasso, /Portal de Serviços da Receita/);
  assert.equal(porProcuracao.oficial, recusa.descricao, 'a mensagem oficial continua junto');
  assert.deepEqual(explicarPorProcuracao({ codigo: 'E0082', descricao: 'x' }), explicar({ codigo: 'E0082', descricao: 'x' }), 'as demais recusas não mudam');

  const api = sessao();
  await api('POST', '/api/conta/cadastrar', { email: 'conta-procuracao@exemplo.com', senha: 'senha-segura-1' });
  assert.equal((await api('POST', '/api/procurador/certificado', pfx(cert))).status, 200);
  const lista = (await api('GET', '/api/empresas')).body;
  assert.ok(lista.procurador?.validoAte, 'a lista de empresas traz o certificado do escritório');
  const { empresaId } = (await api('POST', '/api/empresas', { documento: OUTRA, nome: 'Cliente por procuração', municipioIbge: '3550308', opSimpNac: '2', usaProcuracao: true })).body;
  const conta = (await api('GET', `/api/conta?empresa=${empresaId}`)).body;
  assert.equal(conta.empresaPorProcuracao, true);
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
  assert.equal((await app.ctx.db.get('SELECT COUNT(*) n FROM notas WHERE prestador_id = ?', b)).n, 0);
});

test('tarefa periódica: consulta todas as empresas com certificado válido e não para em falhas', async () => {
  const antes = sefin.estado.consultasDistribuicao.length;
  const r = await app.ctx.tomadas.sincronizarTodas();
  assert.ok(r.empresas >= 1);
  assert.ok(sefin.estado.consultasDistribuicao.length > antes);
  sefin.estado.falharDistribuicao = true;
  try { assert.equal((await app.ctx.tomadas.sincronizarTodas()).empresas, 0, 'falhas não derrubam a rodada'); } finally { sefin.estado.falharDistribuicao = false; }
});

test('de hora em hora: rodízio pela consulta mais antiga, pula quem está em dia e respeita o tempo-limite', async () => {
  const { tomadas, repo, db } = app.ctx;
  await tomadas.sincronizarTodas(); // todas em dia
  const empresas = await repo.prestadoresComCertificado();
  const total = empresas.length;
  assert.ok(total >= 2, `empresas com certificado: ${total}`);

  // Rodada logo em seguida: ninguém é consultado de novo.
  const antes = sefin.estado.consultasDistribuicao.length;
  const emDia = await tomadas.sincronizarTodas({ recenteMs: 30 * 60_000 });
  assert.equal(emDia.empresas, 0);
  assert.equal(emDia.emDia, total);
  assert.equal(sefin.estado.consultasDistribuicao.length, antes, 'nenhuma consulta à Receita');

  // Duas ficaram para trás: só elas são consultadas, e a mais antiga vai primeiro na fila.
  const [maisAntiga, antiga] = [empresas.at(-1), empresas[0]];
  await db.run("UPDATE distribuicao_dfe SET sincronizado_em = '2020-01-01T00:00:00.000Z' WHERE prestador_id = ?", maisAntiga.id);
  await db.run("UPDATE distribuicao_dfe SET sincronizado_em = '2021-06-01T00:00:00.000Z' WHERE prestador_id = ?", antiga.id);
  const ordem = [];
  const original = repo.distribuicao;
  repo.distribuicao = async (...args) => { ordem.push(args[0]); return original(...args); };
  try {
    const r = await tomadas.sincronizarTodas({ recenteMs: 30 * 60_000 });
    assert.equal(r.empresas, 2);
    assert.equal(r.emDia, total - 2);
  } finally { repo.distribuicao = original; }
  assert.deepEqual([...new Set(ordem)].slice(0, 2), [maisAntiga.id, antiga.id]);

  // Tempo esgotado: nada é consultado, tudo fica para a próxima rodada.
  const semTempo = await tomadas.sincronizarTodas({ ateMs: Date.now() - 1 });
  assert.equal(semTempo.empresas, 0);
  assert.equal(semTempo.faltaram, total);
});

test('vercel.json: busca na Receita de hora em hora, com agendamentos diários (aceitos no plano Hobby)', async () => {
  const { readFileSync } = await import('node:fs');
  const { crons } = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const horas = crons.filter((c) => c.path === '/api/cron/sincronizar').map((c) => {
    const [minuto, hora, ...resto] = c.schedule.split(' ');
    assert.deepEqual(resto, ['*', '*', '*'], `uma vez por dia: ${c.schedule}`);
    assert.match(minuto, /^\d+$/);
    return Number(hora);
  });
  assert.deepEqual(horas.sort((a, b) => a - b), Array.from({ length: 24 }, (_, i) => i), 'uma rodada em cada hora do dia');
  assert.ok(crons.length <= 100, 'limite de 100 agendamentos por projeto');
});
