// Regressões dos achados confirmados no Gauntlet Loop (críticos independentes,
// cada achado reproduzido antes da correção): isolamento, CNPJ, certificados.
process.env.NODE_ENV = 'test';
process.env.NOTAVEZ_TIMEOUT_SEFIN_MS = '1500';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SignedXml } from 'xml-crypto';
import { gerarCertificadoTeste } from './apoio/certificado-teste.js';
import { iniciarSefinSimulada } from './apoio/sefin-simulada.js';

const { criarApp } = await import('../src/app.js');
const { lerCertificado } = await import('../src/fiscal/certificado.js');

const CNPJ = '11222333000181';
const cert = gerarCertificadoTeste({ cnpj: CNPJ, nome: 'EMPRESA CLIENTE LTDA' });
const receita = lerCertificado(cert.pfx, cert.senha);
let sefin; let app;
before(async () => {
  sefin = await iniciarSefinSimulada({ caPem: cert.caPem, caChavePem: cert.caChavePem, certClientePem: cert.certPem });
  app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false });
});
after(async () => { await app.close(); await sefin.fechar(); });

const b64 = (pem) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
function nfseAssinada() {
  const xml = sefin.adicionarTomada({ prestador: CNPJ, tomador: '11444777000161', valor: '120.00' }).xml;
  const sig = new SignedXml({ privateKey: receita.chavePem, publicCert: receita.certPem, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315', getKeyInfoContent: () => `<X509Data><X509Certificate>${b64(receita.certPem)}</X509Certificate></X509Data>` });
  sig.addReference({ xpath: "//*[local-name(.)='infNFSe']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='infNFSe']", action: 'after' } });
  return sig.getSignedXml();
}

let ip = 0;
async function conta(email, empresa = { documento: CNPJ, nome: 'Cliente', municipioIbge: '3550308', opSimpNac: '2' }) {
  const remoteAddress = `198.18.0.${++ip}`;
  let cookie = '';
  const api = async (method, url, payload) => {
    const r = await app.inject({ method, url, payload, remoteAddress, headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}) } });
    if (r.headers['set-cookie']) cookie = [r.headers['set-cookie']].flat().map((c) => c.split(';')[0]).join('; ');
    return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body };
  };
  await api('POST', '/api/conta/cadastrar', { email, senha: 'senha-segura' });
  const e = await api('POST', '/api/empresas', empresa);
  assert.equal(e.status, 200, JSON.stringify(e.body));
  return { api, empresaId: e.body.empresaId };
}

test('a mesma NFS-e pode estar na conta do dono e na do contador (chave única por empresa)', async () => {
  const xml = nfseAssinada();
  const dono = await conta('dono@exemplo.test');
  const contador = await conta('contador@exemplo.test');
  assert.equal((await contador.api('POST', '/api/notas/importar', { xml })).status, 200);
  const r = await dono.api('POST', '/api/notas/importar', { xml });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await dono.api('POST', '/api/notas/importar', { xml })).body.erro, 'Esta NFS-e já está no histórico.');
});

test('CNPJ não muda depois de notas emitidas (o histórico é do CNPJ antigo)', async () => {
  const c = await conta('troca@exemplo.test');
  assert.equal((await c.api('POST', '/api/notas/importar', { xml: nfseAssinada() })).status, 200);
  const r = await c.api('PUT', '/api/perfil', { documento: '11444777000161', nome: 'Outra', municipioIbge: '3550308', opSimpNac: '2' });
  assert.equal(r.status, 409);
  assert.ok(r.body.campos.documento);
  assert.equal((await c.api('GET', '/api/perfil')).body.perfil.documento, CNPJ);
  // Sem histórico, corrigir um CNPJ digitado errado continua possível.
  const nova = await conta('corrige@exemplo.test', { documento: '11444777000161', nome: 'Digitado errado', municipioIbge: '3550308', opSimpNac: '2' });
  assert.equal((await nova.api('PUT', '/api/perfil', { documento: '06990590000123', nome: 'Certo', municipioIbge: '3550308', opSimpNac: '2' })).status, 200);
});

test('lista de empresas conta só as tomadas do ambiente atual (igual à tela de tomadas)', async () => {
  const c = await conta('ambiente@exemplo.test');
  const { db } = app.ctx;
  db.run(`INSERT INTO notas_tomadas (id, prestador_id, ambiente, nsu, chave_cifrada, chave_indice, resumo_cifrado, xml_cifrado, baixada_em)
    VALUES ('t-amb', ?, 'producao_restrita', 1, 'x', 'idx-amb', 'x', 'x', '2026-10-01')`, c.empresaId);
  assert.equal((await c.api('GET', '/api/empresas')).body.empresas[0].tomadas, 1);
  db.run("UPDATE prestadores SET ambiente = 'producao' WHERE id = ?", c.empresaId);
  assert.equal((await c.api('GET', '/api/empresas')).body.empresas[0].tomadas, 0);
});

test('certificado vencido não derruba a revisão nem a emissão assistida; a emissão lista a pendência', async () => {
  const c = await conta('vencido@exemplo.test', { documento: CNPJ, nome: 'ME', municipioIbge: '3304557', opSimpNac: '3', regApTribSN: '1', pTotTribSN: '6', aliqIssSN: '2' });
  assert.equal((await c.api('POST', '/api/certificado', { pfxBase64: cert.pfx.toString('base64'), senha: cert.senha, consentimento: true })).status, 200);
  app.ctx.db.run("UPDATE certificados SET valido_ate = '2020-01-01T00:00:00.000Z' WHERE prestador_id = ?", c.empresaId);
  const nota = (await c.api('POST', '/api/notas', { rascunho: { tomador: { tipo: 'NENHUM' }, cTribNac: '010101', descricao: 'Site', valor: '100' } })).body.nota;
  const v = await c.api('POST', `/api/notas/${nota.id}/validar`, { versao: nota.versao });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal((await c.api('GET', `/api/notas/${nota.id}/assistida`)).status, 200);
  const e = await c.api('POST', `/api/notas/${nota.id}/emitir`, { versao: v.body.versao, revisao: v.body.revisao });
  assert.equal(e.status, 403);
  assert.ok(e.body.pendencias.some((p) => p.id === 'certificado_validade'), JSON.stringify(e.body));
});

test('nome do titular do certificado é guardado sem o CPF/CNPJ do CN (o documento já vai cifrado)', async () => {
  const c = await conta('titular@exemplo.test');
  const r = await c.api('POST', '/api/certificado', { pfxBase64: cert.pfx.toString('base64'), senha: cert.senha, consentimento: true });
  assert.equal(r.body.certificado.titular, 'EMPRESA CLIENTE LTDA');
  assert.equal(app.ctx.db.get("SELECT count(*) n FROM certificados WHERE titular LIKE '%11222333000181%'").n, 0);
  await c.api('DELETE', '/api/certificado', {});
  assert.equal(app.ctx.db.get('SELECT titular FROM certificados WHERE prestador_id = ?', c.empresaId).titular, null);
});

test('XML importado: outro infNFSe ao lado do assinado é recusado; sem certificado a nota fica "não conferida"', async () => {
  const c = await conta('wrap@exemplo.test');
  const xml = nfseAssinada();
  // Um segundo infNFSe na raiz (fora do leiaute) não pode ser lido no lugar do assinado.
  const embrulhado = xml.replace(/<infNFSe /, '<infNFSe Id="NFS00000000000000000000000000000000000000000000000001"><xLocEmi>X</xLocEmi></infNFSe><infNFSe ');
  assert.equal((await c.api('POST', '/api/notas/importar', { xml: embrulhado })).status, 422);
  const r = await c.api('POST', '/api/notas/importar', { xml });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.conferida, false);
  assert.equal(r.body.nota.importadaConferida, false);
  assert.match(r.body.nota.aviso, /NÃO CONFERIDA/);
});

test('evento malformado no lote do ADN não trava a sincronização das notas tomadas', async () => {
  const { criarServicoTomadas } = await import('../src/fiscal/tomadas.js');
  const c = await conta('evento@exemplo.test');
  const p = app.ctx.repo.prestador(c.empresaId);
  const lote = [{ nsu: 1, tipoDocumento: 'EVENTO', xml: '<evento><infEvento><pedRegEvento><quebrado' }];
  const servico = criarServicoTomadas({ repo: app.ctx.repo, emissao: { distribuirDfe: async (_p, nsu) => ({ tipo: 'ok', documentos: nsu < 1 ? lote : [] }) } });
  const r = await servico.sincronizar(p);
  assert.equal(r.ultimoNsu, 1, 'o NSU avança além do evento ruim');
});

// ---------- Segunda rodada (críticos novos sobre as correções) ----------

test('nota rejeitada não impede corrigir o CNPJ que a própria rejeição manda corrigir', async () => {
  const c = await conta('rejeitada@exemplo.test', { documento: '11444777000161', nome: 'Errado', municipioIbge: '3550308', opSimpNac: '2' });
  const n = (await c.api('POST', '/api/notas', { rascunho: { valor: '10' } })).body.nota;
  app.ctx.db.run("UPDATE notas SET situacao = 'rejeitada' WHERE id = ?", n.id);
  assert.equal((await c.api('PUT', '/api/perfil', { documento: '06990590000123', nome: 'Certo', municipioIbge: '3550308', opSimpNac: '2' })).status, 200);
});

test('senhas erradas de outro IP não trancam o dono da conta', async () => {
  const dono = await conta('trancar@exemplo.test');
  const tentar = (ipOrigem, senha) => app.inject({ method: 'POST', url: '/api/conta/entrar', remoteAddress: ipOrigem, headers: { 'x-notavez': '1' }, payload: { usuario: 'trancar@exemplo.test', senha } });
  for (let i = 0; i < 16; i++) await tentar('203.0.113.66', 'errada-errada');
  assert.equal((await tentar('203.0.113.66', 'errada-errada')).statusCode, 429);
  assert.equal((await tentar('198.51.100.7', 'senha-segura')).statusCode, 200);
  assert.ok(dono);
});

test('XML com chave de acesso que não bate com emitente/número é recusado', async () => {
  const c = await conta('chave@exemplo.test');
  const xml = nfseAssinada().replace(/<nNFSe>(\d+)<\/nNFSe>/, (_, n) => `<nNFSe>${Number(n) + 1000}</nNFSe>`);
  const r = await c.api('POST', '/api/notas/importar', { xml });
  assert.equal(r.status, 422);
  assert.match(r.body.erro, /chave de acesso/);
});

test('com certificado: Receita fora não grava nada; nota "não conferida" é conferida ao importar de novo', async () => {
  let receitaOk = false;
  const xml = nfseAssinada();
  const fake = () => ({ consultarNfse: async () => (receitaOk ? { tipo: 'ok', nfseXml: xml } : { tipo: 'falha' }), consultarConvenio: async () => ({ situacao: 'desconhecido' }), fechar() {} });
  const app2 = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, fabricaCliente: fake });
  try {
    let cookie = '';
    const api = async (method, url, payload) => {
      const r = await app2.inject({ method, url, payload, remoteAddress: '192.0.2.200', headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}) } });
      if (r.headers['set-cookie']) cookie = [r.headers['set-cookie']].flat().map((x) => x.split(';')[0]).join('; ');
      return { status: r.statusCode, body: r.json() };
    };
    await api('POST', '/api/conta/cadastrar', { email: 'reconfere@exemplo.test', senha: 'senha-segura' });
    await api('POST', '/api/empresas', { documento: CNPJ, nome: 'Cliente', municipioIbge: '3550308', opSimpNac: '2' });
    // Sem certificado: entra como "não conferida".
    const sem = await api('POST', '/api/notas/importar', { xml });
    assert.equal(sem.body.conferida, false);
    // Com certificado e a Receita fora: 503 e nada muda.
    assert.equal((await api('POST', '/api/certificado', { pfxBase64: cert.pfx.toString('base64'), senha: cert.senha, consentimento: true })).status, 200);
    assert.equal((await api('POST', '/api/notas/importar', { xml })).status, 503);
    // Receita de volta: o mesmo XML confere a nota existente.
    receitaOk = true;
    const de = await api('POST', '/api/notas/importar', { xml });
    assert.equal(de.status, 200, JSON.stringify(de.body));
    assert.equal(de.body.reconferida, true);
    assert.equal(de.body.nota.id, sem.body.nota.id);
    assert.equal(de.body.nota.importadaConferida, true);
  } finally { await app2.close(); }
});
