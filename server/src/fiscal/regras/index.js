// Seleção do pacote de regras por regime e competência. Novos regimes
// (não optante) e novas vigências (IBS/CBS 2027) entram como novos pacotes,
// sem alterar telas nem o fluxo de emissão.
import { pacote as mei2026 } from './mei-2026.js';
import { pacote as meEpp2026 } from './me-epp-2026.js';
import { pacote as naoOptante2026 } from './nao-optante-2026.js';

export const pacotes = [mei2026, meEpp2026, naoOptante2026];

export function escolherPacote({ opSimpNac, competencia }) {
  const p = pacotes.find((x) => x.aplica({ opSimpNac, competencia }));
  if (p) return { pacote: p };
  if (competencia && competencia >= '2027-01-01') {
    return {
      motivo: opSimpNac === '1'
        ? 'Em 2027 começam a CBS plena e a extinção do PIS/COFINS. Esta versão do NotaVez ainda não foi atualizada para as regras de 2027.'
        : 'A partir de 2027 as notas do Simples Nacional exigem os grupos de IBS/CBS (Anexo I). Esta versão do NotaVez ainda não foi atualizada para essa regra.',
    };
  }
  if (opSimpNac === '2' && competencia && competencia < '2023-09-01') {
    return { motivo: 'Competências anteriores a 01/09/2023 não são suportadas para MEI.' };
  }
  return { motivo: 'Informe uma competência válida.' };
}
