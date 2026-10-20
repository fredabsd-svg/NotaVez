import { agora } from '../db/banco.js';

// Registra operações sem dados pessoais: identificadores internos e códigos.
// O IP (dado pessoal) fica cifrado com a chave do banco onde o registro vai:
// a chave da conta (banco da conta) ou a do servidor (catálogo central).
export function auditar(db, { usuarioId = null, prestadorId = null, acao, entidade = null, entidadeId = null, detalhes = null, ip = null }) {
  db.run(
    'INSERT INTO auditoria (usuario_id, prestador_id, acao, entidade, entidade_id, detalhes, ip, criado_em) VALUES (?,?,?,?,?,?,?,?)',
    usuarioId, prestadorId, acao, entidade, entidadeId, detalhes ? JSON.stringify(detalhes) : null, ip ? db.cripto.cifrar(ip) : null, agora(),
  );
}
