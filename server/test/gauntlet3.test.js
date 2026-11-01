// Regressões da 3ª rodada do Gauntlet Loop (achados reproduzidos antes da correção):
// reconferência, limites de login, CPF do titular e resposta corrompida da Receita.
process.env.NODE_ENV = 'test';
process.env.NOTAVEZ_TIMEOUT_SEFIN_MS = '1500';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import forge from 'node-forge';
import { SignedXml } from 'xml-crypto';
import { gerarCertificadoTeste } from './apoio/certificado-teste.js';
import { iniciarSefinSimulada } from './apoio/sefin-simulada.js';

const { criarApp } = await import('../src/app.js');
const { lerCertificado } = await import('../src/fiscal/certificado.js');
const { criarClienteSefin } = await import('../src/fiscal/sefin/cliente.js');

const CNPJ = '11222333000181';
const cert = gerarCertificadoTeste({ cnpj: CNPJ, nome: 'EMPRESA CLIENTE LTDA' });
const receita = lerCertificado(cert.pfx, cert.senha);
let sefin;
before(async () => { sefin = await iniciarSefinSimulada({ caPem: cert.caPem, caChavePem: cert.caChavePem, certClientePem: cert.certPem }); });
after(async () => { await sefin.fechar(); });

const b64 = (pem) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
function assinar(xml) {
  const sig = new SignedXml({ privateKey: receita.chavePem, publicCert: receita.certPem, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315', getKeyInfoContent: () => `<X509Data><X509Certificate>${b64(receita.certPem)}</X509Certificate></X509Data>` });
  sig.addReference({ xpath: "//*[local-name(.)='infNFSe']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='infNFSe']", action: 'after' } });
  return sig.getSignedXml();
}
function cliente(app, ip) {
  let cookie = '';
  const api = async (method, url, payload, extra = {}) => {
    const r = await app.inject({ method, url, payload, remoteAddress: extra.ip || ip, headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}) } });
    if (r.headers['set-cookie']) {
      const novos = Object.fromEntries([r.headers['set-cookie']].flat().map((c) => c.split(';')[0].split(/=(.*)/s).slice(0, 2)));
      const atuais = Object.fromEntries(cookie ? cookie.split('; ').map((c) => c.split(/=(.*)/s).slice(0, 2)) : []);
      cookie = Object.entries({ ...atuais, ...novos }).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    let body; try { body = r.json(); } catch { body = r.body; }
    return { status: r.statusCode, body };
  };
  api.cookies = () => cookie;
  return api;
}

test('nota "não conferida" reconferida passa a mostrar valor e dados do XML oficial', async () => {
  const oficial = assinar(sefin.adicionarTomada({ prestador: CNPJ, tomador: '11444777000161', valor: '120.00' }).xml);
  const adulterado = assinar(oficial.replace(/<Signature[\s\S]*<\/Signature>/, '').replace('<vServ>120.00</vServ>', '<vServ>98765.43</vServ>'));
  const fake = () => ({ consultarNfse: async () => ({ tipo: 'ok', nfseXml: oficial }), consultarConvenio: async () => ({ situacao: 'desconhecido' }), fechar() {} });
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, fabricaCliente: fake });
  try {
    const api = cliente(app, '192.0.2.50');
    await api('POST', '/api/conta/cadastrar', { email: 'a@exemplo.test', senha: 'senha-segura' });
    await api('POST', '/api/empresas', { documento: CNPJ, nome: 'Cliente', municipioIbge: '3550308', opSimpNac: '2' });
    const sem = await api('POST', '/api/notas/importar', { xml: adulterado });
    assert.equal(sem.body.conferida, false);
    assert.equal(sem.body.nota.valor, '98765.43');
    await api('POST', '/api/certificado', { pfxBase64: cert.pfx.toString('base64'), senha: cert.senha, consentimento: true });
    const de = await api('POST', '/api/notas/importar', { xml: oficial });
    assert.equal(de.body.reconferida, true);
    const n = (await api('GET', `/api/notas/${sem.body.nota.id}`)).body.nota;
    assert.equal(n.importadaConferida, true);
    assert.equal(n.valor, '120.00', 'valor vem do XML oficial, não do arquivo não conferido');
    assert.equal(n.rascunho.valor, '120.00');
    assert.equal((await api('GET', '/api/notas')).body.notas.find((x) => x.id === n.id).valor, '120.00');
  } finally { await app.close(); }
});

test('tentativas erradas de vários IPs não trancam o dono no aparelho onde ele já entrou', async () => {
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false });
  try {
    const dono = cliente(app, '192.0.2.60');
    await dono('POST', '/api/conta/cadastrar', { email: 'dono@exemplo.test', senha: 'senha-segura' });
    assert.match(dono.cookies(), /nv_aparelho=/, 'o aparelho do cadastro fica marcado');
    const tentar = (ipA) => app.inject({ method: 'POST', url: '/api/conta/entrar', remoteAddress: ipA, headers: { 'x-notavez': '1' }, payload: { usuario: 'dono@exemplo.test', senha: 'errada-errada' } });
    for (let k = 1; k <= 7; k++) for (let i = 0; i < 15; i++) await tentar(`203.0.113.${k}`);
    // De outro IP (rede móvel), com o cookie do aparelho conhecido: entra.
    const r = await dono('POST', '/api/conta/entrar', { usuario: 'dono@exemplo.test', senha: 'senha-segura' }, { ip: '198.51.100.7' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // Aparelho desconhecido continua sob o teto global (é ele que barra tentativas distribuídas).
    const novo = await app.inject({ method: 'POST', url: '/api/conta/entrar', remoteAddress: '198.51.100.8', headers: { 'x-notavez': '1' }, payload: { usuario: 'dono@exemplo.test', senha: 'senha-segura' } });
    assert.equal(novo.statusCode, 429);
  } finally { await app.close(); }
});

test('escritório atrás do mesmo IP: logins certos de muitas pessoas não esgotam o limite', async () => {
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false });
  try {
    for (let i = 0; i < 20; i++) {
      await app.inject({ method: 'POST', url: '/api/conta/cadastrar', remoteAddress: `192.0.2.${100 + i}`, headers: { 'x-notavez': '1' }, payload: { email: `p${i}@escritorio.test`, senha: 'senha-segura' } });
    }
    const status = [];
    for (let i = 0; i < 20; i++) {
      status.push((await app.inject({ method: 'POST', url: '/api/conta/entrar', remoteAddress: '203.0.113.200', headers: { 'x-notavez': '1' }, payload: { usuario: `p${i}@escritorio.test`, senha: 'senha-segura' } })).statusCode);
    }
    assert.deepEqual([...new Set(status)], [200]);
    // Erros pelo mesmo IP continuam limitados.
    const erros = [];
    for (let i = 0; i < 17; i++) erros.push((await app.inject({ method: 'POST', url: '/api/conta/entrar', remoteAddress: '203.0.113.201', headers: { 'x-notavez': '1' }, payload: { usuario: `p${i}@escritorio.test`, senha: 'errada-errada' } })).statusCode);
    assert.ok(erros.includes(429), 'senhas erradas em massa pelo mesmo IP ainda são barradas');
  } finally { await app.close(); }
});

test('redefinir a senha mantém o CPF que o próprio titular digitou no cadastro', async () => {
  let tokenRec;
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, entregarRecuperacao: async ({ token }) => { tokenRec = token; } });
  try {
    const api = cliente(app, '192.0.2.70');
    const CPF = '52998224725';
    await api('POST', '/api/conta/cadastrar', { email: 'cpf@exemplo.test', senha: 'senha-segura', documento: CPF });
    const uid = app.ctx.db.get('SELECT id FROM usuarios WHERE email = ?', 'cpf@exemplo.test').id;
    app.ctx.auth.vincularGovbr(uid, { cpf: CPF });
    await api('POST', '/api/conta/recuperar', { usuario: 'cpf@exemplo.test' });
    assert.equal((await api('POST', '/api/conta/redefinir', { token: tokenRec, senha: 'nova-senha-123' })).status, 200);
    const r = await app.inject({ method: 'POST', url: '/api/conta/entrar', remoteAddress: '192.0.2.72', headers: { 'x-notavez': '1' }, payload: { usuario: '529.982.247-25', senha: 'nova-senha-123' } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(app.ctx.db.get('SELECT govbr_indice FROM usuarios WHERE id = ?', uid).govbr_indice, null, 'o gov.br continua desvinculado');
  } finally { await app.close(); }
});

test('resposta corrompida da Receita ao buscar XML/DANFSe não vira erro 500', async () => {
  const { pki } = forge;
  const k = pki.rsa.generateKeyPair(2048); const c = pki.createCertificate();
  c.publicKey = k.publicKey; c.serialNumber = '11';
  c.validity.notBefore = new Date(Date.now() - 86400_000); c.validity.notAfter = new Date(Date.now() + 86400_000);
  c.setSubject([{ name: 'commonName', value: 'localhost' }]); c.setIssuer(pki.certificateFromPem(cert.caPem).subject.attributes);
  c.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]);
  c.sign(pki.privateKeyFromPem(cert.caChavePem), forge.md.sha256.create());
  const srv = https.createServer({ key: pki.privateKeyToPem(k.privateKey), cert: pki.certificateToPem(c) }, (_, rs) => {
    rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ nfseXmlGZipB64: 'bm9uLWd6aXA=' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `https://127.0.0.1:${srv.address().port}/SefinNacional`;
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, fabricaCliente: (o) => criarClienteSefin({ ...o, baseUrl: url, ca: cert.caPem }) });
  try {
    const api = cliente(app, '192.0.2.80');
    await api('POST', '/api/conta/cadastrar', { email: 'xml@exemplo.test', senha: 'senha-segura' });
    await api('POST', '/api/empresas', { documento: CNPJ, nome: 'Cliente', municipioIbge: '3550308', opSimpNac: '2' });
    const imp = await api('POST', '/api/notas/importar', { xml: assinar(sefin.adicionarTomada({ prestador: CNPJ, tomador: '11444777000161', valor: '50.00' }).xml) });
    app.ctx.db.run('UPDATE notas SET nfse_xml_cifrado = NULL, canal = NULL WHERE id = ?', imp.body.nota.id);
    await api('POST', '/api/certificado', { pfxBase64: cert.pfx.toString('base64'), senha: cert.senha, consentimento: true });
    assert.equal((await api('GET', `/api/notas/${imp.body.nota.id}/xml`)).status, 503);
    assert.notEqual((await api('GET', `/api/notas/${imp.body.nota.id}/danfse`)).status, 500);
  } finally { await app.close(); srv.close(); }
});

test('lista de notas: competência filtrada no servidor, meses disponíveis e aviso quando passa de 200', async () => {
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false });
  try {
    const api = cliente(app, '192.0.2.90');
    await api('POST', '/api/conta/cadastrar', { email: 'lista@exemplo.test', senha: 'senha-segura' });
    await api('POST', '/api/empresas', { documento: CNPJ, nome: 'Cliente', municipioIbge: '3550308', opSimpNac: '2' });
    const pid = app.ctx.db.get('SELECT id FROM prestadores').id;
    for (let i = 0; i < 205; i++) app.ctx.repo.criarNota(pid, { descricao: `n${i}`, valor: '10.00', competencia: i < 5 ? '2026-08-10' : '2026-10-10' });
    const todas = (await api('GET', '/api/notas')).body;
    assert.equal(todas.notas.length, 200);
    assert.equal(todas.limitado, true);
    assert.deepEqual(todas.meses, ['2026-10', '2026-08']);
    const agosto = (await api('GET', '/api/notas?competencia=2026-08')).body;
    assert.equal(agosto.notas.length, 5, 'o mês antigo vem completo mesmo fora das 200 mais recentes');
    assert.equal(agosto.limitado, false);
  } finally { await app.close(); }
});
