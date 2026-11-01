// Emissão assistida pelo Emissor Nacional (sem certificado A1): roteiro com os
// valores da DPS e importação do XML da NFS-e emitida no site oficial.
process.env.NODE_ENV = 'test';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SignedXml } from 'xml-crypto';
import { gerarCertificadoTeste } from './apoio/certificado-teste.js';
import { iniciarSefinSimulada } from './apoio/sefin-simulada.js';

const { criarApp } = await import('../src/app.js');
const { lerCertificado } = await import('../src/fiscal/certificado.js');

const CNPJ = '11222333000181';
// "Receita" que assina as NFS-e de teste (no real, o certificado da Sefin Nacional).
const receita = gerarCertificadoTeste({ cnpj: '00394460005887', nome: 'RECEITA SIMULADA' });
const material = lerCertificado(receita.pfx, receita.senha);
let sefin; let app;
before(async () => {
  sefin = await iniciarSefinSimulada({ caPem: receita.caPem, caChavePem: receita.caChavePem, certClientePem: receita.certPem });
  app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false });
});
after(async () => { await app.close(); await sefin.fechar(); });

const certBase64 = (pem) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
function assinarNfse(xml) {
  const sig = new SignedXml({
    privateKey: material.chavePem, publicCert: material.certPem,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    getKeyInfoContent: () => `<X509Data><X509Certificate>${certBase64(material.certPem)}</X509Certificate></X509Data>`,
  });
  sig.addReference({ xpath: "//*[local-name(.)='infNFSe']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='infNFSe']", action: 'after' } });
  return sig.getSignedXml();
}
// NFS-e "emitida no Emissor Nacional" pela empresa: o simulador gera o XML oficial; aqui só assinamos.
const nfseDaEmpresa = (extra = {}) => assinarNfse(sefin.adicionarTomada({ prestador: CNPJ, tomador: '11444777000161', nome: 'EMPRESA TESTE', valor: '350.00', competencia: '2026-10-01', cTribNac: '010101', descricao: 'Criação de site', ...extra }).xml);

let ip = 0;
async function contaPronta(opSimpNac = '3', extra = { regApTribSN: '1', pTotTribSN: '6,00', aliqIssSN: '2,00' }) {
  const remoteAddress = `203.0.113.${++ip}`;
  let cookie = '';
  const api = async (method, url, payload) => {
    const r = await app.inject({ method, url, payload, remoteAddress, headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}) } });
    if (r.headers['set-cookie']) cookie = [r.headers['set-cookie']].flat().map((c) => c.split(';')[0]).join('; ');
    return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body, headers: r.headers };
  };
  await api('POST', '/api/conta/cadastrar', { email: `assistida${ip}@exemplo.test`, senha: 'senha-segura' });
  assert.equal((await api('POST', '/api/empresas', { documento: CNPJ, nome: 'Empresa Teste', municipioIbge: '3550308', opSimpNac, ...extra })).status, 200);
  const cli = await api('POST', '/api/clientes', { documento: '11.444.777/0001-61', nome: 'Cliente Empresa', email: 'contato@cliente.test',
    endereco: { cep: '01001000', municipioIbge: '3550308', logradouro: 'Praça da Sé', numero: '100', bairro: 'Sé' } });
  const nota = await api('POST', '/api/notas', { rascunho: { clienteId: cli.body.cliente.id, cTribNac: '010101', descricao: 'Criação de site', valor: '1234,50', competencia: '2026-10-01', issRetido: true } });
  return { api, notaId: nota.body.nota.id, clienteId: cli.body.cliente.id };
}
const campo = (roteiro, secao, rotulo) => roteiro.find((s) => s.titulo === secao)?.campos.find((c) => c.rotulo === rotulo);

test('roteiro do Emissor Nacional traz, sem certificado, os mesmos valores que iriam na DPS', async () => {
  const { api, notaId } = await contaPronta();
  const r = await api('GET', `/api/notas/${notaId}/assistida`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { roteiro } = r.body;
  assert.deepEqual(roteiro.map((s) => s.titulo), ['Pessoas', 'Serviço', 'Valores', 'Emitir']);
  assert.equal(r.body.emissorNacional, 'https://www.producaorestrita.nfse.gov.br/EmissorNacional');
  assert.equal(campo(roteiro, 'Pessoas', 'Data de competência').valor, '01/10/2026');
  assert.deepEqual([campo(roteiro, 'Pessoas', 'CNPJ').valor, campo(roteiro, 'Pessoas', 'CNPJ').copiar], ['11.444.777/0001-61', '11444777000161']);
  assert.equal(campo(roteiro, 'Pessoas', 'CEP').copiar, '01001000');
  assert.equal(campo(roteiro, 'Pessoas', 'Regime de apuração (Simples)').copiar, null, 'opções de lista não têm "copiar"');
  assert.equal(campo(roteiro, 'Serviço', 'Código de tributação nacional').copiar, '01.01.01');
  assert.deepEqual([campo(roteiro, 'Valores', 'Valor do serviço prestado').valor, campo(roteiro, 'Valores', 'Valor do serviço prestado').copiar], ['R$ 1.234,50', '1234,50']);
  assert.equal(campo(roteiro, 'Valores', 'Retenção do ISSQN').valor, 'Retido pelo tomador');
  // ME/EPP com ISS retido: alíquota do cadastro obrigatória (E0621), igual ao que iria na DPS.
  assert.equal(campo(roteiro, 'Valores', 'Alíquota do ISSQN (%)').valor, '2,00');
  assert.equal(campo(roteiro, 'Valores', 'Percentual aproximado dos tributos do Simples (%)').valor, '6,00');
  assert.deepEqual(r.body.avisos, []);

  const mei = await contaPronta('2', {});
  const rm = await mei.api('GET', `/api/notas/${mei.notaId}/assistida`);
  assert.equal(campo(rm.body.roteiro, 'Valores', 'Valor aproximado dos tributos').valor, 'Não informar (MEI)');
  assert.ok(rm.body.avisos.some((a) => a.regra === 'E0583'), 'MEI com ISS retido aparece como ponto a corrigir');
});

test('XML importado conclui o rascunho: emitida pelo Emissor Nacional, com DANFSe, histórico e clonagem', async () => {
  const { api, notaId, clienteId } = await contaPronta();
  const xml = nfseDaEmpresa();
  const r = await api('POST', '/api/notas/importar', { xml, notaId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const n = r.body.nota;
  assert.equal(n.id, notaId);
  assert.equal(n.situacao, 'emitida');
  assert.equal(n.canal, 'emissor_nacional');
  assert.equal(n.rotulo, 'Emitida (Emissor Nacional)');
  assert.match(n.chaveAcesso, /^\d{50}$/);
  assert.equal(n.valor, '350.00', 'valor oficial vem do XML');
  assert.equal(n.rascunho.clienteId, clienteId, 'mantém o vínculo com o cliente');
  assert.equal(r.body.assinatura.titular.startsWith('RECEITA SIMULADA'), true);
  const pdf = await api('GET', `/api/notas/${notaId}/danfse`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.match((await api('GET', `/api/notas/${notaId}/xml`)).body, /<NFSe/);
  assert.equal((await api('GET', '/api/inicio')).body.podeClonar, true);
  const clone = await api('POST', '/api/notas/clonar-ultima', {});
  assert.equal(clone.status, 200);
  assert.equal(clone.body.nota.rascunho.cTribNac, '010101');
  // Já concluída: nem roteiro nem nova importação por cima.
  assert.equal((await api('GET', `/api/notas/${notaId}/assistida`)).status, 409);
  const repetida = await api('POST', '/api/notas/importar', { xml });
  assert.equal(repetida.status, 409);
  assert.equal(repetida.body.notaId, notaId);
});

test('importação sem rascunho cria a nota; recusa outro CNPJ, XML alterado, sem assinatura ou que não é NFS-e', async () => {
  const { api } = await contaPronta();
  const avulsa = await api('POST', '/api/notas/importar', { xml: nfseDaEmpresa({ valor: '99.90' }) });
  assert.equal(avulsa.status, 200, JSON.stringify(avulsa.body));
  assert.equal(avulsa.body.nota.valor, '99.90');
  assert.equal(avulsa.body.nota.clienteNome, 'EMPRESA TOMADORA');
  assert.ok((await api('GET', '/api/notas?situacao=emitida')).body.notas.some((x) => x.id === avulsa.body.nota.id));

  const outro = await api('POST', '/api/notas/importar', { xml: assinarNfse(sefin.adicionarTomada({ prestador: '11444777000161', tomador: CNPJ }).xml) });
  assert.equal(outro.status, 422);
  assert.match(outro.body.erro, /11\.444\.777\/0001-61/);
  const alterado = nfseDaEmpresa({ valor: '100.00' }).replace('<vServ>100.00</vServ>', '<vServ>10.00</vServ>');
  const r1 = await api('POST', '/api/notas/importar', { xml: alterado });
  assert.equal(r1.status, 422);
  assert.match(r1.body.erro, /alterado/);
  const semAssinatura = sefin.adicionarTomada({ prestador: CNPJ, tomador: '11444777000161' }).xml;
  assert.match((await api('POST', '/api/notas/importar', { xml: semAssinatura })).body.erro, /assinatura/);
  assert.equal((await api('POST', '/api/notas/importar', { xml: '<DPS>'.padEnd(300, ' ') + '</DPS>' })).status, 422);
});
