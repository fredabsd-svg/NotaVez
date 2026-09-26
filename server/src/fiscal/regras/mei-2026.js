// Pacote de regras: prestador MEI (opSimpNac = 2), competências até 31/12/2026.
// Tributação fixa: sem alíquota (E0600), sem retenção (E0583), sem tributos
// federais (E0676), sem pTotTribSN (E0710) → indTotTrib = 0; regEspTrib = 0 (E0174).
import { validarComum } from './comum.js';

export { enderecoCompleto } from './comum.js';

export const pacote = {
  id: 'MEI-2026',
  descricao: 'MEI — regras do leiaute DPS v1.01 (sem grupos IBS/CBS, obrigatórios para o Simples só a partir de 2027)',
  aplica: ({ opSimpNac, competencia }) => opSimpNac === '2' && competencia >= '2023-09-01' && competencia <= '2026-12-31',
  // O MEI dispensa convênio e parametrização municipal (E0016, E0037–E0039 "exceto MEI").
  precisaParametros: () => ({ convenioEmissor: false, convenioIncidencia: false }),

  regTrib: () => ({ opSimpNac: '2', regEspTrib: '0' }),
  tributacao: () => ({ tribISSQN: '1', tpRetISSQN: '1', totTrib: { indTotTrib: '0' } }),
  exigencias: () => ({ retencaoPermitida: false, aliquota: { modo: 'proibida', regra: 'E0600', motivo: 'MEI não informa alíquota: o ISS é pago no DAS.' } }),

  validar(ctx) {
    const e = validarComum(ctx);
    if (ctx.nota.issRetido) e.push({ campo: 'tributacao', mensagem: 'MEI não pode ter ISS retido pelo cliente.', regra: 'E0583' });
    return e;
  },
};
