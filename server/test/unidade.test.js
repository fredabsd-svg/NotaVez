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
  assert.match(escolherPacote({ opSimpNac: '3', competencia: '2026-09-01' }).motivo, /apenas para MEI/);
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
