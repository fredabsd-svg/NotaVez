// Pacote de regras: optante do Simples Nacional ME/EPP (opSimpNac = 3),
// competências até 31/12/2026 (grupos IBS/CBS obrigatórios para o Simples só
// a partir de 2027 — Anexo I, leiaute). Regras do ANEXO_I v1.01, aba "RN DPS_NFS-e".
//
// Regime de apuração (regApTribSN, obrigatório — E0166):
//   1 = federais e ISS pelo Simples · 2 = federais pelo Simples, ISS fora · 3 = tudo fora do Simples
//
// Alíquota do ISS (pAliq), regras 508–513 e E0595:
//   regApTribSN = 1: obrigatória SE houver retenção (E0621/E0628, mínimo 1,8%), proibida sem retenção (E0625/E0631)
//   regApTribSN = 2/3: proibida se o convênio do município de incidência estiver ativo (E0635),
//                      obrigatória se não estiver (E0640) — por isso consultamos os parâmetros municipais.
//   Nunca acima de 5% (E0595).
import { validarComum, validarConvenioEmissor, tomadorIdentificado, percentual, municipioIncidencia } from './comum.js';
import { municipio } from '../tabelas.js';

const fmt2 = (n) => Number(n).toFixed(2);
const ALIQ_MIN_RETENCAO_SN = 1.8;
const ALIQ_MAX = 5;

function valores(prestador, nota) {
  return {
    regApTribSN: String(prestador.regApTribSN || ''),
    retido: !!nota.issRetido,
    pAliq: percentual(nota.pAliq ?? (nota.issRetido && String(prestador.regApTribSN) === '1' ? prestador.aliqIssSN : null)),
    pTotTribSN: percentual(nota.pTotTribSN ?? prestador.pTotTribSN),
  };
}

function exigenciaAliquota(ctx) {
  const { regApTribSN, retido } = valores(ctx.prestador, ctx.nota);
  if (regApTribSN === '1') {
    return retido
      ? { modo: 'obrigatoria', minimo: ALIQ_MIN_RETENCAO_SN, maximo: ALIQ_MAX, regra: 'E0621', motivo: 'Com ISS retido pelo cliente, a alíquota do ISS no Simples precisa constar na nota.' }
      : { modo: 'proibida', regra: 'E0625', motivo: 'Sem retenção, o ISS é recolhido no DAS e a alíquota não vai na nota.' };
  }
  if (regApTribSN === '2' || regApTribSN === '3') {
    const conv = ctx.parametros?.convenioIncidencia;
    const nome = municipio(ctx.municipioIncidencia)?.nome || 'do município de incidência';
    if (conv?.situacao === 'ativo') return { modo: 'proibida', regra: 'E0635', motivo: `O ISS é calculado pela alíquota que ${nome} cadastrou no sistema nacional.` };
    if (conv?.situacao === 'inexistente') return { modo: 'obrigatoria', minimo: 0, maximo: ALIQ_MAX, regra: 'E0640', motivo: `${nome} não é conveniado ao sistema nacional: informe a alíquota do ISS do município para este serviço.` };
    return { modo: 'indefinida', regra: 'E0635/E0640', motivo: 'Não foi possível consultar o convênio do município agora.' };
  }
  return { modo: 'indefinida', regra: 'E0166', motivo: 'Informe no perfil o regime de apuração do Simples.' };
}

export const pacote = {
  id: 'ME-EPP-2026',
  descricao: 'ME/EPP do Simples Nacional — regime de apuração, alíquota conforme retenção e convênio municipal (DPS v1.01, sem IBS/CBS até 2026)',
  aplica: ({ opSimpNac, competencia }) => opSimpNac === '3' && !!competencia && competencia <= '2026-12-31',
  // Não-MEI depende do convênio do município emissor (E0037–E0039) e, com ISS fora do Simples, do de incidência.
  precisaParametros: (ctx) => ({ convenioEmissor: true, convenioIncidencia: ['2', '3'].includes(String(ctx.prestador.regApTribSN)) }),

  regTrib: (ctx) => ({ opSimpNac: '3', regApTribSN: String(ctx.prestador.regApTribSN), regEspTrib: '0' }), // E0175
  tributacao(ctx) {
    const v = valores(ctx.prestador, ctx.nota);
    const ex = exigenciaAliquota(ctx);
    return {
      tribISSQN: '1',
      tpRetISSQN: v.retido ? '2' : '1',
      pAliq: ex.modo === 'obrigatoria' && v.pAliq !== null ? fmt2(v.pAliq) : undefined,
      totTrib: { pTotTribSN: v.pTotTribSN !== null ? fmt2(v.pTotTribSN) : undefined }, // E0712: indTotTrib proibido
    };
  },
  exigencias: (ctx) => ({ retencaoPermitida: true, aliquota: exigenciaAliquota(ctx) }),

  validar(ctx) {
    const e = validarComum(ctx);
    const add = (campo, mensagem, regra) => e.push({ campo, mensagem, regra });
    const { prestador, nota, parametros } = ctx;
    const v = valores(prestador, nota);

    if (!['1', '2', '3'].includes(v.regApTribSN)) add('perfil.regime', 'Informe no perfil como sua empresa apura os tributos no Simples.', 'E0166');

    if (v.pTotTribSN === null) add('tributacao', 'Informe o percentual aproximado de tributos do Simples (alíquota efetiva do mês).', 'Leiaute totTrib');
    else if (v.pTotTribSN <= 0 || v.pTotTribSN >= 100) add('tributacao', 'O percentual de tributos do Simples deve ficar entre 0 e 100%.', 'XSD');

    if (v.retido) {
      if (!tomadorIdentificado(nota.tomador)) add('tributacao', 'Para o cliente reter o ISS, ele precisa estar identificado na nota.', 'E0204');
      else if (nota.tomador.tipo !== 'CNPJ') add('tributacao', 'A retenção de ISS por pessoa física depende de autorização do município (E0667). Nesta versão, só clientes com CNPJ podem reter.', 'E0667');
    }

    const ex = exigenciaAliquota(ctx);
    if (ex.modo === 'indefinida' && ['1', '2', '3'].includes(v.regApTribSN)) add('tributacao', `${ex.motivo} Tente novamente em instantes.`, ex.regra);
    if (ex.modo === 'obrigatoria') {
      if (v.pAliq === null) add('tributacao', `Informe a alíquota do ISS. ${ex.motivo}`, ex.regra);
      else if (v.pAliq > ALIQ_MAX) add('tributacao', 'A alíquota do ISS não pode passar de 5%.', 'E0595');
      else if (v.pAliq < ex.minimo || v.pAliq <= 0) add('tributacao', `A alíquota do ISS deve ser de pelo menos ${String(Math.max(ex.minimo, 0.01)).replace('.', ',')}%.`, ex.regra);
    }

    validarConvenioEmissor(e, parametros);
    return e;
  },
};

export { municipioIncidencia };
