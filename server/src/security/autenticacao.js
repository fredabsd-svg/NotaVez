import { agora, novoId } from '../db/banco.js';
import { conferirSenha, hashSenha, hashToken, tokenAleatorio } from './cripto.js';
import { ErroApp } from '../util/erros.js';

export const COOKIE = 'nv_sessao';
const DURACAO_MS = 30 * 86400_000;
const tentativas = new Map(); // email|ip → {n, ate}

function limitar(chave) {
  const t = tentativas.get(chave);
  if (t && t.ate > Date.now() && t.n >= 5) throw new ErroApp(429, 'Muitas tentativas. Aguarde 15 minutos e tente de novo.');
}
function falhou(chave) {
  const t = tentativas.get(chave);
  const agoraMs = Date.now();
  tentativas.set(chave, !t || t.ate < agoraMs ? { n: 1, ate: agoraMs + 15 * 60_000 } : { n: t.n + 1, ate: t.ate });
}

export function criarAutenticacao(db) {
  function criarSessao(usuarioId) {
    const token = tokenAleatorio();
    db.run('INSERT INTO sessoes (token_hash, usuario_id, criado_em, expira_em) VALUES (?,?,?,?)',
      hashToken(token), usuarioId, agora(), new Date(Date.now() + DURACAO_MS).toISOString());
    return token;
  }
  return {
    DURACAO_MS,
    cadastrar(email, senha) {
      email = String(email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ErroApp(422, 'Informe um e-mail válido.');
      if (String(senha || '').length < 8) throw new ErroApp(422, 'A senha precisa ter pelo menos 8 caracteres.');
      if (db.get('SELECT 1 FROM usuarios WHERE email = ?', email)) throw new ErroApp(409, 'Já existe uma conta com este e-mail. Entre com sua senha.');
      const id = novoId();
      db.run('INSERT INTO usuarios (id, email, senha_hash, criado_em) VALUES (?,?,?,?)', id, email, hashSenha(senha), agora());
      return { usuarioId: id, token: criarSessao(id) };
    },
    entrar(email, senha, ip) {
      email = String(email || '').trim().toLowerCase();
      const chave = `${email}|${ip}`;
      limitar(chave);
      const u = db.get('SELECT id, senha_hash FROM usuarios WHERE email = ?', email);
      if (!u || !conferirSenha(String(senha || ''), u.senha_hash)) {
        falhou(chave);
        throw new ErroApp(401, 'E-mail ou senha incorretos.');
      }
      tentativas.delete(chave);
      return { usuarioId: u.id, token: criarSessao(u.id) };
    },
    sair: (token) => token && db.run('DELETE FROM sessoes WHERE token_hash = ?', hashToken(token)),
    usuarioDaSessao(token) {
      if (!token) return null;
      const s = db.get('SELECT s.usuario_id, s.expira_em, u.email FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = ?', hashToken(token));
      if (!s || s.expira_em < agora()) return null;
      return { id: s.usuario_id, email: s.email };
    },
  };
}
