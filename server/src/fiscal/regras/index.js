// Seleção do pacote de regras por regime e competência. Novos regimes
// (não optante) e novas vigências (IBS/CBS 2027) entram como novos pacotes,
// sem alterar telas nem o fluxo de emissão.
import { pacote as mei2026 } from './mei-2026.js';
import { pacote as meEpp2026 } from './me-epp-2026.js';

export const pacotes = [mei2026, meEpp2026];

export function escolherPacote({ opSimpNac, competencia }) {
  const p = pacotes.find((x) => x.aplica({ opSimpNac, competencia }));
  if (p) return { pacote: p };
  if (opSimpNac === '1') {
    return { motivo: 'Nesta versão, a emissão direta ainda não está disponível para empresas fora do Simples (Lucro Presumido/Real). Você pode preparar o rascunho e emitir pelo Emissor Nacional.' };
  }
  if (competencia && competencia >= '2027-01-01') {
    return { motivo: 'A partir de 2027 as notas do Simples Nacional exigem os grupos de IBS/CBS (Anexo I). Esta versão do NotaVez ainda não foi atualizada para essa regra.' };
  }
  if (opSimpNac === '2' && competencia && competencia < '2023-09-01') {
    return { motivo: 'Competências anteriores a 01/09/2023 não são suportadas para MEI.' };
  }
  return { motivo: 'Informe uma competência válida.' };
}
