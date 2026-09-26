// DANFSe v2.0 gerado localmente, conforme a NT 008 (SE/CGNFS-e) v1.02.
// A API de DANFSe do ADN foi desativada em 03/08/2026; desde então o documento
// auxiliar é responsabilidade de quem emite. Regras seguidas:
//  - fonte única: o XML OFICIAL da NFS-e devolvido pela Sefin (nunca o rascunho);
//  - A4 retrato, uma única página, blocos e campos na ordem e na grade do Anexo I
//    (colunas em 0,30 / 5,41 / 10,51 / 15,62 cm);
//  - cabeçalho com a logomarca da NFS-e, "DANFSe v2.0" e, em homologação
//    (tpAmb = 2), "NFS-e SEM VALIDADE JURÍDICA" em vermelho;
//  - QR Code da Consulta Pública (tpc=1) em X 17,48 / Y 1,67 cm, com ≥ 1,52 cm;
//  - descrições em vez de códigos, reticências nos limites da NT, traço (-) nos
//    campos sem informação e as supressões permitidas no item 2.3;
//  - fontes: Helvetica (métrica equivalente à Arial) nos rótulos e conteúdos,
//    porque Arial e Microsoft Sans Serif não podem ser embutidas livremente.
import { readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { XMLParser } from 'fast-xml-parser';
import { municipio } from '../tabelas.js';
import * as D from './descricoes.js';

const CM = 72 / 2.54;
const LOGO = readFileSync(new URL('./logo-nfse.png', import.meta.url));
const URL_CONSULTA = 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=';

// Grade do Anexo I (cm)
const X0 = 0.30;
const LARG = 20.40;
const COL = [0.30, 5.41, 10.51, 15.62];
const LCOL = 5.09;
const LDUPLA = 10.19;
const LINHA = 0.645;
const TOPO = 0.30;
const BASE = 29.40; // 29,70 − 0,30: sem canhoto (bloco opcional), Informações Complementares vão até aqui

const COR = { texto: '#000000', sombra: '#f2f2f2', vermelho: '#ff0000', marca: '#a6a6a6' };
const F = { rotulo: 'Helvetica-Bold', conteudo: 'Helvetica' };

// ---------- leitura do XML ----------

export function lerXmlNfse(xml) {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, trimValues: true });
  const inf = p.parse(xml)?.NFSe?.infNFSe;
  if (!inf) throw new Error('XML sem NFSe/infNFSe: não é uma NFS-e.');
  return inf;
}

// ---------- formatação ----------

const vazio = (v) => v === undefined || v === null || String(v).trim() === '';
const t = (v) => (vazio(v) ? '-' : String(v));
const num = (v) => (vazio(v) ? null : Number(v));

export function moeda(v) {
  const n = num(v);
  if (n === null || Number.isNaN(n)) return '-';
  return `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function percentual(v) {
  const n = num(v);
  if (n === null || Number.isNaN(n)) return '-';
  return `${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}
const somar = (...vs) => (vs.every(vazio) ? null : vs.reduce((s, v) => s + (num(v) || 0), 0).toFixed(2));

export function data(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '-';
}
// Data e hora como aparecem no XML (horário local do documento, sem conversão).
export function dataHora(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(String(v || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}:${m[6]}` : '-';
}

export function documento(p) {
  if (!p) return '-';
  if (p.CNPJ) return String(p.CNPJ).replace(/^(\w{2})(\w{3})(\w{3})(\w{4})(\w{2})$/, '$1.$2.$3/$4-$5');
  if (p.CPF) return String(p.CPF).replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  if (p.NIF) return String(p.NIF);
  if (p.cNaoNIF) return D.naoNif[p.cNaoNIF] || '-';
  return '-';
}

const cep = (v) => (vazio(v) ? null : String(v).replace(/^(\d{2})(\d{3})(\d{3})$/, '$1.$2-$3'));
const nomeMunicipio = (ibge) => { const m = municipio(ibge); return m ? `${m.nome} / ${m.uf}` : null; };
const reticencias = (s, max) => { const v = t(s); return v.length > max ? `${v.slice(0, max - 3)}...` : v; };

function municipioEndereco(end) {
  if (end?.endNac) return t(nomeMunicipio(end.endNac.cMun));
  if (end?.endExt) return t([end.endExt.xCidade, end.endExt.xEstProvReg, end.endExt.cPais].filter(Boolean).join(' / '));
  return '-';
}
function ibgeCep(end) {
  if (end?.endNac) return [end.endNac.cMun, cep(end.endNac.CEP)].filter(Boolean).join(' / ') || '-';
  if (end?.endExt) return t(end.endExt.cEndPost);
  return '-';
}
const logradouro = (e) => (e ? [e.xLgr, e.nro, e.xCpl, e.xBairro].filter((x) => !vazio(x)).join(', ') : '');

const codTribNac = (c) => (vazio(c) ? null : String(c).replace(/^(\d{2})(\d{2})(\d{2})$/, '$1.$2.$3'));
const codNbs = (c) => (vazio(c) ? '-' : String(c).replace(/^(\d)(\d{4})(\d{2})(\d{2})$/, '$1.$2.$3.$4'));

// ---------- conteúdo (o que vai em cada campo) ----------

export function montarConteudo(inf) {
  const dps = inf.DPS?.infDPS || {};
  const serv = dps.serv || {};
  const cServ = serv.cServ || {};
  const vDps = dps.valores || {};
  const trib = vDps.trib || {};
  const tribMun = trib.tribMun || {};
  const tribFed = trib.tribFed || {};
  const pc = tribFed.piscofins || {};
  const totTrib = trib.totTrib || {};
  const vNfse = inf.valores || {};
  const ibsDps = dps.IBSCBS;
  const ibs = inf.IBSCBS;
  const emit = inf.emit || {};
  const regTrib = dps.prest?.regTrib || {};

  // Prestador: quando o próprio prestador emite, os dados cadastrais vêm em emit
  // (a DPS não repete nome e endereço do emitente).
  const prestadorEhEmitente = String(dps.tpEmit || '1') === '1';
  const prest = { ...(prestadorEhEmitente ? emit : {}), ...(dps.prest || {}) };
  const endPrest = dps.prest?.end || (prestadorEhEmitente && emit.enderNac
    ? { endNac: { cMun: emit.enderNac.cMun, CEP: emit.enderNac.CEP }, ...emit.enderNac } : null);

  const pessoa = (p) => (p ? {
    doc: documento(p), im: t(p.IM), fone: t(p.fone), nome: reticencias(p.xNome, 77),
    municipio: municipioEndereco(p.end), ibgeCep: ibgeCep(p.end), endereco: reticencias(logradouro(p.end), 77), email: reticencias(p.email, 77),
  } : null);

  const cTribNac = cServ.cTribNac;
  const ufIncidIbs = ibs?.cLocalidadeIncid ? municipio(ibs.cLocalidadeIncid)?.uf : null;
  const ret1 = String(pc.tpRetPisCofins ?? '') === '1';
  const competencia = String(dps.dCompet || '');

  // Destinatário (NT 004/008): grupo dest; sem ele, com IBS/CBS e indDest = 0 → o próprio tomador.
  let destinatario = null;
  let destinatarioAviso = 'DESTINATÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e';
  if (ibsDps?.dest) destinatario = pessoa(ibsDps.dest);
  else if (ibsDps && String(ibsDps.indDest ?? '0') === '0' && dps.toma) destinatarioAviso = 'O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO';

  const ufEmit = emit.enderNac?.UF || municipio(dps.cLocEmi)?.uf;
  const item99 = String(cTribNac || '').startsWith('99');

  return {
    cabecalho: {
      municipio: item99 ? null : `Município: ${t(inf.xLocEmi)}${ufEmit ? ` / ${ufEmit}` : ''}`,
      ambGer: `Ambiente Gerador: ${D.ambGer[inf.ambGer] || t(inf.ambGer)}`,
      tpAmb: `Tipo de Ambiente: ${D.tpAmb[dps.tpAmb] || t(dps.tpAmb)}`,
      homologacao: String(dps.tpAmb) === '2',
    },
    chave: String(inf['@Id'] || '').replace(/^NFS/, ''),
    dados: {
      nNFSe: t(inf.nNFSe), dCompet: data(dps.dCompet), dhProc: dataHora(inf.dhProc),
      nDPS: t(dps.nDPS), serie: t(dps.serie), dhEmi: dataHora(dps.dhEmi),
      tpEmit: D.tpEmit[dps.tpEmit] || t(dps.tpEmit),
      cStat: reticencias(D.cStat[inf.cStat] || inf.cStat, 37),
      finNFSe: reticencias(ibsDps ? (D.finNFSe[ibsDps.finNFSe] || ibsDps.finNFSe) : null, 37),
    },
    prestador: {
      ...pessoa({ ...prest, end: endPrest }),
      simples: reticencias(D.opSimpNac[regTrib.opSimpNac], 37),
      regApTribSN: reticencias(D.regApTribSN[regTrib.regApTribSN], 77),
    },
    tomador: pessoa(dps.toma),
    destinatario, destinatarioAviso,
    intermediario: pessoa(dps.interm),
    servico: {
      codigo: [codTribNac(cTribNac), cServ.cTribMun].filter((x) => !vazio(x)).join(' / ') || '-',
      nbs: codNbs(cServ.cNBS),
      local: t([inf.xLocPrestacao, municipio(serv.locPrest?.cLocPrestacao)?.uf, serv.locPrest?.cPaisPrestacao || (serv.locPrest?.cLocPrestacao ? 'BR' : null)].filter((x) => !vazio(x)).join(' / ')),
      descricaoCodigo: reticencias(vazio(inf.xTribMun) ? inf.xTribNac : inf.xTribMun, 167),
      descricao: reticencias(cServ.xDescServ, 1297),
    },
    // Nota 4: sem incidência do ISSQN → uma linha só.
    issqn: String(tribMun.tribISSQN) === '4' ? null : {
      tribISSQN: D.tribISSQN[tribMun.tribISSQN] || t(tribMun.tribISSQN),
      incidencia: t([inf.xLocIncid, municipio(inf.cLocIncid)?.uf, tribMun.cPaisResult || (inf.cLocIncid ? 'BR' : null)].filter((x) => !vazio(x)).join(' / ')),
      linha2: [
        D.regEspTrib[regTrib.regEspTrib] || t(regTrib.regEspTrib),
        reticencias(D.tpImunidade[tribMun.tpImunidade], 37),
        reticencias(D.tpSusp[tribMun.exigSusp?.tpSusp], 37),
        t(tribMun.exigSusp?.nProcesso),
      ],
      mostrarLinha2: !vazio(tribMun.tpImunidade) || !vazio(tribMun.exigSusp?.tpSusp) || (!vazio(regTrib.regEspTrib) && String(regTrib.regEspTrib) !== '0'),
      linha3: [
        reticencias(D.tpBM[vNfse.tpBM], 37),
        moeda(vNfse.vCalcBM ?? tribMun.BM?.vRedBCBM),
        moeda(somar(vNfse.vCalcDR ?? vDps.vDedRed?.vDR, ibs?.valores?.vCalcReeRepRes)),
        moeda(vDps.vDescCondIncond?.vDescIncond),
      ],
      mostrarLinha3: [vNfse.tpBM, vNfse.vCalcBM, tribMun.BM, vNfse.vCalcDR, vDps.vDedRed, vDps.vDescCondIncond?.vDescIncond].some((x) => !vazio(x)),
      bc: moeda(vNfse.vBC), aliquota: percentual(vNfse.pAliqAplic),
      retencao: D.tpRetISSQN[tribMun.tpRetISSQN] || t(tribMun.tpRetISSQN), apurado: moeda(vNfse.vISSQN),
    },
    federal: {
      irrf: moeda(tribFed.vRetIRRF), cp: moeda(tribFed.vRetCP),
      contribuicoes: moeda(ret1 ? somar(tribFed.vRetCSLL, pc.vPis, pc.vCofins) : tribFed.vRetCSLL),
      // Nota 6: linha do PIS/COFINS próprio só para competências até 2026.
      mostrarPisCofins: !competencia || competencia <= '2026-12-31',
      pis: ret1 ? moeda(0) : moeda(pc.vPis), cofins: ret1 ? moeda(0) : moeda(pc.vCofins),
      descricao: reticencias(D.tpRetPisCofins[pc.tpRetPisCofins], 37),
    },
    ibscbs: {
      cst: [ibsDps?.valores?.trib?.gIBSCBS?.CST, ibsDps?.valores?.trib?.gIBSCBS?.cClassTrib].filter((x) => !vazio(x)).join(' / ') || '-',
      operacao: [ibsDps?.cIndOp, ibs?.cLocalidadeIncid, ibs?.xLocalidadeIncid, ufIncidIbs].filter((x) => !vazio(x)).join(' / ') || '-',
      exclusoes: ibs ? moeda(somar(vDps.vDescCondIncond?.vDescIncond, ibs.valores?.vCalcReeRepRes, vNfse.vISSQN, pc.vPis, pc.vCofins)) : '-',
      bc: moeda(ibs?.valores?.vBC),
      reducoes: ibs ? [ibs.valores?.uf?.pRedAliqUF, ibs.valores?.mun?.pRedAliqMun, ibs.valores?.fed?.pRedAliqCBS].map(percentual).join(' / ') : '-',
      aliqIbs: ibs ? [ibs.valores?.uf?.pIBSUF, ibs.valores?.mun?.pIBSMun].map(percentual).join(' / ') : '-',
      efetMun: percentual(ibs?.valores?.mun?.pAliqEfetMun), vIBSMun: moeda(ibs?.totCIBS?.gIBS?.gIBSMunTot?.vIBSMun),
      efetUF: percentual(ibs?.valores?.uf?.pAliqEfetUF), vIBSUF: moeda(ibs?.totCIBS?.gIBS?.gIBSUFTot?.vIBSUF),
      vIBSTot: moeda(ibs?.totCIBS?.gIBS?.vIBSTot), pCBS: percentual(ibs?.valores?.fed?.pCBS),
      efetCBS: percentual(ibs?.valores?.fed?.pAliqEfetCBS), vCBS: moeda(ibs?.totCIBS?.gCBS?.vCBS),
    },
    totais: {
      vServ: moeda(vDps.vServPrest?.vServ), descIncond: moeda(vDps.vDescCondIncond?.vDescIncond), descCond: moeda(vDps.vDescCondIncond?.vDescCond),
      vTotalRet: moeda(vNfse.vTotalRet), vLiq: moeda(vNfse.vLiq),
      totalIbsCbs: ibs ? moeda(somar(ibs.totCIBS?.gIBS?.vIBSTot, ibs.totCIBS?.gCBS?.vCBS)) : '-',
      vTotNF: moeda(ibs?.totCIBS?.vTotNF),
    },
    informacoes: informacoesComplementares(inf, dps, totTrib),
  };
}

// Item 2.4.5 (Informações Complementares): ordem fixa, separadas por " | ",
// e a linha de totais aproximados (Lei 12.741/2012) sempre presente.
function informacoesComplementares(inf, dps, totTrib) {
  const serv = dps.serv || {};
  const ic = serv.infoCompl || {};
  const itens = [
    ['Inf. Cont.', ic.xInfComp],
    ['NFS-e Subst.', dps.subst?.chSubstda],
    ['Doc. Ref.', ic.docRef],
    ['Cod. Obra', serv.obra?.cObra],
    ['Insc. Imob.', serv.obra?.inscImobFisc ?? dps.IBSCBS?.imovel?.inscImobFisc],
    ['Cod. Evt.', serv.atvEvento?.idAtvEvt],
    ['Doc. Tec.', ic.idDocTec],
    ['Núm. Ped.', ic.xPed],
    ['Item Ped.', [].concat(ic.gItemPed?.xItemPed || []).join(', ')],
    ['Inf. A. T. Mun.', inf.xOutInf],
  ].filter(([, v]) => !vazio(v)).map(([r, v]) => `${r}: ${v}`);

  const lei = 'Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012:';
  let totais;
  if (totTrib.vTotTrib) {
    const v = totTrib.vTotTrib;
    totais = `${lei} Federais: ${moeda(v.vTotTribFed)} ; Estaduais: ${moeda(v.vTotTribEst)} ; Municipais: ${moeda(v.vTotTribMun)}`;
  } else if (totTrib.pTotTrib) {
    const p = totTrib.pTotTrib;
    totais = `${lei} Federais: ${percentual(p.pTotTribFed)} ; Estaduais: ${percentual(p.pTotTribEst)} ; Municipais: ${percentual(p.pTotTribMun)}`;
  } else if (!vazio(totTrib.pTotTribSN)) {
    totais = `${lei} Simples Nacional: ${percentual(totTrib.pTotTribSN)}`;
  } else {
    totais = `${lei} Federais: - ; Estaduais: - ; Municipais: -`;
  }
  return { texto: vazio(itens.join('')) ? '' : reticencias(itens.join(' | '), 1997), totais };
}

// ---------- desenho ----------

class Pagina {
  constructor(doc) { this.doc = doc; }

  caixa(x, y, w, h, { sombra = false } = {}) {
    if (sombra) this.doc.save().rect(x * CM, y * CM, w * CM, h * CM).fill(COR.sombra).restore();
  }

  linhaH(y) {
    this.doc.save().lineWidth(0.5).strokeColor(COR.texto)
      .moveTo(X0 * CM, y * CM).lineTo((X0 + LARG) * CM, y * CM).stroke().restore();
  }

  texto(s, x, y, w, { fonte = F.conteudo, tam = 7, cor = COR.texto, alinhar = 'left', altura, linhas = 1 } = {}) {
    const d = this.doc.font(fonte).fontSize(tam).fillColor(cor);
    const opc = { width: w * CM, align: alinhar, lineGap: 0.4, ellipsis: '...' };
    // Sem quebra de página: tudo cabe em caixas de altura fixa.
    opc.height = altura ? altura * CM : (tam * 1.2 * linhas);
    if (linhas === 1 && !altura) opc.lineBreak = false;
    d.text(String(s ?? '-'), x * CM, y * CM, opc);
  }

  // Campo da grade: rótulo (6 pt negrito, Title Case) e conteúdo (7 pt).
  campo(rotulo, valor, x, y, w, { h = LINHA, sombra = false, rotuloCaixaAlta = false, linhas = 1 } = {}) {
    this.caixa(x, y, w, h, { sombra });
    this.texto(rotulo, x + 0.08, y + 0.05, w - 0.16, { fonte: F.rotulo, tam: rotuloCaixaAlta ? 7 : 6 });
    this.texto(valor, x + 0.08, y + (rotuloCaixaAlta ? 0.36 : 0.31), w - 0.16, linhas > 1 ? { altura: h - 0.36, linhas } : {});
  }

  // Título do bloco: primeira célula da primeira linha, 7 pt negrito caixa alta, sombreado.
  titulo(s, y, h = LINHA) {
    this.caixa(COL[0], y, LCOL, h, { sombra: true });
    this.texto(s, COL[0] + 0.08, y + 0.05, LCOL - 0.16, { fonte: F.rotulo, tam: 7, altura: h - 0.08, linhas: 2 });
  }

  // Bloco suprimido (Notas 2, 3 e 4): uma linha com a frase oficial.
  aviso(s, y) {
    const h = 0.40;
    this.caixa(X0, y, LARG, h, { sombra: true });
    this.texto(s, X0 + 0.08, y + 0.12, LARG - 0.16, { fonte: F.rotulo, tam: 7 });
    return y + h;
  }
}

async function desenharQr(doc, url, x, y, lado) {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const m = (lado * CM) / n;
  doc.save().fillColor('#000000');
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (qr.modules.get(r, c)) doc.rect(x * CM + c * m, y * CM + r * m, m + 0.05, m + 0.05);
    }
  }
  doc.fill().restore();
}

function blocoPessoa(pg, titulo, p, y, { fone = true, im = true } = {}) {
  pg.linhaH(y);
  pg.titulo(titulo, y);
  pg.campo('CNPJ / CPF / NIF', p.doc, COL[1], y, LCOL);
  if (im) pg.campo('Indicador Municipal', p.im, COL[2], y, LCOL);
  if (fone) pg.campo('Telefone', p.fone, COL[3], y, LCOL);
  y += LINHA;
  pg.campo('Nome / Nome Empresarial', p.nome, COL[0], y, LDUPLA);
  pg.campo('Município / Sigla UF', p.municipio, COL[2], y, LCOL);
  pg.campo('Código IBGE / CEP', p.ibgeCep, COL[3], y, LCOL);
  y += LINHA;
  pg.campo('Endereço', p.endereco, COL[0], y, LDUPLA);
  pg.campo('E-mail', p.email, COL[2], y, LDUPLA);
  return y + LINHA;
}

/**
 * Gera o PDF do DANFSe a partir do XML oficial da NFS-e.
 * @param {string} xml XML da NFS-e (NFSe/infNFSe) como devolvido pela Sefin Nacional
 * @param {{ marcaDagua?: string }} opcoes marca d'água diagonal (item 2.5): "CANCELADA",
 *   "SUBSTITUÍDA" ou, no modo demonstração, "SIMULAÇÃO"
 * @returns {Promise<Buffer>}
 */
export async function gerarDanfse(xml, { marcaDagua = null } = {}) {
  const inf = lerXmlNfse(xml);
  const c = montarConteudo(inf);
  if (!/^\d{50}$/.test(c.chave)) throw new Error('Chave de acesso ausente ou inválida no XML da NFS-e.');

  const doc = new PDFDocument({
    size: 'A4', layout: 'portrait', margin: 0, autoFirstPage: true, compress: true,
    info: { Title: `DANFSe ${c.chave}`, Subject: 'Documento Auxiliar da NFS-e', Creator: 'Nota Sem Stress', Producer: 'Nota Sem Stress' },
  });
  const partes = [];
  doc.on('data', (b) => partes.push(b));
  const fim = new Promise((ok, erro) => { doc.on('end', ok); doc.on('error', erro); });
  const pg = new Pagina(doc);

  // Borda da página (1 pt)
  doc.save().lineWidth(1).strokeColor(COR.texto).rect(X0 * CM, TOPO * CM, LARG * CM, (BASE - TOPO) * CM).stroke().restore();

  // Cabeçalho (sombreado)
  pg.caixa(X0, TOPO, LARG, 1.16, { sombra: true });
  doc.image(LOGO, 0.49 * CM, 0.44 * CM, { fit: [4.00 * CM, 0.85 * CM], valign: 'center' });
  pg.texto('DANFSe v2.0', 5.41, 0.42, LDUPLA, { fonte: F.rotulo, tam: 9, alinhar: 'center' });
  pg.texto('Documento Auxiliar da NFS-e', 5.41, 0.78, LDUPLA, { fonte: F.rotulo, tam: 9, alinhar: 'center' });
  if (c.cabecalho.homologacao) pg.texto('NFS-e SEM VALIDADE JURÍDICA', 5.41, 1.12, LDUPLA, { fonte: F.rotulo, tam: 9, cor: COR.vermelho, alinhar: 'center' });
  if (c.cabecalho.municipio) pg.texto(c.cabecalho.municipio, 15.62, 0.42, LCOL - 0.1, { tam: 8 });
  pg.texto(c.cabecalho.ambGer, 15.62, 0.97, LCOL - 0.1, { tam: 6 });
  pg.texto(c.cabecalho.tpAmb, 15.62, 1.22, LCOL - 0.1, { tam: 6 });

  // Dados da NFS-e (rótulos 7 pt caixa alta) + QR Code
  let y = 1.48;
  pg.linhaH(y);
  pg.campo('CHAVE DE ACESSO DA NFS-E', c.chave, COL[0], y, 15.30, { h: 0.77, rotuloCaixaAlta: true });
  y = 2.27;
  const d = c.dados;
  const linhasDados = [
    [['NÚMERO DA NFS-E', d.nNFSe], ['COMPETÊNCIA DA NFS-E', d.dCompet], ['DATA E HORA DA EMISSÃO DA NFS-E', d.dhProc]],
    [['NÚMERO DA DPS', d.nDPS], ['SÉRIE DA DPS', d.serie], ['DATA E HORA DA EMISSÃO DA DPS', d.dhEmi]],
    [['EMITENTE DA NFS-E', d.tpEmit, true], ['SITUAÇÃO DA NFS-E', d.cStat], ['FINALIDADE', d.finNFSe]],
  ];
  for (const linha of linhasDados) {
    linha.forEach(([r, v, sombra], i) => pg.campo(r, v, COL[i], y, LCOL, { h: 0.69, rotuloCaixaAlta: true, sombra: !!sombra }));
    y += 0.69;
  }
  await desenharQr(doc, `${URL_CONSULTA}${c.chave}`, 17.48, 1.67, 1.60);
  pg.texto('A autenticidade desta NFS-e pode ser verificada pela leitura deste código QR ou pela consulta da chave de acesso no portal nacional da NFS-e',
    15.80, 3.33, 4.72, { tam: 6, alinhar: 'center', linhas: 3, altura: 0.95 });
  y = 4.34;

  // Prestador / Fornecedor
  const p = c.prestador;
  y = blocoPessoa(pg, 'PRESTADOR / FORNECEDOR', p, y);
  pg.campo('Simples Nacional na Data de Competência', p.simples, COL[0], y, LCOL);
  pg.campo('Regime de Apuração Tributária pelo SN', p.regApTribSN, COL[2], y, LDUPLA);
  y += LINHA;

  // Tomador / Adquirente, Destinatário, Intermediário (supressões dos itens 2.3.1 e 2.3.2)
  if (c.tomador) y = blocoPessoa(pg, 'TOMADOR / ADQUIRENTE', c.tomador, y);
  else { pg.linhaH(y); y = pg.aviso('TOMADOR/ADQUIRENTE DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e', y); }
  if (c.destinatario) y = blocoPessoa(pg, 'DESTINATÁRIO DA OPERAÇÃO', c.destinatario, y, { im: false });
  else { pg.linhaH(y); y = pg.aviso(c.destinatarioAviso, y); }
  if (c.intermediario) y = blocoPessoa(pg, 'INTERMEDIÁRIO DA OPERAÇÃO', c.intermediario, y);
  else { pg.linhaH(y); y = pg.aviso('INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e', y); }

  // Serviço prestado
  const s = c.servico;
  pg.linhaH(y);
  pg.titulo('SERVIÇO PRESTADO', y);
  pg.campo('Código de Tributação Nacional / Municipal', s.codigo, COL[1], y, LCOL);
  pg.campo('Código da NBS', s.nbs, COL[2], y, LCOL);
  pg.campo('Local da Prestação / Sigla UF / País', s.local, COL[3], y, LCOL);
  y += LINHA;
  pg.texto(s.descricaoCodigo, X0 + 0.08, y + 0.08, LARG - 0.16, { tam: 7 });
  y += 0.38;
  const yDescricao = y;

  // A partir daqui, os blocos têm altura fixa; a descrição do serviço e as
  // informações complementares dividem o espaço que sobra (item 2.3).
  const iss = c.issqn;
  const alturaIss = iss ? LINHA * (2 + (iss.mostrarLinha2 ? 1 : 0) + (iss.mostrarLinha3 ? 1 : 0)) : 0.40;
  const alturaFederal = LINHA * (c.federal.mostrarPisCofins ? 2 : 1);
  const alturaFixa = alturaIss + alturaFederal + LINHA * 4 + 0.69 * 2;
  const alturaInfoTitulo = 0.39;
  const livre = BASE - yDescricao - alturaFixa - alturaInfoTitulo;

  doc.font(F.conteudo).fontSize(7);
  const medir = (texto) => (doc.heightOfString(texto, { width: (LARG - 0.16) * CM, lineGap: 0.4 }) / CM) + 0.40;
  const precisaInfo = medir(`${c.informacoes.texto}\n${c.informacoes.totais}`) + 0.1;
  const minInfo = Math.min(Math.max(precisaInfo, 1.2), livre - LINHA);
  let alturaDescricao = Math.max(LINHA, Math.min(medir(s.descricao), livre - minInfo));
  const alturaInfo = livre - alturaDescricao;

  pg.campo('Descrição do Serviço', s.descricao, COL[0], y, LARG, { h: alturaDescricao, linhas: 40 });
  y += alturaDescricao;

  // Tributação municipal (ISSQN)
  pg.linhaH(y);
  if (!iss) y = pg.aviso('TRIBUTAÇÃO MUNICIPAL (ISSQN) - OPERAÇÃO NÃO SUJEITA AO ISSQN', y);
  else {
    pg.titulo('TRIBUTAÇÃO MUNICIPAL (ISSQN)', y);
    pg.campo('Tipo de Tributação do ISSQN', iss.tribISSQN, COL[1], y, LCOL);
    pg.campo('Município / Sigla UF / País da Incidência do ISSQN', iss.incidencia, COL[2], y, LDUPLA);
    y += LINHA;
    if (iss.mostrarLinha2) {
      ['Regime Especial de Tributação do ISSQN', 'Tipo de Imunidade do ISSQN', 'Suspensão da Exigibilidade do ISSQN', 'Número Processo Suspensão']
        .forEach((r, i) => pg.campo(r, iss.linha2[i], COL[i], y, LCOL));
      y += LINHA;
    }
    if (iss.mostrarLinha3) {
      ['Benefício Municipal', 'Cálculo do BM', 'Total Deduções/Reduções', 'Desconto Incondicionado']
        .forEach((r, i) => pg.campo(r, iss.linha3[i], COL[i], y, LCOL));
      y += LINHA;
    }
    pg.campo('BC ISSQN', iss.bc, COL[0], y, LCOL);
    pg.campo('Alíquota Aplicada', iss.aliquota, COL[1], y, LCOL);
    pg.campo('Retenção do ISSQN', iss.retencao, COL[2], y, LCOL);
    pg.campo('ISSQN Apurado', iss.apurado, COL[3], y, LCOL);
    y += LINHA;
  }

  // Tributação federal (exceto CBS)
  const f = c.federal;
  pg.linhaH(y);
  pg.titulo('TRIBUTAÇÃO FEDERAL (EXCETO CBS)', y);
  pg.campo('IRRF', f.irrf, COL[1], y, LCOL);
  pg.campo('Contribuição Previdenciária - Retida', f.cp, COL[2], y, LCOL);
  pg.campo('Contribuições Sociais - Retidas', f.contribuicoes, COL[3], y, LCOL);
  y += LINHA;
  if (f.mostrarPisCofins) {
    pg.campo('PIS - Débito Apuração Própria', f.pis, COL[0], y, LCOL);
    pg.campo('COFINS - Débito Apuração Própria', f.cofins, COL[1], y, LCOL);
    pg.campo('Descrição Contrib. Sociais - Retidas', f.descricao, COL[2], y, LDUPLA);
    y += LINHA;
  }

  // Tributação IBS / CBS
  const b = c.ibscbs;
  pg.linhaH(y);
  pg.titulo('TRIBUTAÇÃO IBS / CBS', y);
  pg.campo('CST / cClassTrib', b.cst, COL[1], y, LCOL);
  pg.campo('Indicador de Operação / Código IBGE Incidência / Município Incidência / Sigla UF', b.operacao, COL[2], y, LDUPLA);
  y += LINHA;
  [['Exclusões e Reduções da Base de Cálculo', b.exclusoes], ['Base de Cálculo Após Exclusões e Reduções', b.bc], ['Red. Alíquota IBS UF / Mun / CBS', b.reducoes], ['Alíquota - IBS UF / IBS Mun', b.aliqIbs]]
    .forEach(([r, v], i) => pg.campo(r, v, COL[i], y, LCOL));
  y += LINHA;
  [['Alíq. Efetiva Municipal - IBS', b.efetMun], ['Valor Apurado Municipal - IBS', b.vIBSMun], ['Alíq. Efetiva Estadual - IBS', b.efetUF], ['Valor Apurado Estadual - IBS', b.vIBSUF]]
    .forEach(([r, v], i) => pg.campo(r, v, COL[i], y, LCOL));
  y += LINHA;
  [['Valor Total Apurado - IBS', b.vIBSTot], ['Alíquota - CBS', b.pCBS], ['Alíquota Efetiva - CBS', b.efetCBS], ['Valor Total Apurado - CBS', b.vCBS]]
    .forEach(([r, v], i) => pg.campo(r, v, COL[i], y, LCOL));
  y += LINHA;

  // Valor total da NFS-e
  const v = c.totais;
  pg.linhaH(y);
  pg.titulo('VALOR TOTAL DA NFS-E', y, 0.69);
  pg.campo('Valor da Operação / Serviço', v.vServ, COL[1], y, LCOL, { h: 0.69 });
  pg.campo('Desconto Incondicionado', v.descIncond, COL[2], y, LCOL, { h: 0.69 });
  pg.campo('Desconto Condicionado', v.descCond, COL[3], y, LCOL, { h: 0.69 });
  y += 0.69;
  pg.campo('Total das Retenções (ISSQN / Federais)', v.vTotalRet, COL[0], y, LCOL, { h: 0.69 });
  pg.campo('Valor Líquido da NFS-e', v.vLiq, COL[1], y, LCOL, { h: 0.69 });
  pg.campo('Total do IBS/CBS', v.totalIbsCbs, COL[2], y, LCOL, { h: 0.69 });
  pg.campo('Valor Líquido da NFS-e + IBS/CBS', v.vTotNF, COL[3], y, LCOL, { h: 0.69, sombra: true });
  y += 0.69;

  // Informações complementares (a linha de totais aproximados é fixa: nunca é cortada)
  pg.linhaH(y);
  pg.caixa(X0, y, LARG, alturaInfoTitulo, { sombra: true });
  pg.texto('INFORMAÇÕES COMPLEMENTARES', X0 + 0.08, y + 0.11, LARG - 0.16, { fonte: F.rotulo, tam: 7 });
  y += alturaInfoTitulo;
  pg.linhaH(y);
  const alturaTotais = medir(c.informacoes.totais) - 0.30;
  let yTotais = y + 0.08;
  if (c.informacoes.texto) {
    const alturaTexto = Math.min(medir(c.informacoes.texto) - 0.30, Math.max(0.3, alturaInfo - alturaTotais - 0.25));
    pg.texto(c.informacoes.texto, X0 + 0.08, y + 0.08, LARG - 0.16, { altura: alturaTexto, linhas: 40 });
    yTotais = y + 0.08 + alturaTexto + 0.08;
  }
  pg.texto(c.informacoes.totais, X0 + 0.08, yTotais, LARG - 0.16, { altura: alturaTotais + 0.05, linhas: 3 });

  // Marca d'água diagonal (item 2.5): 50 pt, cinza K35
  if (marcaDagua) {
    doc.save().rotate(-50, { origin: [10.5 * CM, 14.85 * CM] }).font(F.conteudo).fontSize(96).fillColor(COR.marca).fillOpacity(0.55)
      .text(marcaDagua, -4 * CM, 14.85 * CM - 48, { width: 29 * CM, align: 'center', lineBreak: false }).restore();
  }

  doc.end();
  await fim;
  return Buffer.concat(partes);
}
