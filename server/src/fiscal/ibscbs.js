// Grupo IBS/CBS da DPS (leiaute RTC — Anexo VI; NT 004/005/007).
// Na DPS o grupo é DECLARATIVO: o emitente informa a classificação da operação
// (finalidade, indicador de operação, destinatário, CST e cClassTrib) e a Sefin
// calcula base, alíquotas e valores com a calculadora oficial.
//
// As opções vêm das tabelas oficiais: Anexo VIII (item LC 116 × NBS × cIndOp ×
// cClassTrib) e Anexo VII (códigos cIndOp válidos). Nada é inventado: serviço
// sem correlação oficial não recebe o grupo, e o usuário é avisado.
import { readFileSync } from 'node:fs';

const dados = JSON.parse(readFileSync(new URL('../data/ibscbs-correlacao.json', import.meta.url), 'utf8'));

// Prazos do Ato Conjunto RFB/CGIBS nº 4/2026 (orientação SE/CGNFS-e): serviços da
// LC 116 em geral a partir de 01/10/2026; subitens 1.03, 1.05, 1.09 e 16.01 e
// locações a partir de 01/12/2026. Até 31/12/2026 a ausência não gera rejeição,
// mas deixa o documento em desconformidade — por isso o Nota Sem Stress já informa.
const ITENS_DEZEMBRO = ['0103', '0105', '0109', '1601'];

// Anexo VI, regras 591–593: cIndOp de operações com imóveis (020101, 020201, 020301) exige o
// grupo "imovel", salvo nos subitens de obra listados — grupo ainda não suportado pelo Nota Sem Stress.
const CINDOP_IMOVEL = ['020101', '020201', '020301'];
const SUBITENS_SEM_IMOVEL = ['070201', '070202', '070401', '070501', '070502', '070601', '070602', '070701', '070801', '071701', '071901'];
export const inicioObrigatoriedade = (cTribNac) => (ITENS_DEZEMBRO.includes(String(cTribNac || '').slice(0, 4)) || String(cTribNac || '').startsWith('99') ? '2026-12-01' : '2026-10-01');

export function opcoesIbsCbs(cTribNac) {
  const item = String(cTribNac || '').slice(0, 4);
  const entradas = dados.itens[item] || [];
  return entradas.map((e) => ({
    nbs: e.nbs,
    descricao: e.descricao,
    cIndOp: e.cIndOp.map((c) => ({ codigo: c, ...(dados.cIndOp[c] || {}) })),
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
  else if (CINDOP_IMOVEL.includes(cIndOp) && !SUBITENS_SEM_IMOVEL.includes(String(nota.cTribNac))) {
    add('ibscbs.cIndOp', 'Esta operação é relativa a imóvel e exige os dados do imóvel no IBS/CBS, ainda não disponíveis no Nota Sem Stress. Use o Emissor Nacional para ela.', 'Anexo VI #592');
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
    },
    erros,
    opcoes,
  };
}
