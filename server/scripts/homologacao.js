// Roteiro de testes no AMBIENTE OFICIAL DE PRODUÇÃO RESTRITA (homologação).
// Sempre tpAmb = 2: notas geradas aqui não têm validade jurídica.
//
// Requisitos (reais, não simulados):
//   - certificado A1 ICP-Brasil (e-CNPJ) de um MEI, arquivo .pfx/.p12;
//   - o CNPJ do certificado deve ser o emitente; município = município do CNPJ.
//
// Uso:
//   NOTAVEZ_CERT_PFX=/caminho/cert.pfx NOTAVEZ_CERT_SENHA='***' \
//   NOTAVEZ_MUNICIPIO_IBGE=3550308 [NOTAVEZ_TOMADOR_CPF=...] [NOTAVEZ_TOMADOR_NOME=...] \
//   [NOTAVEZ_SERIE=900] npm run homologacao
//
// ME/EPP do Simples: acrescente NOTAVEZ_REGIME=me-epp NOTAVEZ_PTOTTRIBSN=6.00
//   [NOTAVEZ_REGAPTRIBSN=1] (o CNPJ precisa ser ME/EPP e o município, conveniado).
//
// Casos: (1) emissão válida; (2) consulta GET /dps/{id}; (3) consulta GET /nfse/{chave};
// (4) reenvio da mesma DPS → E0014; (5) rejeição E0600 (alíquota para MEI);
// (6) rejeição E0015 (competência futura). Gera relatorio-homologacao-*.md.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ambientesSefin } from '../src/config.js';
import { lerCertificado, verificarParaEmitente } from '../src/fiscal/certificado.js';
import { montarDps, dataHoraBrasilia, hojeBrasilia } from '../src/fiscal/dps.js';
import { assinarDps } from '../src/fiscal/assinatura.js';
import { validarXsd } from '../src/fiscal/xsd.js';
import { pacote as pacoteMei } from '../src/fiscal/regras/mei-2026.js';
import { pacote as pacoteMeEpp } from '../src/fiscal/regras/me-epp-2026.js';
import { criarClienteSefin } from '../src/fiscal/sefin/cliente.js';
import { lerNfse } from '../src/fiscal/emissao.js';

const env = (k, obrig = true) => {
  const v = process.env[k];
  if (obrig && !v) { console.error(`Defina ${k}. Veja o cabeçalho de scripts/homologacao.js.`); process.exit(2); }
  return v;
};

const amb = ambientesSefin.producao_restrita;
const info = lerCertificado(readFileSync(env('NOTAVEZ_CERT_PFX')), env('NOTAVEZ_CERT_SENHA'));
const problemas = verificarParaEmitente(info, info.cnpj);
if (problemas.length) { console.error('Certificado inadequado:', problemas); process.exit(2); }

const meEpp = process.env.NOTAVEZ_REGIME === 'me-epp';
const pacote = meEpp ? pacoteMeEpp : pacoteMei;
const prestador = {
  tipoDocumento: 'CNPJ', documento: info.cnpj, municipioIbge: env('NOTAVEZ_MUNICIPIO_IBGE'), opSimpNac: meEpp ? '3' : '2',
  ...(meEpp ? { regApTribSN: process.env.NOTAVEZ_REGAPTRIBSN || '1', pTotTribSN: env('NOTAVEZ_PTOTTRIBSN') } : {}),
};
const serie = process.env.NOTAVEZ_SERIE || '900';
let numero = Number(process.env.NOTAVEZ_NDPS_INICIAL || Math.floor(Date.now() / 1000) % 1e9); // evita colidir com execuções anteriores
const cliente = criarClienteSefin({ baseUrl: amb.sefin, baseParametros: amb.parametros, rotasParametros: ambientesSefin.rotasParametros, ...info });
const nota = {
  competencia: hojeBrasilia(), valor: '10.00', cTribNac: process.env.NOTAVEZ_CTRIBNAC || '010101',
  descricao: 'TESTE DE HOMOLOGACAO NotaVez - sem valor fiscal',
  tomador: process.env.NOTAVEZ_TOMADOR_CPF
    ? { tipo: 'CPF', documento: env('NOTAVEZ_TOMADOR_CPF'), nome: process.env.NOTAVEZ_TOMADOR_NOME || 'Tomador de teste' }
    : null,
};

const resultados = [];
const registrar = (caso, esperado, obtido, ok, extra = '') => {
  resultados.push({ caso, esperado, obtido, ok, extra });
  console.log(`${ok ? 'OK  ' : 'FALHOU'} ${caso}: esperado ${esperado}; obtido ${obtido} ${extra}`);
};

let parametros = {};
async function preparar(n, ajustarXml = (x) => x) {
  numero += 1;
  const { xml, Id } = montarDps({
    tpAmb: amb.tpAmb, prestador, nota: n, pacote, serie, nDPS: numero, dhEmi: dataHoraBrasilia(), verAplic: 'NotaVez-homolog',
    contexto: { parametros, municipioIncidencia: prestador.municipioIbge },
  });
  const assinado = assinarDps(ajustarXml(xml), info);
  const xsd = await validarXsd(assinado);
  if (!xsd.valido) throw new Error(`XSD: ${xsd.erros.join('; ')}`);
  return { Id, assinado };
}

const saida = new URL('../homologacao-saida/', import.meta.url);
mkdirSync(saida, { recursive: true });

// (0) ME/EPP: convênio do município (API de Parâmetros Municipais)
if (meEpp) {
  const c = await cliente.consultarConvenio(prestador.municipioIbge);
  registrar('0. Convênio do município', 'ativo', c.situacao, c.situacao === 'ativo', `HTTP ${c.http ?? '-'} aderenteEmissorNacional=${c.aderenteEmissorNacional}`);
  parametros = { convenioEmissor: c, convenioIncidencia: c };
}

// (1) emissão válida
const d1 = await preparar(nota);
const r1 = await cliente.enviarDps(d1.assinado);
registrar('1. Emissão válida', 'emitida', r1.tipo, r1.tipo === 'emitida', r1.erros ? JSON.stringify(r1.erros) : (r1.chaveAcesso || r1.motivo || ''));
if (r1.tipo === 'emitida') writeFileSync(new URL(`NFSe-${r1.chaveAcesso}.xml`, saida), r1.nfseXml);

// (2) e (3) consultas
const r2 = await cliente.consultarDps(d1.Id);
registrar('2. Consulta DPS', 'encontrada', r2.tipo, r2.tipo === 'encontrada' && (!r1.chaveAcesso || r2.chaveAcesso === r1.chaveAcesso));
if (r2.chaveAcesso) {
  const r3 = await cliente.consultarNfse(r2.chaveAcesso);
  registrar('3. Consulta NFS-e', 'ok', r3.tipo, r3.tipo === 'ok', r3.nfseXml ? `cStat=${lerNfse(r3.nfseXml)?.cStat}` : '');
}

// (4) reenvio idêntico → deve ser recusado como duplicidade
const r4 = await cliente.enviarDps(d1.assinado);
registrar('4. Reenvio da mesma DPS', 'duplicada (E0014)', r4.tipo, r4.tipo === 'duplicada', JSON.stringify(r4.erros || []));

// (5) rejeição: alíquota sem retenção — MEI: E0600; ME/EPP pelo Simples: E0625
const codigo5 = meEpp ? 'E0625' : 'E0600';
const d5 = await preparar(nota, (x) => x.replace('<tpRetISSQN>1</tpRetISSQN>', '<tpRetISSQN>1</tpRetISSQN><pAliq>2.00</pAliq>'));
const r5 = await cliente.enviarDps(d5.assinado);
registrar(`5. Rejeição: alíquota sem retenção (${meEpp ? 'ME/EPP' : 'MEI'})`, `rejeitada ${codigo5}`, `${r5.tipo} ${(r5.erros || []).map((e) => e.codigo).join(',')}`, r5.tipo === 'rejeitada' && r5.erros.some((e) => e.codigo === codigo5));

// (6) rejeição: competência futura (E0015)
const amanha = new Date(Date.now() + 2 * 86400_000);
const d6 = await preparar({ ...nota, competencia: hojeBrasilia(amanha) });
const r6 = await cliente.enviarDps(d6.assinado);
registrar('6. Rejeição competência futura', 'rejeitada E0015', `${r6.tipo} ${(r6.erros || []).map((e) => e.codigo).join(',')}`, r6.tipo === 'rejeitada' && r6.erros.some((e) => e.codigo === 'E0015'));

cliente.fechar();
const quando = new Date().toISOString();
const md = [`# Relatório de homologação NotaVez — ${quando}`, '', `Ambiente: produção restrita (${amb.sefin}), série ${serie}, regime ${meEpp ? "ME/EPP" : "MEI"}.`, '',
  '| Caso | Esperado | Obtido | OK | Detalhe |', '|---|---|---|---|---|',
  ...resultados.map((r) => `| ${r.caso} | ${r.esperado} | ${r.obtido} | ${r.ok ? 'sim' : 'NÃO'} | ${String(r.extra).replace(/\|/g, '/').slice(0, 300)} |`)].join('\n');
writeFileSync(new URL(`relatorio-homologacao-${quando.replace(/[:.]/g, '-')}.md`, saida), md);
console.log(`\nRelatório salvo em homologacao-saida/. ${resultados.every((r) => r.ok) ? 'Todos os casos passaram.' : 'Há casos com falha — veja o relatório.'}`);
process.exit(resultados.every((r) => r.ok) ? 0 : 1);
