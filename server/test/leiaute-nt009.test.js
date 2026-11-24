// Transição da NT 009 (mesma versão "1.01" no XML, estrutura nova): a DPS sai no leiaute certo para cada
// ambiente e data, e cada leiaute passa no XSD oficial correspondente (produção: NT 004; produção restrita de
// 20/10/2026: NT 009 "release 1").
process.env.NODE_ENV = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { montarDps } = await import('../src/fiscal/dps.js');
const { validarXsd } = await import('../src/fiscal/xsd.js');
const { validarRascunho, leiautesParaEnvio, esquecerLeiautesAceitos } = await import('../src/fiscal/emissao.js');

const PERFIL = { tipoDocumento: 'CNPJ', documento: '11222333000181', municipioIbge: '3550308', nome: 'EMPRESA', regApTribSN: '1', pTotTribSN: '6,00', aliqIssSN: '2,00',
  apuracao: 'presumido', cstPisCofins: '01', aliqPis: '0,65', aliqCofins: '3,00', pTotTribFed: '13,45', pTotTribMun: '2,00', aliqIss: '5,00' };
const TOMA = { tipo: 'CNPJ', documento: '11444777000161', nome: 'CLIENTE', endereco: { cep: '01001000', municipioIbge: '3550308', logradouro: 'Praça da Sé', numero: '1', bairro: 'Sé' } };
const END = { cep: '01001000', municipioIbge: '3550308', logradouro: 'Praça da Sé', numero: '200', bairro: 'Sé' };
const PARAM = { convenioEmissor: { situacao: 'ativo' }, convenioIncidencia: { situacao: 'ativo' } };

function dps(opSimpNac, rascunho, leiaute) {
  const prestador = { ...PERFIL, opSimpNac };
  const nota = { competencia: '2026-11-20', tomador: TOMA, localPrestacaoIbge: '3550308', descricao: 'Serviço', valor: '1000.00', ...rascunho };
  const v = validarRascunho(prestador, nota, '2026-11-24', PARAM);
  assert.ok(v.ok, JSON.stringify(v.erros));
  return montarDps({ tpAmb: '2', prestador, nota, pacote: v.pacote, serie: '1', nDPS: 7, dhEmi: '2026-11-24T10:00:00-03:00', verAplic: 'teste', contexto: v.contexto, leiaute }).xml;
}
const CASOS = [
  ['MEI', '2', { cTribNac: '010101' }],
  ['ME/EPP com NBS', '3', { cTribNac: '010101', cNBS: '115021000' }],
  ['Presumido', '1', { cTribNac: '170101', cNBS: '110014000' }],
  ['Presumido, serviço sobre imóvel (endereço)', '1', { cTribNac: '071002', cNBS: '118031000', obra: { tipo: 'endereco', inscImobFisc: '9', endereco: END } }],
  ['Presumido, serviço sobre imóvel (CIB)', '1', { cTribNac: '071002', cNBS: '118031000', obra: { tipo: 'cib', cib: 'AB12CD34' } }],
  ['Presumido, obra com 200046', '1', { cTribNac: '070202', cNBS: '101011100', cClassTrib: '200046', obra: { tipo: 'endereco', endereco: END } }],
  ['Presumido, classificação sem tributação (820)', '1', { cTribNac: '150101', cNBS: '109014000' }],
];

test('cada leiaute passa no seu XSD oficial; o da NT 004 é recusado pelo XSD da NT 009 (e vice-versa)', async () => {
  for (const [nome, op, r] of CASOS) {
    for (const [leiaute, outro] of [['nt004', 'nt009'], ['nt009', 'nt004']]) {
      const xml = dps(op, r, leiaute);
      const ok = await validarXsd(xml, 'DPS_v1.01.xsd', { leiaute });
      assert.ok(ok.valido, `${nome} (${leiaute}): ${ok.erros[0]}`);
      assert.equal((await validarXsd(xml, 'DPS_v1.01.xsd', { leiaute: outro })).valido, false, `${nome}: ${leiaute} não deveria passar no XSD ${outro}`);
    }
  }
});

test('NT 009: finNFSe na raiz, xDescServ no fim de cServ, CST/cClassTrib em valores/trib e imóvel em gUnidImob', () => {
  const mei = dps('2', { cTribNac: '010101' }, 'nt009');
  assert.match(mei, /<tpEmit>1<\/tpEmit><finNFSe>0<\/finNFSe><cLocEmi>3550308<\/cLocEmi>/);
  assert.ok(!/<IBSCBS>/.test(mei), 'MEI: sem IBS/CBS em 2026');

  const p = dps('1', { cTribNac: '170101', cNBS: '110014000' }, 'nt009');
  assert.match(p, /<cServ><cTribNac>170101<\/cTribNac><cNBS>110014000<\/cNBS><xDescServ>Serviço<\/xDescServ><\/cServ>/);
  assert.match(p, /<IBSCBS><indFinal>0<\/indFinal><cIndOp>100301<\/cIndOp><indDest>0<\/indDest><valores><trib><CST>000<\/CST><cClassTrib>000001<\/cClassTrib><gIBSCBS><\/gIBSCBS><\/trib><\/valores><\/IBSCBS>/);
  assert.ok(!/<IBSCBS><finNFSe>/.test(p));

  const im = dps('1', { cTribNac: '071002', cNBS: '118031000', obra: { tipo: 'endereco', inscImobFisc: '9', endereco: END } }, 'nt009');
  assert.match(im, /<indDest>0<\/indDest><imovel><cMun>3550308<\/cMun><gUnidImob><inscImobFisc>9<\/inscImobFisc><end><CEP>01001000<\/CEP><xLgr>Praça da Sé<\/xLgr><nro>200<\/nro><xBairro>Sé<\/xBairro><\/end><\/gUnidImob><\/imovel><valores>/);

  // Classificação sem tributação de IBS/CBS (CST 820, ind_gIBSCBS = 0): sem cIndOp e sem gIBSCBS (E0859, E0961).
  const banco = dps('1', { cTribNac: '150101', cNBS: '109014000' }, 'nt009');
  assert.match(banco, /<IBSCBS><indFinal>0<\/indFinal><indDest>0<\/indDest><valores><trib><CST>820<\/CST><cClassTrib>820007<\/cClassTrib><\/trib><\/valores><\/IBSCBS>/);
  // Na NT 004 o mesmo serviço leva cIndOp e gIBSCBS com CST e cClassTrib.
  assert.match(dps('1', { cTribNac: '150101', cNBS: '109014000' }, 'nt004'), /<IBSCBS><finNFSe>0<\/finNFSe><indFinal>0<\/indFinal><cIndOp>100301<\/cIndOp><indDest>0<\/indDest><valores><trib><gIBSCBS><CST>820<\/CST>/);
});

test('leiaute escolhido pela data do ambiente (produção: 01/12/2026; produção restrita: 20/10/2026)', () => {
  esquecerLeiautesAceitos();
  const auto = { preferencia: 'auto' };
  assert.deepEqual(leiautesParaEnvio('producao', { ...auto, hoje: '2026-11-30' }), ['nt004', 'nt009']);
  assert.deepEqual(leiautesParaEnvio('producao', { ...auto, hoje: '2026-12-01' }), ['nt009', 'nt004']);
  assert.deepEqual(leiautesParaEnvio('producao_restrita', { ...auto, hoje: '2026-11-24' }), ['nt009', 'nt004']);
  // Configuração fixa (NOTAVEZ_LEIAUTE_DPS) muda só o primeiro: o outro continua como alternativa.
  assert.deepEqual(leiautesParaEnvio('producao', { preferencia: 'nt009', hoje: '2026-11-24' }), ['nt009', 'nt004']);
});
