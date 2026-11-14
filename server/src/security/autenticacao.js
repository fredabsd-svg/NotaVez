import { randomBytes } from 'node:crypto';
import { agora, novoId } from '../db/banco.js';
import { conferirSenha, hashSenha, hashToken, tokenAleatorio, cifrar, decifrar, indiceCego } from './cripto.js';
import { ErroApp } from '../util/erros.js';
import { lerDocumento, formatarDocumento } from '../util/documentos.js';

export const COOKIE = 'nv_sessao';
// "Manter conectado": 90 dias desde o último uso (renovada no máximo 1 vez por dia).
// Sem marcar: 12 horas e cookie que some ao fechar o navegador.
const DURACAO_MS = 90 * 86400_000;
const DURACAO_CURTA_MS = 12 * 3600_000;
const RENOVAR_APOS_MS = 86400_000;

export function opcoesCookie(lembrar, seguro) {
  return { httpOnly: true, secure: seguro, sameSite: 'strict', path: '/', ...(lembrar ? { maxAge: DURACAO_MS / 1000 } : {}) };
}
const JANELA_MS = 15 * 60_000;
const normalizarEmail = (email) => String(email || '').trim().toLowerCase();
// Usuário do login: e-mail ou CPF/CNPJ (como no Portal da NFS-e). Índices cegos separados por uso.
const indiceDocumento = (numero) => indiceCego(`usuario:${numero}`);
const indiceGovbr = (cpf) => indiceCego(`govbr:${cpf}`);
// Conta criada pelo gov.br sem e-mail informado: endereço interno, nunca usado para envio.
const SEM_EMAIL = '@sem-email.nota-sem-stress.invalid';
const semEmail = (email) => String(email).endsWith(SEM_EMAIL);
// Chave dos limites de tentativa: a mesma para qualquer grafia do e-mail ou do CPF/CNPJ.
const chaveIdentificador = (x) => (String(x || '').includes('@') ? normalizarEmail(x) : String(x || '').toUpperCase().replace(/[^0-9A-Z]/g, ''));
const validarSenha = (senha) => {
  if (typeof senha !== 'string' || senha.length < 8 || senha.length > 256) throw new ErroApp(422, 'A senha precisa ter entre 8 e 256 caracteres.');
};

export function criarAutenticacao(db, { entregarRecuperacao, recuperacaoTtlMs = 30 * 60_000, relatarFalhaEntrega = () => {} } = {}) {
  const modoRecuperacao = typeof entregarRecuperacao === 'function' ? (entregarRecuperacao.modo || 'email') : null;
  // Instalado também nos bancos existentes; não guarda tokens ou IPs em claro.
  // Tabelas em db/schema.sql (recuperacoes_senha, limites_conta, aparelhos_confiaveis).
  if (!Number.isFinite(recuperacaoTtlMs) || recuperacaoTtlMs <= 0 || recuperacaoTtlMs > 86400_000) throw new Error('TTL de recuperação inválido.');

  // ip === false: limite só da identidade (não cria um contador de IP compartilhado).
  const chavesLimite = (acao, identidade, ip) => [...(ip === false ? [] : [`${acao}:ip:${ip || 'desconhecido'}`]), ...(identidade ? [`${acao}:identidade:${identidade}`] : [])].map(hashToken);
  async function conferirLimite(acao, identidade, ip, max) {
    await db.run('DELETE FROM limites_conta WHERE ate_ms <= ?', Date.now());
    for (const chave of chavesLimite(acao, identidade, ip)) {
      const r = await db.get('SELECT quantidade FROM limites_conta WHERE chave_hash = ?', chave);
      if (r && r.quantidade >= max) throw new ErroApp(429, 'Muitas tentativas. Aguarde 15 minutos e tente de novo.');
    }
  }
  async function contarLimite(acao, identidade, ip) {
    const ate = Date.now() + JANELA_MS;
    for (const chave of chavesLimite(acao, identidade, ip)) await db.run('INSERT INTO limites_conta (chave_hash, quantidade, ate_ms) VALUES (?,1,?) ON CONFLICT(chave_hash) DO UPDATE SET quantidade = limites_conta.quantidade + 1', chave, ate);
  }
  async function limitar(acao, identidade, ip, max = 5) {
    await db.transacao(async () => { await conferirLimite(acao, identidade, ip, max); await contarLimite(acao, identidade, ip); });
  }
  // Nova senha (por link ou código): derruba sessões e aparelhos conhecidos e desfaz vínculos de terceiros.
  async function trocarSenha(usuarioId, senhaHash) {
    await db.run('UPDATE usuarios SET senha_hash = ? WHERE id = ?', senhaHash, usuarioId);
    await db.run('DELETE FROM recuperacoes_senha WHERE usuario_id = ?', usuarioId);
    await db.run('DELETE FROM sessoes WHERE usuario_id = ?', usuarioId);
    await db.run('DELETE FROM aparelhos_confiaveis WHERE usuario_id = ?', usuarioId);
    // Quem redefine a senha retoma a conta: um gov.br vinculado por outra pessoa não pode continuar entrando.
    // O CPF "confirmado" que veio desse gov.br também sai (era a identidade de quem vinculou).
    // Só o CPF que entrou pelo vínculo do gov.br; o que o titular digitou no cadastro continua.
    const u = await db.get('SELECT documento_cifrado, documento_origem, govbr_indice FROM usuarios WHERE id = ?', usuarioId);
    // Contas anteriores ao registro da origem (NULL): vale a regra antiga, mais segura.
    if (u?.govbr_indice && (u.documento_origem === 'vinculo_govbr' || u.documento_origem == null) && u.documento_cifrado && indiceGovbr(decifrar(u.documento_cifrado)) === u.govbr_indice) {
      await db.run('UPDATE usuarios SET tipo_documento = NULL, documento_cifrado = NULL, documento_indice = NULL, documento_verificado = 0, documento_origem = NULL WHERE id = ?', usuarioId);
    }
    await db.run('UPDATE usuarios SET govbr_indice = NULL WHERE id = ?', usuarioId);
    await db.run('DELETE FROM govbr_fluxos WHERE usuario_id = ?', usuarioId);
  }
  const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const normalizarCodigo = (c) => { const x = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return x.length === 20 ? x : null; };
  async function gravarCodigo(usuarioId) {
    const bytes = randomBytes(20);
    const c = [...bytes].map((b) => ALFABETO_CODIGO[b % ALFABETO_CODIGO.length]).join('');
    await db.run('UPDATE usuarios SET codigo_recuperacao_hash = ? WHERE id = ?', hashToken(`codigo:${c}`), usuarioId);
    return c.match(/.{5}/g).join('-');
  }
  // Aparelho onde o dono já entrou (cookie próprio de cada conta, guardado só como hash):
  // num computador compartilhado, a entrada de outra conta não apaga a marca desta.
  const nomeCookieAparelho = (usuarioId) => `nv_ap_${hashToken(`nome-aparelho:${usuarioId}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;
  async function marcarAparelho(usuarioId) {
    const t = tokenAleatorio();
    await db.transacao(async () => {
      // Vale 400 dias e no máximo 20 aparelhos por conta (os mais antigos saem).
      await db.run('DELETE FROM aparelhos_confiaveis WHERE criado_em < ?', new Date(Date.now() - 400 * 86400_000).toISOString());
      await db.run('INSERT INTO aparelhos_confiaveis (token_hash, usuario_id, criado_em) VALUES (?,?,?)', hashToken(`aparelho:${t}`), usuarioId, agora());
      await db.run(`DELETE FROM aparelhos_confiaveis WHERE usuario_id = ? AND token_hash NOT IN
        (SELECT token_hash FROM aparelhos_confiaveis WHERE usuario_id = ? ORDER BY criado_em DESC, ordem DESC LIMIT 20)`, usuarioId, usuarioId);
    });
    return t;
  }
  async function criarSessao(usuarioId, lembrar = true) {
    const token = tokenAleatorio();
    await db.run('INSERT INTO sessoes (token_hash, usuario_id, criado_em, expira_em, lembrar) VALUES (?,?,?,?,?)', hashToken(token), usuarioId, agora(),
      new Date(Date.now() + (lembrar ? DURACAO_MS : DURACAO_CURTA_MS)).toISOString(), lembrar ? 1 : 0);
    return token;
  }
  async function usuarioPorIdentificador(identificador) {
    const texto = String(identificador || '').trim();
    if (texto.includes('@')) return await db.get('SELECT id, email, senha_hash, codigo_recuperacao_hash FROM usuarios WHERE email = ?', normalizarEmail(texto));
    const doc = lerDocumento(texto);
    return doc ? await db.get('SELECT id, email, senha_hash, codigo_recuperacao_hash FROM usuarios WHERE documento_indice = ?', indiceDocumento(doc.numero)) : null;
  }

  return {
    DURACAO_MS,
    // Dados do titular para a tela de conta (sem expor índices).
    async titular(usuarioId) {
      const u = await db.get('SELECT email, tipo_documento, documento_cifrado, documento_verificado, nome, govbr_indice, codigo_recuperacao_hash FROM usuarios WHERE id = ?', usuarioId);
      if (!u) return null;
      const documento = decifrar(u.documento_cifrado);
      return {
        email: semEmail(u.email) ? null : u.email, nome: u.nome, tipoDocumento: u.tipo_documento,
        documentoFormatado: documento ? formatarDocumento(u.tipo_documento, documento) : null,
        documentoVerificado: !!u.documento_verificado, govbr: !!u.govbr_indice, temCodigoRecuperacao: !!u.codigo_recuperacao_hash,
      };
    },

    // ---------- gov.br (Login Único) ----------
    // O CPF vem do id_token já validado (security/govbr.js). Conta só é achada
    // pelo vínculo gov.br; CPF ou e-mail iguais em conta com senha exigem que o
    // titular entre com a senha e vincule, para nunca juntar contas sozinho.
    async entrarGovbr({ cpf, nome, email, emailVerificado }) {
      const vinculado = await db.get('SELECT id FROM usuarios WHERE govbr_indice = ?', indiceGovbr(cpf));
      if (vinculado) return { usuarioId: vinculado.id, token: await criarSessao(vinculado.id), novo: false };
      const emailOk = emailVerificado && email ? normalizarEmail(email) : null;
      if (await db.get('SELECT 1 FROM usuarios WHERE documento_indice = ?', indiceDocumento(cpf)) || (emailOk && await db.get('SELECT 1 FROM usuarios WHERE email = ?', emailOk))) {
        throw new ErroApp(409, 'Já existe uma conta com este CPF ou e-mail. Entre com sua senha e vincule o gov.br em Conta.', { codigo: 'GOVBR_VINCULAR' });
      }
      const id = novoId();
      return await db.transacao(async () => {
        await db.run(`INSERT INTO usuarios (id, email, senha_hash, criado_em, tipo_documento, documento_cifrado, documento_indice, documento_verificado, nome, govbr_indice, documento_origem)
          VALUES (?,?,?,?,?,?,?,1,?,?,'govbr_conta')`, id, emailOk || `govbr-${indiceGovbr(cpf).slice(0, 16)}${SEM_EMAIL}`,
        // Senha aleatória descartada: quem entra pelo gov.br não tem senha até pedir uma.
        hashSenha(tokenAleatorio()), agora(), 'CPF', cifrar(cpf), indiceDocumento(cpf), String(nome || '').trim().slice(0, 200) || null, indiceGovbr(cpf));
        return { usuarioId: id, token: await criarSessao(id), novo: true };
      });
    },
    async vincularGovbr(usuarioId, { cpf }) {
      return await db.transacao(async () => {
        const outro = await db.get('SELECT id FROM usuarios WHERE govbr_indice = ?', indiceGovbr(cpf));
        if (outro && outro.id !== usuarioId) throw new ErroApp(409, 'Esta conta gov.br já está vinculada a outro acesso do Nota Sem Stress.', { codigo: 'GOVBR_EM_USO' });
        const u = await db.get('SELECT documento_indice FROM usuarios WHERE id = ?', usuarioId);
        if (!u) throw new ErroApp(404, 'Conta não encontrada.');
        const donoDoCpf = await db.get('SELECT id FROM usuarios WHERE documento_indice = ? AND id <> ?', indiceDocumento(cpf), usuarioId);
        await db.run('UPDATE usuarios SET govbr_indice = ? WHERE id = ?', indiceGovbr(cpf), usuarioId);
        // Sem usuário CPF/CNPJ ainda: o CPF confirmado pelo gov.br passa a ser o usuário.
        if (!u.documento_indice && !donoDoCpf) {
          await db.run("UPDATE usuarios SET tipo_documento = 'CPF', documento_cifrado = ?, documento_indice = ?, documento_verificado = 1, documento_origem = 'vinculo_govbr' WHERE id = ?", cifrar(cpf), indiceDocumento(cpf), usuarioId);
        } else if (u.documento_indice === indiceDocumento(cpf)) {
          await db.run('UPDATE usuarios SET documento_verificado = 1 WHERE id = ?', usuarioId);
        }
      });
    },
    // Confere que o CPF autenticado agora no gov.br é o vinculado à conta (reautenticação).
    govbrConfere: async (usuarioId, cpf) => !!await db.get('SELECT 1 FROM usuarios WHERE id = ? AND govbr_indice = ?', usuarioId, indiceGovbr(cpf)),
    desvincularGovbr: async (usuarioId) => await db.run('UPDATE usuarios SET govbr_indice = NULL WHERE id = ?', usuarioId),

    // Primeiro acesso: CPF/CNPJ (usuário), e-mail (para recuperar a senha) e senha.
    async cadastrar(email, senha, ip, { documento, nome, lembrar = true } = {}) {
      await limitar('cadastro', null, ip, 10);
      email = normalizarEmail(email);
      if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ErroApp(422, 'Informe um e-mail válido.');
      const doc = documento ? lerDocumento(documento) : null;
      if (documento && !doc) throw new ErroApp(422, 'CPF ou CNPJ inválido. Confira os números.');
      validarSenha(senha);
      if (await db.get('SELECT 1 FROM usuarios WHERE email = ?', email)) throw new ErroApp(409, 'Já existe uma conta com este e-mail. Entre com sua senha.');
      if (doc && await db.get('SELECT 1 FROM usuarios WHERE documento_indice = ?', indiceDocumento(doc.numero))) {
        throw new ErroApp(409, `Já existe um acesso com este ${doc.tipo}. Entre com sua senha ou use "Esqueci a minha senha".`);
      }
      const id = novoId();
      return await db.transacao(async () => {
        await db.run('INSERT INTO usuarios (id, email, senha_hash, criado_em, tipo_documento, documento_cifrado, documento_indice, nome, documento_origem) VALUES (?,?,?,?,?,?,?,?,?)',
          id, email, hashSenha(senha), agora(), doc?.tipo ?? null, doc ? cifrar(doc.numero) : null, doc ? indiceDocumento(doc.numero) : null,
          String(nome || '').trim().slice(0, 200) || null, doc ? 'digitado' : null);
        return { usuarioId: id, token: await criarSessao(id, lembrar), lembrar, codigoRecuperacao: await gravarCodigo(id) };
      });
    },
    // Só tentativas ERRADAS contam: um escritório com muita gente atrás do mesmo IP não se tranca.
    // Limites: conta+IP (15), IP (50) e conta em qualquer IP (100). O aparelho onde o dono já
    // entrou (cookie próprio por conta) fica isento: tentativas de terceiros não o trancam.
    // Identificador inexistente tem os mesmos limites (sem revelar se a conta existe).
    async entrar(identificador, senha, ip, { lembrar = true, cookieAparelho = () => null } = {}) {
      // Limite por CONTA quando ela existe: e-mail e CPF da mesma conta somam tentativas.
      const u = await usuarioPorIdentificador(identificador);
      const quem = u ? `conta:${u.id}` : `id:${chaveIdentificador(identificador)}`;
      const aparelho = u ? cookieAparelho(nomeCookieAparelho(u.id)) : null;
      const confiavel = !!(u && typeof aparelho === 'string' && aparelho.length === 43
        && await db.get('SELECT 1 FROM aparelhos_confiaveis WHERE token_hash = ? AND usuario_id = ? AND criado_em >= ?', hashToken(`aparelho:${aparelho}`), u.id, new Date(Date.now() - 400 * 86400_000).toISOString()));
      // Aparelho conhecido tem um contador só dele (quem não tem o cookie não consegue gastá-lo).
      const limites = confiavel ? [['entrada', `${quem}:aparelho:${hashToken(aparelho)}`, false, 15]]
        : [['entrada', `${quem}:ip:${ip}`, false, 15], ['entrada-ip', null, ip, 50], ['entrada-conta', quem, false, 100]];
      for (const [acao, id, ipL, max] of limites) await conferirLimite(acao, id, ipL, max);
      if (!u || typeof senha !== 'string' || senha.length > 256 || !conferirSenha(senha, u.senha_hash)) {
        await db.transacao(async () => { for (const [acao, id, ipL] of limites) await contarLimite(acao, id, ipL); });
        throw new ErroApp(401, 'Usuário ou senha incorretos.');
      }
      return { usuarioId: u.id, token: await criarSessao(u.id, lembrar), lembrar, aparelho: confiavel ? null : await marcarAparelho(u.id), nomeAparelho: nomeCookieAparelho(u.id) };
    },
    nomeCookieAparelho: (usuarioId) => nomeCookieAparelho(usuarioId),
    marcarAparelho: async (usuarioId) => await marcarAparelho(usuarioId),
    async reautenticar(usuarioId, senha, ip, mensagem = 'Senha incorreta. A conta não foi excluída.') {
      await limitar('exclusao', usuarioId, ip);
      const u = await db.get('SELECT senha_hash FROM usuarios WHERE id = ?', usuarioId);
      if (!u || typeof senha !== 'string' || senha.length > 256 || !conferirSenha(senha, u.senha_hash)) throw new ErroApp(401, mensagem);
    },
    async recuperar(identificador, ip) {
      const alvo = await usuarioPorIdentificador(identificador);
      await limitar('recuperacao', alvo ? `conta:${alvo.id}` : chaveIdentificador(identificador), ip);
      if (typeof entregarRecuperacao !== 'function') throw new ErroApp(503, 'O envio do link por e-mail não está configurado neste servidor. Use o código de recuperação, mais abaixo.');
      await db.run('DELETE FROM recuperacoes_senha WHERE expira_em <= ?', agora());
      const u = await usuarioPorIdentificador(identificador);
      // Conta criada pelo gov.br sem e-mail: não há para onde mandar (no terminal local, há).
      if (!u || (semEmail(u.email) && modoRecuperacao !== 'terminal')) return;
      const token = tokenAleatorio();
      const tokenHash = hashToken(`recuperacao:${token}`);
      const expiraEm = new Date(Date.now() + recuperacaoTtlMs).toISOString();
      await db.transacao(async () => {
        await db.run('DELETE FROM recuperacoes_senha WHERE usuario_id = ?', u.id);
        await db.run('INSERT INTO recuperacoes_senha (token_hash, usuario_id, expira_em) VALUES (?,?,?)', tokenHash, u.id, expiraEm);
      });
      try { await entregarRecuperacao({ email: u.email, token, expiraEm }); }
      catch {
        await db.run('DELETE FROM recuperacoes_senha WHERE token_hash = ?', tokenHash);
        // Mesmo resultado público, para não revelar a existência da conta.
        relatarFalhaEntrega();
      }
    },
    async redefinir(token, senha, ip) {
      await limitar('redefinicao', null, ip, 10);
      validarSenha(senha);
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ErroApp(422, 'Link inválido ou expirado. Solicite outra recuperação.');
      const tokenHash = hashToken(`recuperacao:${token}`);
      const senhaHash = hashSenha(senha);
      return await db.transacao(async () => {
        const r = await db.get('SELECT usuario_id FROM recuperacoes_senha WHERE token_hash = ? AND expira_em > ?', tokenHash, agora());
        if (!r) throw new ErroApp(422, 'Link inválido ou expirado. Solicite outra recuperação.');
        await trocarSenha(r.usuario_id, senhaHash);
        return r.usuario_id;
      });
    },
    // Recuperação sem e-mail: o código entregue no primeiro acesso (ou gerado em Conta).
    // Uso único: depois de trocar a senha, um código novo é devolvido para guardar.
    async redefinirComCodigo(identificador, codigo, senha, ip) {
      const u = await usuarioPorIdentificador(identificador);
      await limitar('redefinicao-codigo', u ? `conta:${u.id}` : chaveIdentificador(identificador), ip, 5);
      validarSenha(senha);
      const c = normalizarCodigo(codigo);
      const ok = u && c && u.codigo_recuperacao_hash && hashToken(`codigo:${c}`) === u.codigo_recuperacao_hash;
      if (!ok) throw new ErroApp(422, 'Usuário ou código de recuperação incorretos.');
      const senhaHash = hashSenha(senha);
      return await db.transacao(async () => {
        await trocarSenha(u.id, senhaHash);
        return { usuarioId: u.id, codigo: await gravarCodigo(u.id) };
      });
    },
    gerarCodigoRecuperacao: async (usuarioId) => await gravarCodigo(usuarioId),
    temCodigoRecuperacao: async (usuarioId) => !!(await db.get('SELECT codigo_recuperacao_hash AS c FROM usuarios WHERE id = ?', usuarioId))?.c,
    modoRecuperacao,
    sair: async (token) => token && await db.run('DELETE FROM sessoes WHERE token_hash = ?', hashToken(token)),
    async usuarioDaSessao(token) {
      if (!token) return null;
      const h = hashToken(token);
      const s = await db.get('SELECT s.usuario_id, s.expira_em, s.lembrar, u.email FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id WHERE s.token_hash = ?', h);
      if (!s || s.expira_em <= agora()) return null;
      // Uso diário mantém a sessão viva: quem entrou com "manter conectado" não precisa entrar de novo.
      let renovada = false;
      if (s.lembrar && new Date(s.expira_em).getTime() - Date.now() < DURACAO_MS - RENOVAR_APOS_MS) {
        await db.run('UPDATE sessoes SET expira_em = ? WHERE token_hash = ?', new Date(Date.now() + DURACAO_MS).toISOString(), h);
        renovada = true;
      }
      return { id: s.usuario_id, email: s.email, renovada };
    },
  };
}
