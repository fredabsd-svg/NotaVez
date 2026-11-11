import { agora, novoId } from '../db/banco.js';
import { conferirSenha, hashSenha, hashToken, tokenAleatorio } from './cripto.js';
import { ErroApp } from '../util/erros.js';

export const COOKIE = 'nv_sessao';
const DURACAO_MS = 30 * 86400_000;
const JANELA_MS = 15 * 60_000;
const normalizarEmail = (email) => String(email || '').trim().toLowerCase();
const validarSenha = (senha) => {
  if (typeof senha !== 'string' || senha.length < 8 || senha.length > 256) throw new ErroApp(422, 'A senha precisa ter entre 8 e 256 caracteres.');
};

export function criarAutenticacao(db, { entregarRecuperacao, recuperacaoTtlMs = 30 * 60_000, relatarFalhaEntrega = () => {} } = {}) {
  // Instalado também nos bancos existentes; não guarda tokens ou IPs em claro.
  db.raw.exec(`CREATE TABLE IF NOT EXISTS recuperacoes_senha (
    token_hash TEXT PRIMARY KEY,
    usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira_em TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_recuperacoes_usuario ON recuperacoes_senha(usuario_id);
  CREATE TABLE IF NOT EXISTS limites_conta (
    chave_hash TEXT PRIMARY KEY, quantidade INTEGER NOT NULL, ate_ms INTEGER NOT NULL
  );`);
  if (!Number.isFinite(recuperacaoTtlMs) || recuperacaoTtlMs <= 0 || recuperacaoTtlMs > 86400_000) throw new Error('TTL de recuperação inválido.');

  function limitar(acao, identidade, ip, max = 5) {
    const t = Date.now();
    db.transacao(() => {
      db.run('DELETE FROM limites_conta WHERE ate_ms <= ?', t);
      const chaves = [`${acao}:ip:${ip || 'desconhecido'}`, ...(identidade ? [`${acao}:identidade:${identidade}`] : [])].map(hashToken);
      for (const chave of chaves) {
        const r = db.get('SELECT quantidade FROM limites_conta WHERE chave_hash = ?', chave);
        if (r && r.quantidade >= max) throw new ErroApp(429, 'Muitas tentativas. Aguarde 15 minutos e tente de novo.');
      }
      for (const chave of chaves) db.run('INSERT INTO limites_conta (chave_hash, quantidade, ate_ms) VALUES (?,1,?) ON CONFLICT(chave_hash) DO UPDATE SET quantidade = quantidade + 1', chave, t + JANELA_MS);
    });
  }
  function criarSessao(usuarioId) {
    const token = tokenAleatorio();
    db.run('INSERT INTO sessoes (token_hash, usuario_id, criado_em, expira_em) VALUES (?,?,?,?)', hashToken(token), usuarioId, agora(), new Date(Date.now() + DURACAO_MS).toISOString());
    return token;
  }
  return {
    DURACAO_MS,
    cadastrar(email, senha, ip) {
      limitar('cadastro', null, ip, 10);
      email = normalizarEmail(email);
      if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ErroApp(422, 'Informe um e-mail válido.');
      validarSenha(senha);
      if (db.get('SELECT 1 FROM usuarios WHERE email = ?', email)) throw new ErroApp(409, 'Já existe uma conta com este e-mail. Entre com sua senha.');
      const id = novoId();
      return db.transacao(() => {
        db.run('INSERT INTO usuarios (id, email, senha_hash, criado_em) VALUES (?,?,?,?)', id, email, hashSenha(senha), agora());
        return { usuarioId: id, token: criarSessao(id) };
      });
    },
    entrar(email, senha, ip) {
      email = normalizarEmail(email);
      limitar('entrada', email, ip, 15);
      const u = db.get('SELECT id, senha_hash FROM usuarios WHERE email = ?', email);
      if (!u || typeof senha !== 'string' || senha.length > 256 || !conferirSenha(senha, u.senha_hash)) throw new ErroApp(401, 'E-mail ou senha incorretos.');
      return { usuarioId: u.id, token: criarSessao(u.id) };
    },
    reautenticar(usuarioId, senha, ip) {
      limitar('exclusao', usuarioId, ip);
      const u = db.get('SELECT senha_hash FROM usuarios WHERE id = ?', usuarioId);
      if (!u || typeof senha !== 'string' || senha.length > 256 || !conferirSenha(senha, u.senha_hash)) throw new ErroApp(401, 'Senha incorreta. A conta não foi excluída.');
    },
    async recuperar(email, ip) {
      limitar('recuperacao', normalizarEmail(email), ip);
      if (typeof entregarRecuperacao !== 'function') throw new ErroApp(503, 'Recuperação de senha indisponível. O responsável precisa configurar a entrega de mensagens.');
      db.run('DELETE FROM recuperacoes_senha WHERE expira_em <= ?', agora());
      const u = db.get('SELECT id, email FROM usuarios WHERE email = ?', normalizarEmail(email));
      if (!u) return;
      const token = tokenAleatorio();
      const tokenHash = hashToken(`recuperacao:${token}`);
      const expiraEm = new Date(Date.now() + recuperacaoTtlMs).toISOString();
      db.transacao(() => {
        db.run('DELETE FROM recuperacoes_senha WHERE usuario_id = ?', u.id);
        db.run('INSERT INTO recuperacoes_senha (token_hash, usuario_id, expira_em) VALUES (?,?,?)', tokenHash, u.id, expiraEm);
      });
      try { await entregarRecuperacao({ email: u.email, token, expiraEm }); }
      catch {
        db.run('DELETE FROM recuperacoes_senha WHERE token_hash = ?', tokenHash);
        // Mesmo resultado público, para não revelar a existência da conta.
        relatarFalhaEntrega();
      }
    },
    redefinir(token, senha, ip) {
      limitar('redefinicao', null, ip, 10);
      validarSenha(senha);
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ErroApp(422, 'Link inválido ou expirado. Solicite outra recuperação.');
      const tokenHash = hashToken(`recuperacao:${token}`);
      const senhaHash = hashSenha(senha);
      return db.transacao(() => {
        const r = db.get('SELECT usuario_id FROM recuperacoes_senha WHERE token_hash = ? AND expira_em > ?', tokenHash, agora());
        if (!r) throw new ErroApp(422, 'Link inválido ou expirado. Solicite outra recuperação.');
        db.run('UPDATE usuarios SET senha_hash = ? WHERE id = ?', senhaHash, r.usuario_id);
        db.run('DELETE FROM recuperacoes_senha WHERE usuario_id = ?', r.usuario_id);
        db.run('DELETE FROM sessoes WHERE usuario_id = ?', r.usuario_id);
        return r.usuario_id;
      });
    },
    sair: (token) => token && db.run('DELETE FROM sessoes WHERE token_hash = ?', hashToken(token)),
    usuarioDaSessao(token) {
      if (!token) return null;
      const s = db.get('SELECT s.usuario_id, s.expira_em, u.email FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = ?', hashToken(token));
      if (!s || s.expira_em <= agora()) return null;
      return { id: s.usuario_id, email: s.email };
    },
  };
}
