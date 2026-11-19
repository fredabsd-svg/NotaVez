// Retenções federais na fonte (grupo tribFed da DPS), feitas pelo cliente pessoa jurídica:
//   INSS / contribuição previdenciária (vRetCP), IRRF (vRetIRRF) e PIS, COFINS e CSLL — estas SOMADAS em vRetCSLL,
//   com o tipo em piscofins/tpRetPisCofins (NT 007; E0720/E0724). Valores > 0 e < valor do serviço (E0699/E0700).
// Vale para o Lucro Presumido/Real e para a ME/EPP do Simples (só o MEI não informa tributos federais: E0676).
import { percentual } from './comum.js';

const fmt2 = (n) => Number(n).toFixed(2);

// tpRetPisCofins a partir do que foi retido (NT 007: códigos 0 e 3 a 9; 1 e 2 serão suprimidos).
export function tipoRetencaoPisCofins({ pis, cofins, csll }) {
  const k = `${pis ? 1 : 0}${cofins ? 1 : 0}${csll ? 1 : 0}`;
  return { '000': '0', '111': '3', '110': '4', '100': '5', '010': '6', '011': '7', '001': '8', '101': '9' }[k];
}

export function retencoes(nota) {
  const r = nota.retencoesFederais || {};
  return {
    pis: !!r.pis, cofins: !!r.cofins, csll: !!r.csll,
    valorContribuicoes: percentual(r.valorContribuicoes),
    irrf: percentual(r.irrf),
    cp: percentual(r.cp),
  };
}

export const totalRetido = (ret) => (ret.valorContribuicoes || 0) + (ret.irrf || 0) + (ret.cp || 0);
export const haRetencaoFederal = (ret) => !!(ret.pis || ret.cofins || ret.csll || ret.valorContribuicoes || ret.irrf || ret.cp);

// Campos de retenção do tribFed (o piscofins de apuração própria, quando houver, é montado por quem chama).
export function camposRetencao(ret) {
  const tpRet = tipoRetencaoPisCofins(ret);
  return {
    tpRetPisCofins: tpRet,
    vRetCP: ret.cp ? fmt2(ret.cp) : undefined,
    vRetIRRF: ret.irrf ? fmt2(ret.irrf) : undefined,
    vRetCSLL: tpRet !== '0' && ret.valorContribuicoes ? fmt2(ret.valorContribuicoes) : undefined,
  };
}

export function validarRetencoes(nota, add) {
  const vServ = Number(nota.valor) || 0;
  const ret = retencoes(nota);
  const algumaContribuicao = ret.pis || ret.cofins || ret.csll;
  if ((algumaContribuicao || ret.irrf || ret.cp) && nota.tomador?.tipo !== 'CNPJ') add('retencoes', 'Retenções federais só podem ser informadas para cliente com CNPJ.', 'Regra');
  if (algumaContribuicao && !ret.valorContribuicoes) add('retencoes', 'Informe o valor total retido de PIS/COFINS/CSLL (somados, como pede a NT 007).', 'E0724');
  if (!algumaContribuicao && ret.valorContribuicoes) add('retencoes', 'Marque quais contribuições foram retidas ou apague o valor.', 'E0720');
  for (const [k, regra, nome] of [['valorContribuicoes', 'E0701', 'PIS/COFINS/CSLL'], ['irrf', 'E0700', 'IRRF'], ['cp', 'E0699', 'INSS (CP)']]) {
    if (ret[k] !== null && (ret[k] <= 0 || ret[k] >= vServ)) add('retencoes', `O valor retido de ${nome} deve ser maior que zero e menor que o valor do serviço.`, regra);
  }
  if (vServ && totalRetido(ret) > vServ) add('retencoes', 'A soma das retenções não pode passar do valor do serviço.', 'Anexo I #392');
}
