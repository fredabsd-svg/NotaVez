import { agora, novoId } from '../db/banco.js';
import { conferirSenha, hashSenha, hashToken, tokenAleatorio, novaChaveConta, cifrar, decifrar, decifrarJson, indiceCego } from './cripto.js';
import { ErroApp } from '../util/erros.js';

export const COOKIE = 'nv_sessao';
const DURACAO_MS = 30 * 86400_000;
// Sem senha (contas gov.br/certificado), ações sensíveis exigem login recente.
const REAUTENTICACAO_MS = 10 * 60_000;
const METODOS = ['senha', 'govbr', 'certificado'];
const indiceDocumento = (tipo, doc) => indiceCego(`identidade:${tipo}:${doc}`);
export function mascararIdentidade(tipo, doc) {
  if (tipo === 'CPF') return `***.${doc.slice(3, 6)}.${doc.slice(6, 9)}-**`;
  return doc.replace(/^(\w{2})(\w{3})(\w{3})(\w{4})(\w{2})$/, '$1.$2.$3/$4-$5');
}
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
  function criarSessao(usuarioId, metodo = 'senha') {
    if (!METODOS.includes(metodo)) throw new Error('Método de entrada desconhecido.');
    const token = tokenAleatorio();
    db.run('INSERT INTO sessoes (token_hash, usuario_id, criado_em, expira_em, metodo) VALUES (?,?,?,?,?)', hashToken(token), usuarioId, agora(), new Date(Date.now() + DURACAO_MS).toISOString(), metodo);
    return token;
  }
  // Toda conta nasce com a sua chave de dados (banco e criptografia próprios).
  function inserirUsuario({ email = null, senhaHash = null }) {
    const id = novoId();
    db.run('INSERT INTO usuarios (id, email, senha_hash, chave_conta, criado_em) VALUES (?,?,?,?,?)', id, email, senhaHash, novaChaveConta(id), agora());
    return id;
  }
  const identidadeDe = (r) => {
    const doc = decifrar(r.documento_cifrado);
    return { id: r.id, tipoDocumento: r.tipo_documento, documento: mascararIdentidade(r.tipo_documento, doc), metodos: JSON.parse(r.metodos), criadoEm: r.criado_em, ultimoUsoEm: r.ultimo_uso_em };
  };
  function validarIdentidade({ tipoDocumento, documento, metodo }) {
    if (!['govbr', 'certificado'].includes(metodo)) throw new Error('Método de identidade inválido.');
    if (tipoDocumento === 'CPF' ? !/^\d{11}$/.test(documento) : !(tipoDocumento === 'CNPJ' && /^[0-9A-Z]{12}\d{2}$/.test(documento))) {
      throw new ErroApp(422, 'Não foi possível ler o CPF/CNPJ comprovado.');
    }
  }
  function registrarUso(identidade, metodo) {
    const metodos = [...new Set([...JSON.parse(identidade.metodos), metodo])];
    db.run('UPDATE identidades SET metodos = ?, ultimo_uso_em = ? WHERE id = ?', JSON.stringify(metodos), agora(), identidade.id);
  }
  return {
    DURACAO_MS,
    cadastrar(email, senha, ip) {
      limitar('cadastro', null, ip, 10);
      email = normalizarEmail(email);
      if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ErroApp(422, 'Informe um e-mail válido.');
      validarSenha(senha);
      if (db.get('SELECT 1 FROM usuarios WHERE email = ?', email)) throw new ErroApp(409, 'Já existe uma conta com este e-mail. Entre com sua senha.');
      const senhaHash = hashSenha(senha);
      return db.transacao(() => {
        const id = inserirUsuario({ email, senhaHash });
        return { usuarioId: id, token: criarSessao(id, 'senha') };
      });
    },
    entrar(email, senha, ip) {
      email = normalizarEmail(email);
      limitar('entrada', email, ip, 15);
      const u = db.get('SELECT id, senha_hash FROM usuarios WHERE email = ?', email);
      if (!u?.senha_hash || typeof senha !== 'string' || senha.length > 256 || !conferirSenha(senha, u.senha_hash)) throw new ErroApp(401, 'E-mail ou senha incorretos.');
      return { usuarioId: u.id, token: criarSessao(u.id, 'senha') };
    },
    // Confirmação antes de ação irreversível: senha atual, ou (conta sem senha)
    // uma entrada por gov.br/certificado feita há menos de 10 minutos.
    reautenticar(usuarioId, senha, ip, sessao = null) {
      limitar('exclusao', usuarioId, ip);
      const u = db.get('SELECT senha_hash FROM usuarios WHERE id = ?', usuarioId);
      if (!u) throw new ErroApp(401, 'Conta não encontrada.');
      if (u.senha_hash) {
        if (typeof senha !== 'string' || senha.length > 256 || !conferirSenha(senha, u.senha_hash)) throw new ErroApp(401, 'Senha incorreta. A conta não foi excluída.');
        return;
      }
      const recente = sessao && sessao.metodo !== 'senha' && Date.now() - new Date(sessao.autenticadoEm).getTime() < REAUTENTICACAO_MS;
      if (!recente) throw new ErroApp(401, 'Por segurança, entre de novo com gov.br ou com o certificado digital e repita a operação em até 10 minutos.', { codigo: 'REAUTENTICAR' });
    },
    temSenha: (usuarioId) => !!db.get('SELECT senha_hash FROM usuarios WHERE id = ?', usuarioId)?.senha_hash,

    // ---------- Identidades comprovadas (gov.br e certificado digital) ----------
    // O mesmo CPF entra pela conta gov.br ou pelo e-CPF; o CNPJ, pelo e-CNPJ.
    entrarComIdentidade({ tipoDocumento, documento, metodo }) {
      validarIdentidade({ tipoDocumento, documento, metodo });
      const indice = indiceDocumento(tipoDocumento, documento);
      return db.transacao(() => {
        let identidade = db.get('SELECT * FROM identidades WHERE documento_indice = ?', indice);
        let nova = false;
        if (!identidade) {
          const usuarioId = inserirUsuario({});
          db.run('INSERT INTO identidades (id, usuario_id, tipo_documento, documento_indice, documento_cifrado, metodos, criado_em) VALUES (?,?,?,?,?,?,?)',
            novoId(), usuarioId, tipoDocumento, indice, cifrar(documento), JSON.stringify([]), agora());
          identidade = db.get('SELECT * FROM identidades WHERE documento_indice = ?', indice);
          nova = true;
        }
        registrarUso(identidade, metodo);
        return { usuarioId: identidade.usuario_id, token: criarSessao(identidade.usuario_id, metodo), nova };
      });
    },
    vincularIdentidade(usuarioId, { tipoDocumento, documento, metodo }) {
      validarIdentidade({ tipoDocumento, documento, metodo });
      const indice = indiceDocumento(tipoDocumento, documento);
      return db.transacao(() => {
        const existente = db.get('SELECT * FROM identidades WHERE documento_indice = ?', indice);
        if (existente && existente.usuario_id !== usuarioId) {
          throw new ErroApp(409, `Este ${tipoDocumento} já entra em outra conta do Nota Sem Stress. Entre nela ou exclua-a antes de vincular aqui.`, { codigo: 'IDENTIDADE_EM_OUTRA_CONTA' });
        }
        if (!existente) {
          db.run('INSERT INTO identidades (id, usuario_id, tipo_documento, documento_indice, documento_cifrado, metodos, criado_em) VALUES (?,?,?,?,?,?,?)',
            novoId(), usuarioId, tipoDocumento, indice, cifrar(documento), JSON.stringify([]), agora());
        }
        registrarUso(db.get('SELECT * FROM identidades WHERE documento_indice = ?', indice), metodo);
      });
    },
    identidades: (usuarioId) => db.all('SELECT * FROM identidades WHERE usuario_id = ? ORDER BY criado_em', usuarioId).map(identidadeDe),
    removerIdentidade(usuarioId, identidadeId) {
      return db.transacao(() => {
        const alvo = db.get('SELECT id FROM identidades WHERE id = ? AND usuario_id = ?', identidadeId, usuarioId);
        if (!alvo) throw new ErroApp(404, 'Forma de entrada não encontrada.');
        const restantes = db.get('SELECT COUNT(*) n FROM identidades WHERE usuario_id = ?', usuarioId).n - 1;
        if (restantes === 0 && !db.get('SELECT senha_hash FROM usuarios WHERE id = ?', usuarioId)?.senha_hash) {
          throw new ErroApp(409, 'Esta é a única forma de entrar na sua conta. Vincule outra antes de remover.');
        }
        db.run('DELETE FROM identidades WHERE id = ?', identidadeId);
      });
    },

    // ---------- Etapas de login em andamento (uso único, curta duração) ----------
    // navegador: valor aleatório num cookie do próprio navegador; impede que um
    // link de login iniciado por outra pessoa seja concluído aqui.
    criarPendente(tipo, dados, { navegador = null, validadeMs = 10 * 60_000 } = {}) {
      db.run('DELETE FROM logins_pendentes WHERE expira_em <= ?', agora());
      const id = tokenAleatorio();
      db.run('INSERT INTO logins_pendentes (id_hash, tipo, navegador_hash, dados_cifrados, expira_em) VALUES (?,?,?,?,?)',
        hashToken(`pendente:${tipo}:${id}`), tipo, navegador ? hashToken(`navegador:${navegador}`) : null, cifrar(dados), new Date(Date.now() + validadeMs).toISOString());
      return id;
    },
    consumirPendente(tipo, id, { navegador = null } = {}) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
      const idHash = hashToken(`pendente:${tipo}:${id}`);
      return db.transacao(() => {
        const r = db.get('SELECT * FROM logins_pendentes WHERE id_hash = ? AND tipo = ?', idHash, tipo);
        if (!r) return null;
        db.run('DELETE FROM logins_pendentes WHERE id_hash = ?', idHash);
        if (r.expira_em <= agora()) return null;
        if (r.navegador_hash && (!navegador || hashToken(`navegador:${navegador}`) !== r.navegador_hash)) return null;
        return decifrarJson(r.dados_cifrados);
      });
    },
    criarSessao,
    async recuperar(email, ip) {
      limitar('recuperacao', normalizarEmail(email), ip);
      if (typeof entregarRecuperacao !== 'function') throw new ErroApp(503, 'Recuperação de senha indisponível. O responsável precisa configurar a entrega de mensagens.');
      db.run('DELETE FROM recuperacoes_senha WHERE expira_em <= ?', agora());
      const u = db.get('SELECT id, email FROM usuarios WHERE email = ? AND senha_hash IS NOT NULL', normalizarEmail(email));
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
      const s = db.get('SELECT s.usuario_id, s.expira_em, s.criado_em, s.metodo, u.email FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = ?', hashToken(token));
      if (!s || s.expira_em <= agora()) return null;
      return { id: s.usuario_id, email: s.email, metodo: s.metodo || 'senha', autenticadoEm: s.criado_em };
    },
  };
}
