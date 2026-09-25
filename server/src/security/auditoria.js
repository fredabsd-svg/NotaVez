import { agora } from '../db/banco.js';

// Registra operações sem dados pessoais: identificadores internos e códigos apenas.
export function auditar(db, { usuarioId = null, prestadorId = null, acao, entidade = null, entidadeId = null, detalhes = null, ip = null }) {
  db.run(
    'INSERT INTO auditoria (usuario_id, prestador_id, acao, entidade, entidade_id, detalhes, ip, criado_em) VALUES (?,?,?,?,?,?,?,?)',
    usuarioId, prestadorId, acao, entidade, entidadeId, detalhes ? JSON.stringify(detalhes) : null, ip, agora(),
  );
}
