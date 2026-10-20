// Operações do catálogo central que as contas precisam compartilhar.
import { agora } from './banco.js';
import { indiceCego } from '../security/cripto.js';

export function criarCatalogo(central) {
  return {
    // Numeração por emitente: comum a todas as contas do mesmo CNPJ/CPF (evita E0014).
    proximoNumeroDps(documentoEmitente, ambiente, serie) {
      const e = indiceCego(`emitente:${documentoEmitente}`);
      return central.transacao(() => {
        central.run('INSERT INTO contadores_dps (emitente_indice, ambiente, serie, ultimo) VALUES (?,?,?,0) ON CONFLICT DO NOTHING', e, ambiente, serie);
        central.run('UPDATE contadores_dps SET ultimo = ultimo + 1 WHERE emitente_indice = ? AND ambiente = ? AND serie = ?', e, ambiente, serie);
        return central.get('SELECT ultimo FROM contadores_dps WHERE emitente_indice = ? AND ambiente = ? AND serie = ?', e, ambiente, serie).ultimo;
      });
    },

    // Cache de parâmetros municipais (dados públicos; sem cifragem).
    parametroEmCache(chave, validadeMs) {
      const r = central.get('SELECT dados, obtido_em FROM parametros_municipais_cache WHERE chave = ?', chave);
      if (!r || Date.now() - new Date(r.obtido_em).getTime() > validadeMs) return null;
      return JSON.parse(r.dados);
    },
    guardarParametro: (chave, dados) => central.run(
      'INSERT INTO parametros_municipais_cache (chave, dados, obtido_em) VALUES (?,?,?) ON CONFLICT(chave) DO UPDATE SET dados = excluded.dados, obtido_em = excluded.obtido_em',
      chave, JSON.stringify(dados), agora(),
    ),

    // Índice das contas com nota de resultado incerto (para a verificação periódica).
    marcarPendente: (usuarioId) => central.run('INSERT INTO contas_pendentes (usuario_id, desde) VALUES (?,?) ON CONFLICT DO NOTHING', usuarioId, agora()),
    desmarcarPendente: (usuarioId) => central.run('DELETE FROM contas_pendentes WHERE usuario_id = ?', usuarioId),
    contasPendentes: () => central.all('SELECT usuario_id FROM contas_pendentes ORDER BY desde').map((r) => r.usuario_id),
  };
}
