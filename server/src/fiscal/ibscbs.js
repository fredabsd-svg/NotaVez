// Grupo IBS/CBS da DPS (leiaute RTC — Anexo VI; NT 004/005/007).
// Na DPS o grupo é DECLARATIVO: o emitente informa a classificação da operação
// (finalidade, indicador de operação, destinatário, CST e cClassTrib) e a Sefin
// calcula base, alíquotas e valores com a calculadora oficial.
//
// As opções vêm das tabelas oficiais: Anexo VIII (item LC 116 × NBS × cIndOp ×
// cClassTrib) e Anexo VII (códigos cIndOp válidos). Nada é inventado: serviço
// sem correlação oficial não recebe o grupo, e o usuário é avisado.
import { readFileSync } from 'node:fs';
import { conferirIdentificacaoImovel } from './regras/comum.js';

const dados = JSON.parse(readFileSync(new URL('../data/ibscbs-correlacao.json', import.meta.url), 'utf8'));

// Prazos do Ato Conjunto RFB/CGIBS nº 4/2026, alterado pelo Ato Conjunto nº 7/2026 (art. 1º, III), para quem
// não é do Simples: serviços da LC 116 em geral a partir de 01/10/2026 (alínea "d"); subitens 1.03, 1.05, 1.09 e
// 16.01 e plataformas digitais a partir de 01/03/2027 (alíneas "a" a "c"); bens imateriais, condomínios,
// locações e demais fornecimentos fora da LC 116 (códigos 99) a partir de 01/01/2027 (alíneas "e" a "h").
// Simples Nacional (§ 1º): 01/01/2027 (alíneas "d" a "h") e 01/03/2027 (alíneas "a" a "c").
// Até 31/12/2026 a ausência não gera rejeição, mas deixa o documento em desconformidade — por isso o app já informa.
const ITENS_MARCO_2027 = ['0103', '0105', '0109', '1601'];

// Operações com imóveis (cIndOp 020101, 020201 e 020301; Anexo VI v1.01): o grupo "imovel" do IBS/CBS
// identifica o imóvel (inscrição imobiliária opcional + CIB ou endereço). É obrigatório (E0932), salvo nos
// subitens de construção civil abaixo, em que o imóvel vai nos dados da obra (serv/obra) e o grupo é proibido
// (E0931). Fora das operações com imóveis o grupo também é proibido (E0928).
export const CINDOP_IMOVEL = ['020101', '020201', '020301'];
export const SUBITENS_OBRA_SEM_IMOVEL = ['070201', '070202', '070401', '070501', '070502', '070601', '070602', '070701', '070801', '071701', '071901'];
export const exigeImovel = (cTribNac, cIndOp) => CINDOP_IMOVEL.includes(String(cIndOp || ''))
  && !SUBITENS_OBRA_SEM_IMOVEL.includes(String(cTribNac || ''));
export function inicioObrigatoriedade(cTribNac, { simples = false } = {}) {
  const c = String(cTribNac || '');
  if (ITENS_MARCO_2027.includes(c.slice(0, 4))) return '2027-03-01';
  if (simples || c.startsWith('99')) return '2027-01-01';
  return '2026-10-01';
}

export function opcoesIbsCbs(cTribNac) {
  const item = String(cTribNac || '').slice(0, 4);
  const entradas = dados.itens[item] || [];
  return entradas.map((e) => ({
    nbs: e.nbs,
    descricao: e.descricao,
    cIndOp: e.cIndOp.map((c) => ({ codigo: c, ...(dados.cIndOp[c] || {}), exigeImovel: exigeImovel(cTribNac, c) })),
    cClassTrib: e.cClassTrib,
  }));
}

/**
 * Resolve o que vai no grupo IBS/CBS a partir do rascunho, aplicando padrões só
 * quando há uma única opção oficial (ou a tributação integral 000001 existe).
 * @returns {{ grupo: object|null, erros: Array, opcoes: Array }}
 */
export function resolverIbsCbs(nota) {
  const erros = [];
  const add = (campo, mensagem, regra) => erros.push({ campo, mensagem, regra });
  const opcoes = opcoesIbsCbs(nota.cTribNac);
  if (!opcoes.length) {
    add('ibscbs', 'Este serviço não tem correlação oficial de IBS/CBS (Anexo VIII). Emita pelo Emissor Nacional ou escolha outro código de serviço.', 'Anexo VIII');
    return { grupo: null, erros, opcoes };
  }
  const nbs = nota.cNBS || (opcoes.length === 1 ? opcoes[0].nbs : null);
  const entrada = opcoes.find((o) => o.nbs === nbs);
  if (!nbs) add('ibscbs.nbs', 'Escolha o código NBS do serviço (obrigatório com IBS/CBS).', 'E0322');
  else if (!entrada) add('ibscbs.nbs', 'O código NBS escolhido não corresponde a este serviço na tabela oficial (Anexo VIII).', 'Anexo VIII');
  if (!entrada) return { grupo: null, erros, opcoes };

  const cIndOp = nota.cIndOp || (entrada.cIndOp.length === 1 ? entrada.cIndOp[0].codigo : null);
  if (!cIndOp) add('ibscbs.cIndOp', 'Informe como o serviço é prestado (define o local do IBS/CBS).', 'E0901');
  else if (!entrada.cIndOp.some((c) => c.codigo === cIndOp)) add('ibscbs.cIndOp', 'Indicador de operação não previsto para esta NBS na tabela oficial.', 'E0901');
  // Serviço sobre imóvel: o imóvel vem do mesmo bloco da tela usado nas obras (rascunho.obra), sem o CNO.
  let imovel = null;
  if (cIndOp && exigeImovel(nota.cTribNac, cIndOp)) {
    const o = nota.obra;
    if (!o) add('imovel', 'Serviço sobre imóvel: informe o endereço do imóvel ou o código CIB (exigidos no IBS/CBS).', 'E0932');
    else if (o.tipo === 'cno') add('imovel', 'No IBS/CBS o imóvel é identificado pelo endereço ou pelo código CIB. O CNO vale só para obras de construção civil.', 'XSD');
    else if (conferirIdentificacaoImovel(o, add, { campo: 'imovel', nome: 'do imóvel' })) {
      imovel = { inscImobFisc: o.inscImobFisc || null, ...(o.tipo === 'cib' ? { cib: o.cib } : { endereco: o.endereco }) };
    }
  }

  const classes = entrada.cClassTrib.map((c) => c.codigo);
  const cClassTrib = nota.cClassTrib || (classes.includes('000001') ? '000001' : classes.length === 1 ? classes[0] : null);
  if (!cClassTrib) add('ibscbs.cClassTrib', 'Escolha a classificação tributária do IBS/CBS.', 'E0958');
  else if (!classes.includes(cClassTrib)) add('ibscbs.cClassTrib', 'Classificação tributária não prevista para esta NBS na tabela oficial.', 'E0958');

  const tipoTomador = nota.tomador?.tipo;
  // Art. 57 da LC 214/2025: uso ou consumo pessoal. Padrão: pessoa física = sim; empresa = não.
  const indFinal = nota.indFinal ?? (tipoTomador === 'CPF' ? '1' : '0');

  if (erros.length) return { grupo: null, erros, opcoes };
  return {
    grupo: {
      finNFSe: '0', // NFS-e regular
      indFinal: String(indFinal),
      cIndOp,
      indDest: '0', // destinatário = o próprio tomador
      CST: cClassTrib.slice(0, 3), // E0959: 3 primeiros dígitos do cClassTrib = CST
      cClassTrib,
      cNBS: nbs,
      ...(imovel ? { imovel } : {}),
    },
    erros,
    opcoes,
  };
}
