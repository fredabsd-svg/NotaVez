import { ErroApp } from '../util/erros.js';

// Deve compartilhar o banco/transação das transições fiscais. O claim fiscal
// exige nota e prestador existentes; nunca pode enviar se essa exclusão vencer.
export function excluirConta(db, usuarioId) {
  return db.transacao(() => {
    const pendente = db.get(`SELECT n.id FROM notas n JOIN prestadores p ON p.id = n.prestador_id
      WHERE p.usuario_id = ? AND n.situacao IN ('enviando','pendente') LIMIT 1`, usuarioId);
    if (pendente) throw new ErroApp(409, 'Há uma nota com resultado ainda não confirmado. Verifique a situação antes de excluir a conta.', { codigo: 'CONTA_COM_EMISSAO_PENDENTE', notaId: pendente.id });
    // Chamadas e auditoria não possuem FK com cascata: remover antes dos pais.
    db.run('DELETE FROM chamadas_api WHERE nota_id IN (SELECT n.id FROM notas n JOIN prestadores p ON p.id = n.prestador_id WHERE p.usuario_id = ?)', usuarioId);
    db.run(`DELETE FROM auditoria WHERE usuario_id = ? OR prestador_id IN (SELECT id FROM prestadores WHERE usuario_id = ?)
      OR entidade_id IN (
        SELECT id FROM usuarios WHERE id = ? UNION SELECT id FROM prestadores WHERE usuario_id = ?
        UNION SELECT n.id FROM notas n JOIN prestadores p ON p.id = n.prestador_id WHERE p.usuario_id = ?
        UNION SELECT c.id FROM clientes c JOIN prestadores p ON p.id = c.prestador_id WHERE p.usuario_id = ?
        UNION SELECT s.id FROM servicos s JOIN prestadores p ON p.id = s.prestador_id WHERE p.usuario_id = ?
        UNION SELECT c.id FROM certificados c JOIN prestadores p ON p.id = c.prestador_id WHERE p.usuario_id = ?
      )`, ...Array(8).fill(usuarioId));
    db.run('DELETE FROM usuarios WHERE id = ?', usuarioId);
    // contadores_dps são reservas compartilhadas por emitente/ambiente/série.
    // Não reutilizar numeração depois da exclusão; não guardam XML ou contato.
    return { ok: true };
  });
}
