import { auditar } from '../security/auditoria.js';

// Exclusão em três passos, nesta ordem:
// 1. no banco da conta, numa transação: recusa se houver nota de resultado
//    incerto e marca a conta como encerrada (nenhum envio começa depois disso);
// 2. no catálogo central: apaga o usuário e, com ele, a chave da conta, as
//    sessões e as formas de entrada (a partir daqui o arquivo é ilegível);
// 3. apaga o arquivo da conta.
export function excluirConta({ central, contas, usuarioId, ip = null }) {
  const conta = contas.abrir(usuarioId);
  conta.repo.encerrar();
  try {
    central.transacao(() => {
      central.run('DELETE FROM auditoria WHERE usuario_id = ?', usuarioId);
      central.run('DELETE FROM usuarios WHERE id = ?', usuarioId);
      // Registro sem identificação da pessoa (o id some com a conta).
      auditar(central, { acao: 'conta.excluida', ip });
    });
  } catch (e) {
    // Nada foi apagado: a conta volta a poder emitir.
    conta.db.run("DELETE FROM meta WHERE chave = 'encerrada'");
    throw e;
  }
  contas.apagarArquivos(usuarioId);
  // contadores_dps são reservas compartilhadas por emitente/ambiente/série:
  // preservadas para nunca reutilizar numeração; não guardam XML nem contato.
  return { ok: true };
}
