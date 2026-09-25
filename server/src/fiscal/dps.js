// Montagem do XML da DPS conforme DPS_v1.01.xsd (ordem dos elementos importa).
import { municipio } from './tabelas.js';

export const NS_NFSE = 'http://www.sped.fazenda.gov.br/nfse';
export const VERSAO_LEIAUTE = '1.01';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
// Remove caracteres de controle proibidos pelo XML e espaços nas pontas.
const limpo = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
const el = (nome, valor) => (valor === undefined || valor === null || valor === '' ? '' : `<${nome}>${esc(limpo(valor))}</${nome}>`);

// Identificador de 45 posições: "DPS" + cLocEmi(7) + tpInsc(1) + inscrição(14) + série(5) + nDPS(15).
export function idDps({ cLocEmi, tipoDocumento, documento, serie, nDPS }) {
  const tpInsc = tipoDocumento === 'CPF' ? '1' : '2';
  const insc = tipoDocumento === 'CPF' ? documento.padStart(14, '0') : documento;
  return `DPS${cLocEmi}${tpInsc}${insc}${String(serie).padStart(5, '0')}${String(nDPS).padStart(15, '0')}`;
}

// Data/hora no fuso de Brasília (sem horário de verão desde 2019). Recuamos
// 60 s para respeitar E0008 (dhEmi ≤ dhProc) mesmo com relógio adiantado.
export function dataHoraBrasilia(d = new Date(), recuoMs = 60_000) {
  const t = new Date(d.getTime() - recuoMs - 3 * 3600_000);
  return `${t.toISOString().slice(0, 19)}-03:00`;
}
export const hojeBrasilia = (d = new Date()) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 10);

export const formatarValor = (v) => Number(v).toFixed(2);

function enderecoXml(en) {
  if (!en) return '';
  return `<end><endNac>${el('cMun', en.municipioIbge)}${el('CEP', en.cep)}</endNac>${el('xLgr', en.logradouro)}${el('nro', en.numero)}${el('xCpl', en.complemento)}${el('xBairro', en.bairro)}</end>`;
}

/**
 * @param {object} p
 * @param {'1'|'2'} p.tpAmb
 * @param {object} p.prestador {tipoDocumento, documento, municipioIbge, inscricaoMunicipal, email, fone}
 * @param {object} p.nota      rascunho validado
 * @param {object} p.pacote    pacote de regras (tributação/regime)
 */
export function montarDps({ tpAmb, prestador, nota, pacote, serie, nDPS, dhEmi, verAplic }) {
  const cLocEmi = prestador.municipioIbge;
  const Id = idDps({ cLocEmi, tipoDocumento: prestador.tipoDocumento, documento: prestador.documento, serie, nDPS });
  const reg = pacote.regTrib();
  const trib = pacote.tributacao();
  const t = nota.tomador && nota.tomador.tipo && nota.tomador.tipo !== 'NENHUM' ? nota.tomador : null;
  const localPrest = nota.localPrestacaoIbge || cLocEmi;
  if (!municipio(localPrest)) throw new Error('Local da prestação inválido');

  // E0121: com tpEmit = 1 o nome do prestador NÃO é informado (vem do cadastro CNPJ).
  const prest = `<prest>${el(prestador.tipoDocumento, prestador.documento)}${el('IM', prestador.inscricaoMunicipal)}`
    + `${el('fone', prestador.fone)}${el('email', prestador.email)}`
    + `<regTrib>${el('opSimpNac', reg.opSimpNac)}${el('regApTribSN', reg.regApTribSN)}${el('regEspTrib', reg.regEspTrib)}</regTrib></prest>`;

  const toma = t
    ? `<toma>${el(t.tipo, t.documento)}${el('IM', t.inscricaoMunicipal)}${el('xNome', t.nome)}`
      + `${t.endereco && t.endereco.cep ? enderecoXml(t.endereco) : ''}${el('fone', t.fone)}${el('email', t.email)}</toma>`
    : '';

  const serv = `<serv><locPrest>${el('cLocPrestacao', localPrest)}</locPrest>`
    + `<cServ>${el('cTribNac', nota.cTribNac)}${el('cTribMun', nota.cTribMun)}${el('xDescServ', nota.descricao)}${el('cNBS', nota.cNBS)}</cServ></serv>`;

  const totTrib = trib.totTrib.indTotTrib !== undefined ? el('indTotTrib', trib.totTrib.indTotTrib) : '';
  const valores = `<valores><vServPrest>${el('vServ', formatarValor(nota.valor))}</vServPrest>`
    + `<trib><tribMun>${el('tribISSQN', trib.tribISSQN)}${el('tpRetISSQN', trib.tpRetISSQN)}${el('pAliq', trib.pAliq)}</tribMun>`
    + `<totTrib>${totTrib}</totTrib></trib></valores>`;

  const xml = '<?xml version="1.0" encoding="UTF-8"?>'
    + `<DPS xmlns="${NS_NFSE}" versao="${VERSAO_LEIAUTE}"><infDPS Id="${Id}">`
    + `${el('tpAmb', tpAmb)}${el('dhEmi', dhEmi)}${el('verAplic', verAplic)}${el('serie', serie)}${el('nDPS', nDPS)}`
    + `${el('dCompet', nota.competencia)}${el('tpEmit', '1')}${el('cLocEmi', cLocEmi)}`
    + prest + toma + serv + valores
    + '</infDPS></DPS>';
  return { xml, Id };
}
