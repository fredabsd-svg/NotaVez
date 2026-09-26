import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpfValido, cnpjValido, lerDocumento } from '../src/util/documentos.js';
import { valorDecimal } from '../src/util/entrada.js';
import { montarDps, idDps, dataHoraBrasilia } from '../src/fiscal/dps.js';
import { validarXsd } from '../src/fiscal/xsd.js';
import { pacote } from '../src/fiscal/regras/mei-2026.js';
import { escolherPacote } from '../src/fiscal/regras/index.js';
import { lerCertificado, verificarParaEmitente } from '../src/fiscal/certificado.js';
import { assinarDps, conferirAssinatura } from '../src/fiscal/assinatura.js';
import { lerMensagens } from '../src/fiscal/sefin/cliente.js';
import { explicar } from '../src/fiscal/mensagens.js';
import { gerarCertificadoTeste } from './apoio/certificado-teste.js';
import { gerarDanfse, montarConteudo, lerXmlNfse } from '../src/fiscal/danfse/index.js';

const prestador = { tipoDocumento: 'CNPJ', documento: '11222333000181', municipioIbge: '3550308', opSimpNac: '2' };
const notaBase = {
  competencia: '2026-09-01', valor: '150.00', cTribNac: '010101', descricao: 'Criação de site',
  tomador: { tipo: 'CPF', documento: '52998224725', nome: 'Maria da Silva' },
};

test('CPF e CNPJ (inclusive CNPJ alfanumérico)', () => {
  assert.ok(cpfValido('529.982.247-25'));
  assert.ok(!cpfValido('111.111.111-11'));
  assert.ok(cnpjValido('11.222.333/0001-81'));
  assert.ok(cnpjValido('12.ABC.345/01DE-35')); // exemplo oficial da Receita
  assert.ok(!cnpjValido('12.ABC.345/01DE-36'));
  assert.deepEqual(lerDocumento('12ABC34501DE35'), { tipo: 'CNPJ', numero: '12ABC34501DE35' });
});

test('valores no formato brasileiro', () => {
  assert.equal(valorDecimal('1.234,56'), '1234.56');
  assert.equal(valorDecimal('R$ 80'), '80.00');
  assert.equal(valorDecimal('abc'), '');
});

test('identificador da DPS com 45 posições (TSIdDPS)', () => {
  const id = idDps({ cLocEmi: '3550308', tipoDocumento: 'CNPJ', documento: '11222333000181', serie: '1', nDPS: 42 });
  assert.equal(id, 'DPS3550308211222333000181000010000000000000' + '42');
  assert.equal(id.length, 45);
  const cpf = idDps({ cLocEmi: '3550308', tipoDocumento: 'CPF', documento: '52998224725', serie: '1', nDPS: 1 });
  assert.match(cpf, /^DPS35503081000/);
});

test('DPS do MEI passa no XSD oficial e segue as regras do Anexo I', async () => {
  const { xml } = montarDps({ tpAmb: '2', prestador, nota: notaBase, pacote, serie: '1', nDPS: 1, dhEmi: dataHoraBrasilia(), verAplic: 'teste' });
  const r = await validarXsd(xml);
  assert.deepEqual(r.erros, []);
  assert.ok(!/<xNome>[^<]*<\/xNome><regTrib>/.test(xml), 'E0121: sem nome do prestador');
  assert.ok(!/<pAliq>/.test(xml), 'E0600: MEI sem alíquota');
  assert.match(xml, /<tpRetISSQN>1<\/tpRetISSQN>/, 'E0583: sem retenção');
  assert.match(xml, /<indTotTrib>0<\/indTotTrib>/, 'E0710: sem pTotTribSN');
  assert.match(xml, /<regEspTrib>0<\/regEspTrib>/, 'E0174');
  assert.ok(!/<tribFed>/.test(xml), 'E0676: sem tributos federais');
});

test('regras MEI barram erros antes do envio', () => {
  const v = (n) => pacote.validar({ prestador, nota: { ...notaBase, ...n }, hoje: '2026-09-25' }).map((e) => e.regra);
  assert.deepEqual(v({}), []);
  assert.ok(v({ competencia: '2026-10-01' }).includes('E0015'));
  assert.ok(v({ tomador: { tipo: 'CNPJ', documento: '11444777000161', nome: 'Empresa' } }).includes('E0235'));
  assert.ok(v({ tomador: { tipo: 'CPF', documento: '52998224726', nome: 'X' } }).includes('E0206'));
  assert.ok(v({ tomador: { tipo: 'CNPJ', documento: '11222333000181', nome: 'Eu', endereco: { cep: '01001000', municipioIbge: '3550308', logradouro: 'R', numero: '1', bairro: 'B' } } }).includes('E0202'));
  assert.ok(v({ cTribNac: '999999' }).includes('E0310'));
  assert.ok(v({ cTribNac: '070201' }).length > 0, 'serviço que exige grupo obra');
  assert.ok(v({ descricao: 'x'.repeat(1001) }).includes('Leiaute'));
});

test('pacote de regras por regime e vigência', () => {
  assert.ok(escolherPacote({ opSimpNac: '2', competencia: '2026-09-01' }).pacote);
  assert.equal(escolherPacote({ opSimpNac: '3', competencia: '2026-09-01' }).pacote.id, 'ME-EPP-2026');
  assert.equal(escolherPacote({ opSimpNac: '1', competencia: '2026-09-01' }).pacote.id, 'NAO-OPTANTE-2026');
  assert.match(escolherPacote({ opSimpNac: '1', competencia: '2027-01-02' }).motivo, /2027/);
  assert.match(escolherPacote({ opSimpNac: '3', competencia: '2027-01-02' }).motivo, /2027/);
  assert.match(escolherPacote({ opSimpNac: '2', competencia: '2027-01-02' }).motivo, /2027/);
});

test('certificado A1: leitura, checagens e assinatura XMLDSig', async () => {
  const t = gerarCertificadoTeste();
  const info = lerCertificado(t.pfx, t.senha);
  assert.equal(info.cnpj, '11222333000181');
  assert.deepEqual(verificarParaEmitente(info, '11222333000181'), []);
  assert.match(verificarParaEmitente(info, '11444777000161').join(), /diferente/);
  assert.throws(() => lerCertificado(t.pfx, 'errada'), /Senha/);
  const vencido = lerCertificado(gerarCertificadoTeste({ validoAte: new Date(Date.now() - 1000) }).pfx, 'teste');
  assert.match(verificarParaEmitente(vencido, '11222333000181').join(), /vencido/);

  const { xml } = montarDps({ tpAmb: '2', prestador, nota: notaBase, pacote, serie: '1', nDPS: 7, dhEmi: dataHoraBrasilia(), verAplic: 'teste' });
  const assinado = assinarDps(xml, info);
  assert.ok(conferirAssinatura(assinado, info.certPem));
  assert.ok(!conferirAssinatura(assinado.replace('150.00', '999.00'), info.certPem));
  assert.deepEqual((await validarXsd(assinado)).erros, []);
});

test('mensagens da Receita em linguagem comum', () => {
  const m = lerMensagens({ erros: [{ Codigo: 'E0015', Descricao: 'oficial' }, { codigo: 'E9999', descricao: 'desconhecido' }] });
  assert.equal(m.length, 2);
  assert.match(explicar(m[0]).mensagem, /competência/);
  assert.equal(explicar(m[1]).mensagem, 'desconhecido');
});

// ---------------- ME/EPP (Simples Nacional, opSimpNac = 3) ----------------
import { pacote as meEpp } from '../src/fiscal/regras/me-epp-2026.js';

const empresa = (extra = {}) => ({ ...prestador, opSimpNac: '3', regApTribSN: '1', pTotTribSN: '6.00', aliqIssSN: '2.00', ...extra });
const clienteCnpj = {
  tipo: 'CNPJ', documento: '11444777000161', nome: 'Cliente Ltda',
  endereco: { cep: '01001000', municipioIbge: '3550308', logradouro: 'Praça da Sé', numero: '1', bairro: 'Sé' },
};
const ctxMe = (p, n, parametros = {}) => ({ prestador: p, nota: { ...notaBase, ...n }, hoje: '2026-09-25', parametros, municipioIncidencia: n.localPrestacaoIbge || p.municipioIbge });
const ativo = { situacao: 'ativo', aderenteEmissorNacional: true };
const inexistente = { situacao: 'inexistente' };

async function dpsMe(p, n, parametros = {}) {
  const ctx = ctxMe(p, n, parametros);
  const { xml } = montarDps({ tpAmb: '2', prestador: p, nota: ctx.nota, pacote: meEpp, serie: '1', nDPS: 9, dhEmi: dataHoraBrasilia(), verAplic: 'teste', contexto: { parametros, municipioIncidencia: ctx.municipioIncidencia } });
  assert.deepEqual((await validarXsd(xml)).erros, [], 'DPS ME/EPP válida no XSD oficial');
  return xml;
}
const regras = (p, n, parametros = { convenioEmissor: ativo }) => meEpp.validar(ctxMe(p, n, parametros)).map((e) => e.regra);

test('ME/EPP pelo Simples sem retenção: sem alíquota, com regApTribSN e pTotTribSN (E0166, E0625, E0712)', async () => {
  assert.deepEqual(regras(empresa(), {}), []);
  const xml = await dpsMe(empresa(), {});
  assert.match(xml, /<opSimpNac>3<\/opSimpNac><regApTribSN>1<\/regApTribSN><regEspTrib>0<\/regEspTrib>/);
  assert.match(xml, /<pTotTribSN>6.00<\/pTotTribSN>/);
  assert.ok(!/<indTotTrib>/.test(xml), 'E0712');
  assert.ok(!/<pAliq>/.test(xml), 'E0625');
  assert.match(xml, /<tpRetISSQN>1<\/tpRetISSQN>/);
});

test('ME/EPP pelo Simples com ISS retido: alíquota obrigatória entre 1,8% e 5% (E0621, E0595, E0204, E0667)', async () => {
  const xml = await dpsMe(empresa(), { issRetido: true, tomador: clienteCnpj });
  assert.match(xml, /<tpRetISSQN>2<\/tpRetISSQN><pAliq>2.00<\/pAliq>/);
  assert.deepEqual(regras(empresa(), { issRetido: true, tomador: clienteCnpj }), []);
  assert.ok(regras(empresa({ aliqIssSN: null }), { issRetido: true, tomador: clienteCnpj }).includes('E0621'));
  assert.ok(regras(empresa(), { issRetido: true, tomador: clienteCnpj, pAliq: '1.50' }).includes('E0621'));
  assert.ok(regras(empresa(), { issRetido: true, tomador: clienteCnpj, pAliq: '6.00' }).includes('E0595'));
  assert.ok(regras(empresa(), { issRetido: true, tomador: null }).includes('E0204'));
  assert.ok(regras(empresa(), { issRetido: true }).includes('E0667'), 'retenção por CPF depende de autorização municipal');
});

test('ME/EPP com ISS fora do Simples: alíquota depende do convênio do município de incidência (E0635, E0640)', async () => {
  const p = empresa({ regApTribSN: '2' });
  // Convênio ativo → alíquota proibida, mesmo que o usuário tenha digitado uma.
  assert.equal(meEpp.exigencias(ctxMe(p, {}, { convenioIncidencia: ativo })).aliquota.modo, 'proibida');
  const xml1 = await dpsMe(p, { pAliq: '3.00' }, { convenioEmissor: ativo, convenioIncidencia: ativo });
  assert.ok(!/<pAliq>/.test(xml1));
  // Município não conveniado → obrigatória.
  assert.ok(regras(p, {}, { convenioEmissor: ativo, convenioIncidencia: inexistente }).includes('E0640'));
  const xml2 = await dpsMe(p, { pAliq: '3.00' }, { convenioEmissor: ativo, convenioIncidencia: inexistente });
  assert.match(xml2, /<pAliq>3.00<\/pAliq>/);
  // Sem conseguir consultar → não chuta: pede para tentar de novo.
  assert.ok(regras(p, {}, { convenioEmissor: ativo, convenioIncidencia: { situacao: 'desconhecido' } }).includes('E0635/E0640'));
});

test('ME/EPP: município do CNPJ precisa estar no Sistema Nacional (E0037, E0039) e perfil completo', () => {
  assert.ok(regras(empresa(), {}, { convenioEmissor: inexistente }).includes('E0037'));
  assert.ok(regras(empresa(), {}, { convenioEmissor: { situacao: 'ativo', aderenteEmissorNacional: false } }).includes('E0039'));
  assert.ok(regras(empresa({ regApTribSN: null }), {}).includes('E0166'));
  assert.ok(regras(empresa({ pTotTribSN: null }), {}).includes('Leiaute totTrib'));
});

test('MEI não pode ter ISS retido (E0583)', () => {
  assert.ok(pacote.validar({ prestador, nota: { ...notaBase, issRetido: true }, hoje: '2026-09-25' }).map((e) => e.regra).includes('E0583'));
});

// ---------------- Lucro Presumido / Real ----------------
import { pacote as naoOptante, tipoRetencaoPisCofins } from '../src/fiscal/regras/nao-optante-2026.js';
import { resolverIbsCbs, inicioObrigatoriedade } from '../src/fiscal/ibscbs.js';
import { arredondarBancario } from '../src/fiscal/regras/comum.js';

const presumido = (extra = {}) => ({ ...prestador, opSimpNac: '1', cstPisCofins: '01', aliqPis: '0.65', aliqCofins: '3.00', pTotTribFed: '13.45', pTotTribMun: '2.00', ...extra });
const ctxNo = (p, n, parametros = { convenioEmissor: ativo, convenioIncidencia: ativo }) => ({ prestador: p, nota: { ...notaBase, cTribNac: '010101', cNBS: '115021000', ...n }, hoje: '2026-10-05', parametros, municipioIncidencia: p.municipioIbge });

test('não optante: DPS válida no XSD com PIS/COFINS, pTotTrib e IBS/CBS', async () => {
  const ctx = ctxNo(presumido(), { tomador: clienteCnpj, issRetido: true, retencoesFederais: { pis: true, cofins: true, csll: false, valorContribuicoes: '36.50', irrf: '2.25' } });
  assert.deepEqual(naoOptante.validar(ctx), []);
  const { xml } = montarDps({ tpAmb: '2', prestador: ctx.prestador, nota: ctx.nota, pacote: naoOptante, serie: '1', nDPS: 5, dhEmi: dataHoraBrasilia(), verAplic: 't', contexto: { parametros: ctx.parametros, municipioIncidencia: ctx.municipioIncidencia } });
  assert.deepEqual((await validarXsd(xml)).erros, []);
  assert.match(xml, /<tpRetPisCofins>4<\/tpRetPisCofins>/, 'PIS e COFINS retidos, CSLL não');
  assert.ok(!/<regApTribSN>/.test(xml), 'E0162');
  assert.ok(!/<indTotTrib>|<pTotTribSN>/.test(xml), 'E0713');
  assert.ok(!/<pAliq>/.test(xml), 'E0617 com convênio ativo');
});

test('não optante: alíquota do ISS conforme convênio (E0617/E0619) e CST sem base (E0682)', async () => {
  assert.equal(naoOptante.exigencias(ctxNo(presumido(), {})).aliquota.modo, 'proibida');
  const semConv = { convenioEmissor: ativo, convenioIncidencia: inexistente };
  assert.ok(naoOptante.validar(ctxNo(presumido(), {}, semConv)).some((e) => e.regra === 'E0619'));
  assert.deepEqual(naoOptante.validar(ctxNo(presumido({ aliqIss: '2.00' }), {}, semConv)), []);
  assert.ok(naoOptante.validar(ctxNo(presumido(), { pAliq: '6.00' }, semConv)).some((e) => e.regra === 'E0595'));
  const ctx = ctxNo(presumido({ cstPisCofins: '08' }), {});
  const t = naoOptante.tributacao(ctx);
  assert.deepEqual(Object.keys(t.tribFed.piscofins), ['CST', 'tpRetPisCofins'], 'CST 08: sem base, alíquotas nem valores');
});

test('tpRetPisCofins (NT 007) e arredondamento bancário', () => {
  assert.equal(tipoRetencaoPisCofins({}), '0');
  assert.equal(tipoRetencaoPisCofins({ pis: true, cofins: true, csll: true }), '3');
  assert.equal(tipoRetencaoPisCofins({ pis: true, cofins: true }), '4');
  assert.equal(tipoRetencaoPisCofins({ csll: true }), '8');
  assert.equal(arredondarBancario(0.125), 0.12);
  assert.equal(arredondarBancario(0.135), 0.14);
  assert.equal(arredondarBancario(1234.56 * 0.03), 37.04);
});

test('IBS/CBS: opções oficiais, padrões seguros e prazos do Ato Conjunto 4/2026', () => {
  const um = resolverIbsCbs({ cTribNac: '010101', cNBS: '115021000', tomador: { tipo: 'CPF' } });
  assert.deepEqual(um.erros, []);
  assert.equal(um.grupo.cClassTrib, '000001');
  assert.equal(um.grupo.CST, '000');
  assert.equal(um.grupo.indFinal, '1', 'pessoa física: consumo pessoal');
  // Saúde (04.01): três formas de prestação → precisa escolher; classificação 200029 (Anexo III).
  const saude = resolverIbsCbs({ cTribNac: '040101', cNBS: '123012200', tomador: { tipo: 'CNPJ' } });
  assert.ok(saude.erros.some((e) => e.campo === 'ibscbs.cIndOp'));
  const saude2 = resolverIbsCbs({ cTribNac: '040101', cNBS: '123012200', cIndOp: '030101', tomador: { tipo: 'CNPJ' } });
  assert.equal(saude2.grupo.cClassTrib, '200029');
  assert.equal(saude2.grupo.CST, '200');
  assert.ok(resolverIbsCbs({ cTribNac: '010101', cNBS: '999999999' }).erros.some((e) => e.regra === 'Anexo VIII'));
  // Varrição (07.09.01, NBS 1.2406.10.00) usa cIndOp de imóvel (020201): exige grupo "imovel" → bloqueado.
  assert.ok(resolverIbsCbs({ cTribNac: '070901', cNBS: '124061000' }).erros.some((e) => e.regra === 'Anexo VI #592'));
  assert.equal(inicioObrigatoriedade('010101'), '2026-10-01');
  assert.equal(inicioObrigatoriedade('010301'), '2026-12-01');
  assert.equal(inicioObrigatoriedade('160101'), '2026-12-01');
});

// NFS-e sintética com os casos-limite do DANFSe (NT 008).
function nfseDanfse({ tribISSQN = '4', tpRetPisCofins = '1', dCompet = '2027-01-15', descricao = 'Serviço', infComp = null } = {}) {
  const chave = '35503082112223330001810000000000000012701000000017';
  return `<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${chave}">`
    + '<xLocEmi>São Paulo</xLocEmi><xLocPrestacao>Campinas</xLocPrestacao><nNFSe>17</nNFSe><cLocIncid>3509502</cLocIncid><xLocIncid>Campinas</xLocIncid>'
    + '<xTribNac>Nacional</xTribNac><xTribMun>Descrição municipal do serviço</xTribMun><verAplic>SEFIN</verAplic><ambGer>2</ambGer><tpEmis>1</tpEmis>'
    + '<cStat>102</cStat><dhProc>2027-01-15T09:08:07-03:00</dhProc><nDFSe>1</nDFSe>'
    + '<emit><CNPJ>11222333000181</CNPJ><xNome>Empresa Emitente Ltda</xNome><enderNac><xLgr>Rua A</xLgr><nro>1</nro><xBairro>Centro</xBairro><cMun>3550308</cMun><UF>SP</UF><CEP>01001000</CEP></enderNac></emit>'
    + '<valores><vTotalRet>0.00</vTotalRet><vLiq>1000.00</vLiq></valores><xOutInf>Informação do município</xOutInf>'
    + '<DPS versao="1.01"><infDPS Id="DPS355030821122233300018100900000000000000001"><tpAmb>1</tpAmb><dhEmi>2027-01-15T09:00:00-03:00</dhEmi>'
    + `<verAplic>NotaVez</verAplic><serie>900</serie><nDPS>1</nDPS><dCompet>${dCompet}</dCompet><tpEmit>1</tpEmit><cLocEmi>3550308</cLocEmi>`
    + '<prest><CNPJ>11222333000181</CNPJ><regTrib><opSimpNac>1</opSimpNac><regEspTrib>0</regEspTrib></regTrib></prest>'
    + '<toma><CPF>52998224725</CPF><xNome>Maria da Silva</xNome></toma>'
    + '<interm><NIF>ABC123</NIF><xNome>Agência Exterior</xNome><end><endExt><cPais>US</cPais><cEndPost>10001</cEndPost><xCidade>New York</xCidade><xEstProvReg>NY</xEstProvReg></endExt><xLgr>5th Ave</xLgr><nro>1</nro><xBairro>-</xBairro></end></interm>'
    + `<serv><locPrest><cLocPrestacao>3509502</cLocPrestacao></locPrest><cServ><cTribNac>010101</cTribNac><cTribMun>001</cTribMun><xDescServ>${descricao}</xDescServ><cNBS>115021000</cNBS></cServ>`
    + (infComp ? `<infoCompl><xInfComp>${infComp}</xInfComp></infoCompl>` : '') + '</serv>'
    + `<valores><vServPrest><vServ>1000.00</vServ></vServPrest><trib><tribMun><tribISSQN>${tribISSQN}</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun>`
    + `<tribFed><piscofins><CST>01</CST><vBCPisCofins>1000.00</vBCPisCofins><pAliqPis>0.65</pAliqPis><pAliqCofins>3.00</pAliqCofins><vPis>6.50</vPis><vCofins>30.00</vCofins><tpRetPisCofins>${tpRetPisCofins}</tpRetPisCofins></piscofins><vRetCSLL>10.00</vRetCSLL></tribFed>`
    + '<totTrib><vTotTrib><vTotTribFed>100.00</vTotTribFed><vTotTribEst>0.00</vTotTribEst><vTotTribMun>20.00</vTotTribMun></vTotTrib></totTrib></trib></valores>'
    + '<IBSCBS><finNFSe>0</finNFSe><indFinal>1</indFinal><cIndOp>030101</cIndOp><indDest>0</indDest><valores><trib><gIBSCBS><CST>000</CST><cClassTrib>000001</cClassTrib></gIBSCBS></trib></valores></IBSCBS>'
    + '</infDPS></DPS></infNFSe></NFSe>';
}

test('DANFSe (NT 008): descrições, supressões e regras dos campos', () => {
  const c = montarConteudo(lerXmlNfse(nfseDanfse()));
  assert.equal(c.chave, '35503082112223330001810000000000000012701000000017', 'sem o prefixo NFS');
  assert.equal(c.cabecalho.homologacao, false, 'produção: sem a frase de homologação');
  assert.equal(c.cabecalho.municipio, 'Município: São Paulo / SP');
  assert.equal(c.dados.cStat, 'NFS-e de Decisão Judicial');
  assert.equal(c.dados.dhProc, '15/01/2027 09:08:07');
  assert.equal(c.dados.dCompet, '15/01/2027');
  assert.equal(c.prestador.nome, 'Empresa Emitente Ltda');
  assert.equal(c.prestador.municipio, 'São Paulo / SP');
  assert.equal(c.prestador.ibgeCep, '3550308 / 01.001-000');
  assert.equal(c.tomador.doc, '529.982.247-25');
  assert.equal(c.tomador.endereco, '-', 'campo sem informação: traço');
  assert.equal(c.intermediario.doc, 'ABC123');
  assert.equal(c.intermediario.municipio, 'New York / NY / US');
  assert.equal(c.intermediario.ibgeCep, '10001');
  assert.equal(c.destinatario, null);
  assert.equal(c.destinatarioAviso, 'O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO');
  assert.equal(c.servico.codigo, '01.01.01 / 001');
  assert.equal(c.servico.descricaoCodigo, 'Descrição municipal do serviço', 'xTribMun tem prioridade');
  assert.equal(c.servico.local, 'Campinas / SP / BR');
  assert.equal(c.issqn, null, 'não incidência: bloco suprimido (Nota 4)');
  // tpRetPisCofins = 1: contribuições retidas = CSLL + PIS + COFINS; débito próprio zerado.
  assert.equal(c.federal.contribuicoes, 'R$ 46,50');
  assert.equal(c.federal.pis, 'R$ 0,00');
  assert.equal(c.federal.mostrarPisCofins, false, 'Nota 6: só até a competência 2026');
  assert.match(c.informacoes.texto, /^Inf\. A\. T\. Mun\.: Informação do município$/);
  assert.equal(c.informacoes.totais, 'Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: Federais: R$ 100,00 ; Estaduais: R$ 0,00 ; Municipais: R$ 20,00');

  const outro = montarConteudo(lerXmlNfse(nfseDanfse({ tribISSQN: '1', tpRetPisCofins: '2', dCompet: '2026-12-31' })));
  assert.equal(outro.issqn.tribISSQN, 'Operação Tributável');
  assert.equal(outro.issqn.incidencia, 'Campinas / SP / BR');
  assert.equal(outro.federal.contribuicoes, 'R$ 10,00');
  assert.equal(outro.federal.pis, 'R$ 6,50');
  assert.equal(outro.federal.mostrarPisCofins, true);
});

test('DANFSe: sempre uma página, mesmo com textos no limite, e recusa XML que não é NFS-e', async () => {
  const longa = 'Serviço prestado conforme contrato. '.repeat(40); // > 1.300 caracteres
  const pdf = await gerarDanfse(nfseDanfse({ descricao: longa, infComp: 'Observação longa. '.repeat(110) }), { marcaDagua: 'SIMULAÇÃO' });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1);
  assert.equal(montarConteudo(lerXmlNfse(nfseDanfse({ descricao: longa }))).servico.descricao.length, 1297);
  await assert.rejects(gerarDanfse('<DPS/>'), /não é uma NFS-e/);
});
