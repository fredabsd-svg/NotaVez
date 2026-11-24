// Montagem do XML da DPS conforme DPS_v1.01.xsd (ordem dos elementos importa).
import { municipio, servicoNacional } from './tabelas.js';

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

// NFS-e substituta (TCSubstituicao): a chave da NFS-e substituída e o motivo. A Receita cancela a original
// (evento 105102, "cancelamento por substituição") ao gerar esta.
function substXml(nota) {
  const s = nota.substituicao;
  if (!s?.chave) return '';
  return `<subst>${el('chSubstda', s.chave)}${el('cMotivo', s.cMotivo)}${el('xMotivo', s.xMotivo)}</subst>`;
}

// Evento de cancelamento (pedRegEvento, e101101): o autor é o próprio emitente (nunca o procurador).
// cMotivo: 1 erro na emissão, 2 serviço não prestado, 9 outros. Id = "PRE" + chave + código do evento.
export const MOTIVOS_CANCELAMENTO = { 1: 'Erro na emissão', 2: 'Serviço não prestado', 9: 'Outros' };
export function montarPedidoCancelamento({ tpAmb, prestador, chave, cMotivo, xMotivo, dhEvento, verAplic }) {
  const Id = `PRE${chave}101101`;
  const autor = prestador.tipoDocumento === 'CPF' ? el('CPFAutor', prestador.documento) : el('CNPJAutor', prestador.documento);
  const xml = '<?xml version="1.0" encoding="UTF-8"?>'
    + `<pedRegEvento xmlns="${NS_NFSE}" versao="${VERSAO_LEIAUTE}"><infPedReg Id="${Id}">`
    + `${el('tpAmb', tpAmb)}${el('verAplic', verAplic)}${el('dhEvento', dhEvento)}${autor}${el('chNFSe', chave)}`
    + `<e101101>${el('xDesc', 'Cancelamento de NFS-e')}${el('cMotivo', cMotivo)}${el('xMotivo', xMotivo)}</e101101>`
    + '</infPedReg></pedRegEvento>';
  return { xml, Id };
}

// Grupo da obra (TCInfoObra): inscImobFisc? e um entre cObra (CNO/CEI), cCIB ou end (CEP, logradouro, número,
// complemento, bairro). Só nos serviços de construção civil (E0370/E0372).
// Endereço do imóvel no Brasil (TCEnderObraEvento), o mesmo na obra e no IBS/CBS.
const endImovelXml = (e = {}) => `<end>${el('CEP', e.cep)}${el('xLgr', e.logradouro)}${el('nro', e.numero)}${el('xCpl', e.complemento)}${el('xBairro', e.bairro)}</end>`;

function obraXml(nota) {
  const o = nota.obra;
  if (!o || servicoNacional(nota.cTribNac)?.grupoExigido !== 'obra') return '';
  const id = o.tipo === 'cno' ? el('cObra', o.cno) : o.tipo === 'cib' ? el('cCIB', o.cib) : endImovelXml(o.endereco);
  return `<obra>${el('inscImobFisc', o.inscImobFisc)}${id}</obra>`;
}

// Imóvel do IBS/CBS (TCRTCInfoImovel): inscImobFisc? e um entre cCIB ou end. Só nas operações com imóveis fora
// da construção civil (E0932/E0931); o grupo chega pronto de resolverIbsCbs.
const imovelXml = (i) => (i ? `<imovel>${el('inscImobFisc', i.inscImobFisc)}${i.cib ? el('cCIB', i.cib) : endImovelXml(i.endereco)}</imovel>` : '');

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
 * @param {object} [p.contexto] contexto das regras (parâmetros municipais já consultados)
 */
export function montarDps({ tpAmb, prestador, nota, pacote, serie, nDPS, dhEmi, verAplic, contexto = {} }) {
  const cLocEmi = prestador.municipioIbge;
  const Id = idDps({ cLocEmi, tipoDocumento: prestador.tipoDocumento, documento: prestador.documento, serie, nDPS });
  const ctx = { prestador, nota, ...contexto };
  const reg = pacote.regTrib(ctx);
  const trib = pacote.tributacao(ctx);
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

  // Grupo IBS/CBS (só pacotes que o exigem). A NBS é obrigatória quando ele é informado (E0322).
  const ibs = pacote.ibscbs ? pacote.ibscbs(ctx) : null;
  const cNBS = nota.cNBS || ibs?.cNBS;

  const serv = `<serv><locPrest>${el('cLocPrestacao', localPrest)}</locPrest>`
    + `<cServ>${el('cTribNac', nota.cTribNac)}${el('cTribMun', nota.cTribMun)}${el('xDescServ', nota.descricao)}${el('cNBS', cNBS)}</cServ>`
    + `${obraXml(nota)}</serv>`;

  // totTrib é um choice: indTotTrib (MEI), pTotTribSN (ME/EPP) ou pTotTrib (não optante) — E0710/E0712/E0713.
  const tt = trib.totTrib;
  const totTrib = tt.indTotTrib !== undefined ? el('indTotTrib', tt.indTotTrib)
    : tt.pTotTrib ? `<pTotTrib>${el('pTotTribFed', tt.pTotTrib.pTotTribFed)}${el('pTotTribEst', tt.pTotTrib.pTotTribEst)}${el('pTotTribMun', tt.pTotTrib.pTotTribMun)}</pTotTrib>`
      : el('pTotTribSN', tt.pTotTribSN);
  const f = trib.tribFed;
  const pc = f?.piscofins;
  const tribFed = f ? `<tribFed>${pc ? `<piscofins>${el('CST', pc.CST)}${el('vBCPisCofins', pc.vBCPisCofins)}${el('pAliqPis', pc.pAliqPis)}${el('pAliqCofins', pc.pAliqCofins)}`
    + `${el('vPis', pc.vPis)}${el('vCofins', pc.vCofins)}${el('tpRetPisCofins', pc.tpRetPisCofins)}</piscofins>` : ''}`
    + `${el('vRetCP', f.vRetCP)}${el('vRetIRRF', f.vRetIRRF)}${el('vRetCSLL', f.vRetCSLL)}</tribFed>` : '';
  const valores = `<valores><vServPrest>${el('vServ', formatarValor(nota.valor))}</vServPrest>`
    + `<trib><tribMun>${el('tribISSQN', trib.tribISSQN)}${el('tpRetISSQN', trib.tpRetISSQN)}${el('pAliq', trib.pAliq)}</tribMun>`
    + `${tribFed}<totTrib>${totTrib}</totTrib></trib></valores>`;

  const ibscbs = ibs ? `<IBSCBS>${el('finNFSe', ibs.finNFSe)}${el('indFinal', ibs.indFinal)}${el('cIndOp', ibs.cIndOp)}${el('indDest', ibs.indDest)}${imovelXml(ibs.imovel)}`
    + `<valores><trib><gIBSCBS>${el('CST', ibs.CST)}${el('cClassTrib', ibs.cClassTrib)}</gIBSCBS></trib></valores></IBSCBS>` : '';

  const xml = '<?xml version="1.0" encoding="UTF-8"?>'
    + `<DPS xmlns="${NS_NFSE}" versao="${VERSAO_LEIAUTE}"><infDPS Id="${Id}">`
    + `${el('tpAmb', tpAmb)}${el('dhEmi', dhEmi)}${el('verAplic', verAplic)}${el('serie', serie)}${el('nDPS', nDPS)}`
    + `${el('dCompet', nota.competencia)}${el('tpEmit', '1')}${el('cLocEmi', cLocEmi)}`
    + substXml(nota)
    + prest + toma + serv + valores + ibscbs
    + '</infDPS></DPS>';
  return { xml, Id };
}
