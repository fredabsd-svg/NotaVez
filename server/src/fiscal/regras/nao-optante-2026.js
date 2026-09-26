// Pacote de regras: NÃO optante do Simples (Lucro Presumido ou Real, opSimpNac = 1),
// competências até 31/12/2026. Regras do ANEXO_I v1.01 e do Anexo VI (RTC, NT 007).
//
// ISS (tribMun):  alíquota proibida com convênio do município de incidência ativo (E0617),
//                 obrigatória sem convênio (E0619); nunca acima de 5% (E0595).
// Federais:       PIS/COFINS da apuração própria em "piscofins" (CST, base, alíquotas,
//                 valores — E0678/E0684/E0690/E0694/E0696); retenções de PIS, COFINS e
//                 CSLL SOMADAS em vRetCSLL conforme tpRetPisCofins (NT 007; E0720/E0724);
//                 IRRF e CP retidos em vRetIRRF/vRetCP (E0699/E0700).
// Total aprox.:   pTotTrib (federal/estadual/municipal) — indTotTrib e pTotTribSN são
//                 proibidos para não optante (E0713).
// IBS/CBS:        grupo informado sempre (permitido desde 01/01/2026, E0850; exigido pelo
//                 Ato Conjunto RFB/CGIBS nº 4/2026 a partir de 01/10 ou 01/12/2026).
import { validarComum, validarConvenioEmissor, tomadorIdentificado, percentual, arredondarBancario } from './comum.js';
import { resolverIbsCbs } from '../ibscbs.js';
import { municipio } from '../tabelas.js';

const fmt2 = (n) => Number(n).toFixed(2);
const CST_SEM_BASE = ['00', '08', '09']; // E0682: sem base de cálculo
export const CSTS_PIS_COFINS = {
  '01': 'Operação tributável com alíquota básica',
  '06': 'Operação tributável a alíquota zero',
  '08': 'Operação sem incidência da contribuição',
  '09': 'Operação com suspensão da contribuição',
};

// tpRetPisCofins a partir do que foi retido (NT 007: códigos 0 e 3 a 9; 1 e 2 serão suprimidos).
export function tipoRetencaoPisCofins({ pis, cofins, csll }) {
  const k = `${pis ? 1 : 0}${cofins ? 1 : 0}${csll ? 1 : 0}`;
  return { '000': '0', '111': '3', '110': '4', '100': '5', '010': '6', '011': '7', '001': '8', '101': '9' }[k];
}

function retencoes(nota) {
  const r = nota.retencoesFederais || {};
  return {
    pis: !!r.pis, cofins: !!r.cofins, csll: !!r.csll,
    valorContribuicoes: percentual(r.valorContribuicoes),
    irrf: percentual(r.irrf),
    cp: percentual(r.cp),
  };
}

function pisCofins(prestador, nota) {
  const cst = String(prestador.cstPisCofins || '01');
  const vServ = Number(nota.valor);
  if (CST_SEM_BASE.includes(cst)) return { CST: cst };
  const aliqPis = cst === '06' ? 0 : percentual(prestador.aliqPis);
  const aliqCofins = cst === '06' ? 0 : percentual(prestador.aliqCofins);
  const base = vServ; // E0677: base ≤ valor do serviço
  return {
    CST: cst,
    vBCPisCofins: base,
    pAliqPis: aliqPis,
    pAliqCofins: aliqCofins,
    vPis: aliqPis === null ? null : arredondarBancario(base * aliqPis / 100),
    vCofins: aliqCofins === null ? null : arredondarBancario(base * aliqCofins / 100),
  };
}

function exigenciaAliquota(ctx) {
  const conv = ctx.parametros?.convenioIncidencia;
  const nome = municipio(ctx.municipioIncidencia)?.nome || 'O município de incidência';
  if (conv?.situacao === 'ativo') return { modo: 'proibida', regra: 'E0617', motivo: `O ISS é calculado pela alíquota que ${nome} cadastrou no sistema nacional.` };
  if (conv?.situacao === 'inexistente') return { modo: 'obrigatoria', minimo: 0, maximo: 5, regra: 'E0619', motivo: `${nome} não é conveniado ao sistema nacional: informe a alíquota do ISS do município para este serviço.` };
  return { modo: 'indefinida', regra: 'E0617/E0619', motivo: 'Não foi possível consultar o convênio do município agora.' };
}

export const pacote = {
  id: 'NAO-OPTANTE-2026',
  descricao: 'Lucro Presumido/Real (não optante do Simples) — ISS conforme convênio, PIS/COFINS, retenções federais e grupo IBS/CBS (DPS v1.01)',
  aplica: ({ opSimpNac, competencia }) => opSimpNac === '1' && !!competencia && competencia <= '2026-12-31',
  precisaParametros: () => ({ convenioEmissor: true, convenioIncidencia: true }),

  regTrib: () => ({ opSimpNac: '1', regEspTrib: '0' }), // E0162: sem regApTribSN

  tributacao(ctx) {
    const { prestador, nota } = ctx;
    const ex = exigenciaAliquota(ctx);
    const aliq = percentual(nota.pAliq ?? prestador.aliqIss);
    const ret = retencoes(nota);
    const pc = pisCofins(prestador, nota);
    const tpRet = tipoRetencaoPisCofins(ret);
    return {
      tribISSQN: '1',
      tpRetISSQN: nota.issRetido ? '2' : '1',
      pAliq: ex.modo === 'obrigatoria' && aliq !== null ? fmt2(aliq) : undefined,
      tribFed: {
        piscofins: {
          CST: pc.CST,
          ...(pc.vBCPisCofins !== undefined ? {
            vBCPisCofins: fmt2(pc.vBCPisCofins), pAliqPis: fmt2(pc.pAliqPis), pAliqCofins: fmt2(pc.pAliqCofins), vPis: fmt2(pc.vPis), vCofins: fmt2(pc.vCofins),
          } : {}),
          tpRetPisCofins: tpRet,
        },
        vRetCP: ret.cp ? fmt2(ret.cp) : undefined,
        vRetIRRF: ret.irrf ? fmt2(ret.irrf) : undefined,
        vRetCSLL: tpRet !== '0' && ret.valorContribuicoes ? fmt2(ret.valorContribuicoes) : undefined,
      },
      totTrib: {
        pTotTrib: {
          pTotTribFed: fmt2(percentual(prestador.pTotTribFed) ?? 0),
          pTotTribEst: fmt2(percentual(prestador.pTotTribEst) ?? 0),
          pTotTribMun: fmt2(percentual(prestador.pTotTribMun) ?? 0),
        },
      },
    };
  },

  ibscbs: (ctx) => resolverIbsCbs(ctx.nota).grupo,

  exigencias(ctx) {
    const pc = pisCofins(ctx.prestador, ctx.nota);
    const ret = retencoes(ctx.nota);
    const retidos = (ret.valorContribuicoes || 0) + (ret.irrf || 0) + (ret.cp || 0);
    return {
      retencaoPermitida: true,
      retencoesFederaisPermitidas: true,
      aliquota: exigenciaAliquota(ctx),
      pisCofins: { cst: pc.CST, descricao: CSTS_PIS_COFINS[pc.CST] || pc.CST, vPis: pc.vPis ?? null, vCofins: pc.vCofins ?? null },
      retencoesFederais: retidos,
      ibscbs: resolverIbsCbs(ctx.nota),
    };
  },

  validar(ctx) {
    const e = validarComum(ctx);
    const add = (campo, mensagem, regra) => e.push({ campo, mensagem, regra });
    const { prestador, nota, parametros } = ctx;
    const vServ = Number(nota.valor) || 0;

    // Perfil: PIS/COFINS da apuração própria e percentuais aproximados (Lei 12.741/2012).
    const cst = String(prestador.cstPisCofins || '');
    if (!CSTS_PIS_COFINS[cst]) add('perfil.federais', 'Informe no perfil a situação do PIS/COFINS (CST).', 'E0678');
    if (cst && !CST_SEM_BASE.includes(cst) && cst !== '06') {
      const ap = percentual(prestador.aliqPis);
      const ac = percentual(prestador.aliqCofins);
      if (ap === null || ap < 0 || ap > 100) add('perfil.federais', 'Informe no perfil a alíquota do PIS.', 'E0684');
      if (ac === null || ac < 0 || ac > 100) add('perfil.federais', 'Informe no perfil a alíquota da COFINS.', 'E0690');
    }
    if (percentual(prestador.pTotTribFed) === null || percentual(prestador.pTotTribMun) === null) {
      add('perfil.federais', 'Informe no perfil os percentuais aproximados de tributos federais e municipais (Lei 12.741/2012).', 'Leiaute totTrib');
    }

    // ISS: retenção e alíquota conforme o convênio do município de incidência.
    if (nota.issRetido) {
      if (!tomadorIdentificado(nota.tomador)) add('tributacao', 'Para o cliente reter o ISS, ele precisa estar identificado na nota.', 'E0204');
      else if (nota.tomador.tipo !== 'CNPJ') add('tributacao', 'A retenção de ISS por pessoa física depende de autorização do município (E0667). Nesta versão, só clientes com CNPJ podem reter.', 'E0667');
    }
    const ex = exigenciaAliquota(ctx);
    if (ex.modo === 'indefinida') add('tributacao', `${ex.motivo} Tente novamente em instantes.`, ex.regra);
    if (ex.modo === 'obrigatoria') {
      const aliq = percentual(nota.pAliq ?? prestador.aliqIss);
      if (aliq === null || aliq <= 0) add('tributacao', `Informe a alíquota do ISS. ${ex.motivo}`, ex.regra);
      else if (aliq > 5) add('tributacao', 'A alíquota do ISS não pode passar de 5%.', 'E0595');
    }

    // Retenções federais (feitas por clientes pessoa jurídica).
    const ret = retencoes(nota);
    const algumaContribuicao = ret.pis || ret.cofins || ret.csll;
    if ((algumaContribuicao || ret.irrf || ret.cp) && nota.tomador?.tipo !== 'CNPJ') add('retencoes', 'Retenções federais só podem ser informadas para cliente com CNPJ.', 'Regra');
    if (algumaContribuicao && !ret.valorContribuicoes) add('retencoes', 'Informe o valor total retido de PIS/COFINS/CSLL (somados, como pede a NT 007).', 'E0724');
    if (!algumaContribuicao && ret.valorContribuicoes) add('retencoes', 'Marque quais contribuições foram retidas ou apague o valor.', 'E0720');
    for (const [k, regra, nome] of [['valorContribuicoes', 'E0701', 'PIS/COFINS/CSLL'], ['irrf', 'E0700', 'IRRF'], ['cp', 'E0699', 'INSS (CP)']]) {
      if (ret[k] !== null && (ret[k] <= 0 || ret[k] >= vServ)) add('retencoes', `O valor retido de ${nome} deve ser maior que zero e menor que o valor do serviço.`, regra);
    }
    if (vServ && (ret.valorContribuicoes || 0) + (ret.irrf || 0) + (ret.cp || 0) > vServ) add('retencoes', 'A soma das retenções não pode passar do valor do serviço.', 'Anexo I #392');

    // IBS/CBS
    for (const x of resolverIbsCbs(nota).erros) e.push(x);

    validarConvenioEmissor(e, parametros);
    return e;
  },
};
