// Emissão assistida pelo Emissor Nacional: para quem não tem certificado A1.
// A API da Receita só aceita o certificado do emitente; o site e o app oficiais
// aceitam usuário/senha ou gov.br. O Nota Sem Stress monta o roteiro com os
// mesmos valores que mandaria na DPS (mesmos pacotes de regras), a pessoa emite
// no site oficial e depois importa o XML da NFS-e para o histórico.
// O app nunca pede nem guarda a senha do Portal ou do gov.br.
import { XMLParser } from 'fast-xml-parser';
import { SignedXml } from 'xml-crypto';
import forge from 'node-forge';
import { municipio, servicoNacional } from './tabelas.js';
import { formatarDocumento, somenteDigitos } from '../util/documentos.js';
import { ErroApp } from '../util/erros.js';

const moedaBr = (v) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const numeroBr = (v) => Number(v).toFixed(2).replace('.', ',');
const dataBr = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
const nomeMunicipio = (ibge) => { const m = municipio(ibge); return m ? `${m.nome} - ${m.uf}` : ''; };
// Campo do roteiro: `valor` é o que aparece; `copiar` é o que vai para a área de transferência
// (sem máscara quando o site já aplica a dele).
const campo = (rotulo, valor, { copiar, ajuda } = {}) => (valor === undefined || valor === null || valor === ''
  ? null : { rotulo, valor: String(valor), copiar: copiar === undefined ? String(valor) : copiar === false ? null : String(copiar), ajuda: ajuda || null });
const secao = (titulo, descricao, campos) => ({ titulo, descricao, campos: campos.filter(Boolean) });

const SIMPLES = { 1: 'Não optante', 2: 'Optante — Microempreendedor Individual (MEI)', 3: 'Optante — Microempresa ou Empresa de Pequeno Porte (ME/EPP)' };
const APURACAO_SN = {
  1: 'Tributos federais e municipal (ISSQN) pelo Simples Nacional',
  2: 'Tributos federais pelo Simples Nacional; ISSQN fora do Simples',
  3: 'Tributos federais e municipal fora do Simples Nacional',
};
const TRIB_ISSQN = { 1: 'Operação tributável', 2: 'Imunidade', 3: 'Exportação de serviço', 4: 'Não incidência' };
const RETENCAO_ISSQN = { 1: 'Não retido', 2: 'Retido pelo tomador', 3: 'Retido pelo intermediário' };
const CST_PIS_COFINS = { '01': '01 — Operação tributável com alíquota básica', '06': '06 — Alíquota zero', '08': '08 — Sem incidência', '09': '09 — Com suspensão' };
const codigoTrib = (c) => (c ? `${c.slice(0, 2)}.${c.slice(2, 4)}.${c.slice(4, 6)}` : '');

/** Roteiro para o Emissor Nacional, a partir do rascunho validado pelos pacotes de regras. */
export function roteiroEmissor({ prestador, nota, validacao }) {
  const r = nota.rascunho || {};
  const ctx = { prestador, nota: r, ...(validacao.contexto || {}) };
  const pacote = validacao.pacote;
  const reg = pacote ? pacote.regTrib(ctx) : { opSimpNac: prestador.opSimpNac };
  const trib = pacote ? pacote.tributacao(ctx) : {};
  const ex = validacao.exigencias || {};
  const t = r.tomador && r.tomador.tipo && r.tomador.tipo !== 'NENHUM' ? r.tomador : null;
  const end = t?.endereco;
  const nac = servicoNacional(r.cTribNac);
  const local = r.localPrestacaoIbge || prestador.municipioIbge;

  const pessoas = secao('Pessoas', 'Primeira tela da emissão: data, emitente e tomador.', [
    campo('Data de competência', dataBr(r.competencia)),
    campo('Emitente (você)', `${prestador.nome || ''} — ${formatarDocumento(prestador.tipoDocumento, prestador.documento)}`, { copiar: prestador.documento, ajuda: 'Confira se o Emissor Nacional abriu nesta empresa. Se você tem acesso a várias, escolha esta antes de começar.' }),
    campo('Situação no Simples Nacional', SIMPLES[reg.opSimpNac], { copiar: false }),
    reg.regApTribSN ? campo('Regime de apuração (Simples)', APURACAO_SN[reg.regApTribSN], { copiar: false }) : null,
    t ? campo('Tomador', t.tipo === 'CNPJ' ? 'Brasil — pessoa jurídica (CNPJ)' : 'Brasil — pessoa física (CPF)', { copiar: false }) : campo('Tomador', 'Não informado', { copiar: false, ajuda: 'Nota sem tomador identificado.' }),
    t ? campo(t.tipo, formatarDocumento(t.tipo, t.documento), { copiar: t.documento }) : null,
    t ? campo('Nome / razão social', t.nome) : null,
    t?.inscricaoMunicipal ? campo('Inscrição municipal do tomador', t.inscricaoMunicipal) : null,
    t?.email ? campo('E-mail do tomador', t.email) : null,
    t?.fone ? campo('Telefone do tomador', t.fone) : null,
    end?.cep ? campo('CEP', end.cep.replace(/^(\d{5})(\d{3})$/, '$1-$2'), { copiar: end.cep }) : null,
    end?.municipioIbge ? campo('Município do tomador', nomeMunicipio(end.municipioIbge), { copiar: municipio(end.municipioIbge)?.nome }) : null,
    end?.logradouro ? campo('Logradouro', end.logradouro) : null,
    end?.numero ? campo('Número', end.numero) : null,
    end?.complemento ? campo('Complemento', end.complemento) : null,
    end?.bairro ? campo('Bairro', end.bairro) : null,
  ]);

  const servico = secao('Serviço', 'Segunda tela: onde foi prestado e qual serviço.', [
    campo('Local da prestação', nomeMunicipio(local), { copiar: municipio(local)?.nome }),
    campo('Código de tributação nacional', nac ? `${codigoTrib(r.cTribNac)} — ${nac.descricao}` : codigoTrib(r.cTribNac), { copiar: codigoTrib(r.cTribNac), ajuda: 'Digite o código ou parte da descrição e escolha na lista do Emissor Nacional.' }),
    r.cTribMun ? campo('Código de tributação municipal', r.cTribMun) : null,
    campo('Descrição do serviço', r.descricao),
    (r.cNBS || ex.ibscbs?.grupo?.cNBS) ? campo('Item da NBS', r.cNBS || ex.ibscbs.grupo.cNBS) : null,
  ]);

  const valores = [
    campo('Valor do serviço prestado', `R$ ${moedaBr(r.valor)}`, { copiar: numeroBr(r.valor) }),
    campo('Tributação do ISSQN', TRIB_ISSQN[trib.tribISSQN] || TRIB_ISSQN[1], { copiar: false }),
    campo('Retenção do ISSQN', RETENCAO_ISSQN[trib.tpRetISSQN] || RETENCAO_ISSQN[1], { copiar: false }),
  ];
  const aliqCadastro = r.pAliq ?? (reg.opSimpNac === '3' ? prestador.aliqIssSN : prestador.aliqIss);
  if (trib.pAliq) valores.push(campo('Alíquota do ISSQN (%)', numeroBr(trib.pAliq)));
  else if (ex.aliquota?.modo === 'indefinida') {
    valores.push(campo('Alíquota do ISSQN', 'Deixe o Emissor Nacional preencher', {
      copiar: aliqCadastro ? numeroBr(aliqCadastro) : false,
      ajuda: `O site usa a alíquota cadastrada pelo município.${aliqCadastro ? ` Se ele pedir, informe ${numeroBr(aliqCadastro)}% (do seu cadastro).` : ''}`,
    }));
  } else if (ex.aliquota?.modo === 'proibida') valores.push(campo('Alíquota do ISSQN', 'Não informar', { copiar: false, ajuda: ex.aliquota.motivo }));

  const pc = trib.tribFed?.piscofins;
  if (pc) {
    valores.push(campo('PIS/COFINS — situação tributária', CST_PIS_COFINS[pc.CST] || pc.CST, { copiar: pc.CST }));
    if (pc.vBCPisCofins) {
      valores.push(campo('Base de cálculo PIS/COFINS', `R$ ${moedaBr(pc.vBCPisCofins)}`, { copiar: numeroBr(pc.vBCPisCofins) }),
        campo('Alíquota do PIS (%)', numeroBr(pc.pAliqPis)), campo('Alíquota da COFINS (%)', numeroBr(pc.pAliqCofins)),
        campo('Valor do PIS', `R$ ${moedaBr(pc.vPis)}`, { copiar: numeroBr(pc.vPis) }), campo('Valor da COFINS', `R$ ${moedaBr(pc.vCofins)}`, { copiar: numeroBr(pc.vCofins) }));
    }
    const rf = r.retencoesFederais || {};
    const retidos = ['pis', 'cofins', 'csll'].filter((k) => rf[k]).map((k) => k.toUpperCase());
    valores.push(campo('PIS/COFINS/CSLL retidos pelo tomador', retidos.length ? retidos.join(', ') : 'Nenhum', { copiar: false }));
    if (trib.tribFed.vRetCSLL) valores.push(campo('Valor retido de PIS/COFINS/CSLL', `R$ ${moedaBr(trib.tribFed.vRetCSLL)}`, { copiar: numeroBr(trib.tribFed.vRetCSLL) }));
    if (trib.tribFed.vRetIRRF) valores.push(campo('IRRF retido', `R$ ${moedaBr(trib.tribFed.vRetIRRF)}`, { copiar: numeroBr(trib.tribFed.vRetIRRF) }));
    if (trib.tribFed.vRetCP) valores.push(campo('Contribuição previdenciária retida', `R$ ${moedaBr(trib.tribFed.vRetCP)}`, { copiar: numeroBr(trib.tribFed.vRetCP) }));
  }
  const tt = trib.totTrib || {};
  if (tt.indTotTrib !== undefined) valores.push(campo('Valor aproximado dos tributos', 'Não informar (MEI)', { copiar: false }));
  else if (tt.pTotTribSN) valores.push(campo('Percentual aproximado dos tributos do Simples (%)', numeroBr(tt.pTotTribSN)));
  else if (tt.pTotTrib) {
    valores.push(campo('Tributos aproximados — federais (%)', numeroBr(tt.pTotTrib.pTotTribFed)),
      campo('Tributos aproximados — estaduais (%)', numeroBr(tt.pTotTrib.pTotTribEst)),
      campo('Tributos aproximados — municipais (%)', numeroBr(tt.pTotTrib.pTotTribMun)));
  }
  const ibs = ex.ibscbs?.grupo;
  if (ibs) {
    valores.push(campo('IBS/CBS — indicador da operação', ibs.cIndOp), campo('IBS/CBS — classificação tributária', `${ibs.cClassTrib} (CST ${ibs.CST})`, { copiar: ibs.cClassTrib }),
      campo('Consumidor final (uso pessoal)', ibs.indFinal === '1' ? 'Sim' : 'Não', { copiar: false }));
  }

  return [pessoas, servico, secao('Valores', 'Terceira tela: valor e tributação. Confira os totais calculados pelo site.', valores),
    secao('Emitir', 'Última tela: confira o resumo, emita e baixe o XML da NFS-e para trazer aqui.', [])];
}

// ---------- Importação do XML emitido no Emissor Nacional ----------
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false });
const txt = (v) => (v === undefined || v === null ? null : String(typeof v === 'object' ? v['#text'] ?? '' : v).trim() || null);
const docDe = (o) => (o?.CNPJ ? { tipo: 'CNPJ', documento: txt(o.CNPJ) } : o?.CPF ? { tipo: 'CPF', documento: txt(o.CPF) } : null);

// A NFS-e vem assinada pela Receita (Signature irmã de infNFSe). Confere a integridade
// com o certificado embutido e devolve quem assinou; não substitui a Consulta Pública.
function assinaturaNfse(xml) {
  const depois = xml.slice(xml.lastIndexOf('infNFSe>'));
  const bloco = depois.match(/<(?:\w+:)?Signature[\s>][\s\S]*?<\/(?:\w+:)?Signature>/)?.[0];
  if (!bloco) return { presente: false };
  const cert64 = bloco.match(/<(?:\w+:)?X509Certificate>([^<]+)</)?.[1]?.replace(/\s+/g, '');
  if (!cert64) return { presente: true, valida: false };
  const pem = `-----BEGIN CERTIFICATE-----\n${cert64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;
  try {
    const v = new SignedXml({ publicCert: pem });
    v.loadSignature(bloco);
    // A assinatura precisa cobrir o infNFSe (e não outro trecho do arquivo).
    const valida = v.checkSignature(xml) && v.getSignedReferences().some((ref) => /infNFSe/.test(ref));
    return { presente: true, valida, titular: forge.pki.certificateFromPem(pem).subject.getField('CN')?.value || null };
  } catch { return { presente: true, valida: false }; }
}

/** Lê e confere o XML da NFS-e; devolve os dados para o histórico e um rascunho equivalente (para clonar). */
export function lerNfseImportada(xml, { exigirAssinatura = true } = {}) {
  if (typeof xml !== 'string' || xml.length < 200 || xml.length > 900_000) throw new ErroApp(422, 'Envie o arquivo XML da NFS-e baixado do Emissor Nacional.');
  let doc;
  try { doc = parser.parse(xml.replace(/^﻿/, '')); } catch { doc = null; }
  const inf = doc?.NFSe?.infNFSe;
  const dps = inf?.DPS?.infDPS;
  const chave = String(inf?.['@Id'] || '').replace(/^NFS/, '');
  if (!inf || !dps || !/^\d{50}$/.test(chave)) throw new ErroApp(422, 'Este arquivo não é o XML de uma NFS-e do padrão nacional. No Emissor Nacional, use "Baixar XML" na nota emitida.');
  const assinatura = assinaturaNfse(xml);
  if (assinatura.presente && !assinatura.valida) throw new ErroApp(422, 'A assinatura deste XML não confere: o arquivo foi alterado depois de emitido. Baixe de novo no Emissor Nacional.');
  if (!assinatura.presente && exigirAssinatura) throw new ErroApp(422, 'Este XML não tem a assinatura da Receita. Baixe o XML da nota emitida no Emissor Nacional (não o da DPS).');

  const toma = dps.toma || {};
  const tomDoc = docDe(toma);
  const end = toma.end || {};
  const vServ = txt(dps.valores?.vServPrest?.vServ);
  const tpRet = txt(dps.valores?.trib?.tribMun?.tpRetISSQN);
  return {
    chaveAcesso: chave,
    nNfse: txt(inf.nNFSe),
    emitidaEm: txt(inf.dhProc) || txt(dps.dhEmi),
    ambiente: txt(dps.tpAmb) === '1' ? 'producao' : 'producao_restrita',
    emitente: docDe(inf.emit) || docDe(dps.prest),
    assinatura,
    rascunho: {
      clienteId: null,
      tomador: tomDoc ? {
        ...tomDoc, nome: txt(toma.xNome) || '', email: txt(toma.email), fone: somenteDigitos(txt(toma.fone)) || null, inscricaoMunicipal: txt(toma.IM),
        endereco: end.endNac ? { cep: somenteDigitos(txt(end.endNac.CEP)), municipioIbge: txt(end.endNac.cMun), logradouro: txt(end.xLgr) || '', numero: txt(end.nro) || '', complemento: txt(end.xCpl) || '', bairro: txt(end.xBairro) || '' } : null,
      } : { tipo: 'NENHUM' },
      servicoId: null,
      cTribNac: txt(dps.serv?.cServ?.cTribNac) || '',
      cTribMun: txt(dps.serv?.cServ?.cTribMun),
      cNBS: txt(dps.serv?.cServ?.cNBS),
      descricao: txt(dps.serv?.cServ?.xDescServ) || '',
      competencia: txt(dps.dCompet) || '',
      valor: vServ ? Number(vServ).toFixed(2) : '',
      localPrestacaoIbge: txt(dps.serv?.locPrest?.cLocPrestacao),
      issRetido: !!tpRet && tpRet !== '1',
      pAliq: txt(dps.valores?.trib?.tribMun?.pAliq),
      revisar: [],
    },
  };
}
