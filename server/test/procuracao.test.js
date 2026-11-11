// Procuração eletrônica NFS-e (desde 01/11/2026): o escritório usa o PRÓPRIO
// certificado na API em nome das empresas que o autorizaram (emissão e distribuição).
process.env.NODE_ENV = 'test';
process.env.NOTAVEZ_ESPERA_REENVIO_MS = '0';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gerarCertificadoTeste } from './apoio/certificado-teste.js';
import { iniciarSefinSimulada } from './apoio/sefin-simulada.js';

const { criarApp } = await import('../src/app.js');
const { criarClienteSefin } = await import('../src/fiscal/sefin/cliente.js');
const { ambientesSefin } = await import('../src/config.js');

const ESCRITORIO = '11444777000161';
const CLIENTE_A = '11222333000181';
const certEscritorio = gerarCertificadoTeste({ cnpj: ESCRITORIO, nome: 'ESCRITORIO CONTABIL' });
let sefin; let app;
before(async () => {
  // A Receita simulada só aceita conexões com o certificado do escritório.
  sefin = await iniciarSefinSimulada({ caPem: certEscritorio.caPem, caChavePem: certEscritorio.caChavePem, certClientePem: certEscritorio.certPem });
  Object.assign(ambientesSefin.producao_restrita, { sefin: sefin.baseUrl, parametros: sefin.baseParametros, adn: sefin.baseAdn });
  app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, fabricaCliente: (o) => criarClienteSefin({ ...o, ca: sefin.ca }) });
});
after(async () => { await app.close(); await sefin.fechar(); });

function sessao() {
  let cookie = '';
  return async (method, url, payload, headers = {}) => {
    const r = await app.inject({ method, url, payload, remoteAddress: '192.0.2.77', headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}), ...headers } });
    if (r.headers['set-cookie']) cookie = [r.headers['set-cookie']].flat().map((c) => c.split(';')[0]).join('; ');
    return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body };
  };
}
const pfx = (c) => ({ pfxBase64: c.pfx.toString('base64'), senha: c.senha, consentimento: true });

test('escritório emite e baixa tomadas pelo cliente com o próprio certificado; sem procuração, segue exigindo o do cliente', async () => {
  const api = sessao();
  await api('POST', '/api/conta/cadastrar', { email: 'escritorio@exemplo.test', senha: 'senha-segura' });
  const { empresaId } = (await api('POST', '/api/empresas', { documento: CLIENTE_A, nome: 'Cliente A', municipioIbge: '3550308', opSimpNac: '2' })).body;
  const h = { 'x-notavez-prestador': empresaId };

  // O certificado do escritório (outro CNPJ) não serve como certificado da empresa…
  const proprio = await api('POST', '/api/certificado', pfx(certEscritorio), h);
  assert.equal(proprio.status, 422);
  assert.match(proprio.body.problemas.join(' '), /diferente/);
  // …e procuração sem o certificado do procurador é recusada.
  const semCert = await api('PUT', '/api/perfil/procuracao', { ativa: true }, h);
  assert.equal(semCert.status, 409);
  assert.equal(semCert.body.acao, 'procurador');

  const enviado = await api('POST', '/api/procurador/certificado', pfx(certEscritorio));
  assert.equal(enviado.status, 200, JSON.stringify(enviado.body));
  assert.equal(enviado.body.certificado.documentoFormatado, '11.444.777/0001-61');
  assert.equal(enviado.body.certificado.procurador, true);
  assert.equal(enviado.body.certificado.tipoDocumento, 'CNPJ');

  const ativa = await api('PUT', '/api/perfil/procuracao', { ativa: true }, h);
  assert.equal(ativa.status, 200, JSON.stringify(ativa.body));
  assert.equal(ativa.body.perfil.usaProcuracao, true);
  // O Início avisa do vencimento do certificado que de fato assina: aqui, o do escritório.
  const inicio = await api('GET', '/api/inicio', undefined, h);
  assert.equal(inicio.body.certificadoDoEscritorio, true);
  assert.ok(inicio.body.certificadoValidoAte, 'validade do certificado do escritório');
  assert.equal(ativa.body.elegibilidade.podeEmitir, true, JSON.stringify(ativa.body.elegibilidade.pendencias));
  assert.match(ativa.body.elegibilidade.itens.find((i) => i.id === 'certificado').aviso, /procuração eletrônica/);
  const lista = (await api('GET', '/api/empresas')).body.empresas;
  assert.equal(lista[0].porProcuracao, true);
  assert.ok(lista[0].certificadoValidoAte);

  // Emissão: a DPS sai com o CNPJ do cliente como prestador, assinada e conectada pelo escritório.
  const nota = (await api('POST', '/api/notas', { rascunho: { tomador: { tipo: 'CPF', documento: '52998224725', nome: 'Maria' }, cTribNac: '010101', descricao: 'Site', valor: '200,00' } }, h)).body.nota;
  const v = await api('POST', `/api/notas/${nota.id}/validar`, { versao: nota.versao }, h);
  const e = await api('POST', `/api/notas/${nota.id}/emitir`, { versao: v.body.versao, revisao: v.body.revisao }, h);
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.nota.situacao, 'emitida');
  const dps = sefin.estado.recebidas.at(-1);
  assert.match(dps, new RegExp(`<prest><CNPJ>${CLIENTE_A}</CNPJ>`));
  assert.match(dps, /<Signature/);

  // Distribuição: notas tomadas do cliente, consultadas com o certificado do escritório.
  sefin.adicionarTomada({ tomador: CLIENTE_A, nome: 'FORNECEDOR DO CLIENTE' });
  const s = await api('POST', '/api/tomadas/sincronizar', {}, h);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.novas, 1);
  assert.equal(sefin.estado.consultasDistribuicao.at(-1).cnpjConsulta, CLIENTE_A);

  // Desligar a procuração volta a exigir o certificado da própria empresa.
  const desliga = await api('PUT', '/api/perfil/procuracao', { ativa: false }, h);
  assert.equal(desliga.body.elegibilidade.podeEmitir, false);
  assert.ok(desliga.body.elegibilidade.pendencias.some((p) => p.id === 'certificado'));
  await api('PUT', '/api/perfil/procuracao', { ativa: true }, h);

  // Sem o certificado do procurador, as empresas por procuração param de emitir.
  assert.equal((await api('DELETE', '/api/procurador/certificado', {})).status, 200);
  const depois = (await api('GET', '/api/perfil', undefined, h)).body;
  assert.equal(depois.elegibilidade.podeEmitir, false);
  assert.ok(!depois.procurador);
  const n2 = (await api('POST', '/api/notas', { rascunho: { tomador: { tipo: 'NENHUM' }, cTribNac: '010101', descricao: 'Site', valor: '10' } }, h)).body.nota;
  const v2 = await api('POST', `/api/notas/${n2.id}/validar`, { versao: n2.versao }, h);
  assert.equal((await api('POST', `/api/notas/${n2.id}/emitir`, { versao: v2.body.versao, revisao: v2.body.revisao }, h)).status, 403);
});
