import { randomBytes } from 'node:crypto';
import { COOKIE } from '../security/autenticacao.js';
import { auditar } from '../security/auditoria.js';
import { excluirConta } from '../conta/exclusao.js';
import { criarGovbr } from '../security/govbr.js';
import { criarLoginCertificado, ErroLoginCertificado } from '../security/certificado-login.js';
import { ErroApp } from '../util/erros.js';
import { config } from '../config.js';

// Cookie que prende uma entrada por gov.br/certificado ao navegador que a
// começou (SameSite=Lax: precisa voltar no redirecionamento do gov.br).
const COOKIE_LOGIN = 'nv_login';

export async function rotasConta(app) {
  const { auth, db, contas, limites } = app.ctx;
  // Etapas de login por GET (redirecionamentos) também têm limite por IP.
  const limitar = (req) => limites?.consumir(`login-externo:ip:${req.ip}`, 60, 15 * 60_000);
  const govbr = app.ctx.govbr ? criarGovbr(app.ctx.govbr, { fetchImpl: app.ctx.govbrFetch }) : null;
  const certificado = app.ctx.certificadoLogin ? criarLoginCertificado(app.ctx.certificadoLogin) : null;
  const appOrigem = (app.ctx.appOrigem ?? config.appOrigem).replace(/\/$/, '');
  if (certificado && !appOrigem) throw new Error('Login com certificado: defina NOTAVEZ_APP_ORIGEM (endereço público do app).');

  const gravarCookie = (reply, token) => reply.setCookie(COOKIE, token, {
    httpOnly: true, secure: config.cookieSeguro, sameSite: 'strict', path: '/', maxAge: auth.DURACAO_MS / 1000,
  });
  const novoNavegador = (reply) => {
    const valor = randomBytes(32).toString('base64url');
    reply.setCookie(COOKIE_LOGIN, valor, { httpOnly: true, secure: config.cookieSeguro, sameSite: 'lax', path: '/api/conta', maxAge: 600 });
    return valor;
  };
  const limparNavegador = (reply) => reply.clearCookie(COOKIE_LOGIN, { path: '/api/conta' });
  // Destinos fixos dentro do app: nada de redirecionamento aberto.
  const voltar = (reply, destino) => reply.redirect(`${appOrigem}/#/${destino}`, 302);

  app.post('/cadastrar', async (req, reply) => {
    const { usuarioId, token } = auth.cadastrar(req.body?.email, req.body?.senha, req.ip);
    auditar(db, { usuarioId, acao: 'conta.cadastro', detalhes: { metodo: 'senha' }, ip: req.ip });
    gravarCookie(reply, token);
    return { ok: true, usuarioId };
  });
  app.post('/entrar', async (req, reply) => {
    const { usuarioId, token } = auth.entrar(req.body?.email, req.body?.senha, req.ip);
    auditar(db, { usuarioId, acao: 'conta.entrada', detalhes: { metodo: 'senha' }, ip: req.ip });
    gravarCookie(reply, token);
    return { ok: true, usuarioId };
  });
  app.post('/sair', async (req, reply) => {
    auth.sair(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/', async (req) => ({
    usuarioId: req.usuario.id, prestadorId: req.prestador?.id ?? null, email: req.usuario.email, temPerfil: !!req.prestador,
    metodo: req.usuario.metodo, temSenha: auth.temSenha(req.usuario.id),
  }));

  // Formas de entrar disponíveis neste servidor (tela de entrada).
  app.get('/metodos', async () => ({ senha: true, govbr: !!govbr, certificado: !!certificado }));

  // ---------- Formas de entrar vinculadas à conta ----------
  app.get('/identidades', async (req) => ({ identidades: auth.identidades(req.usuario.id), temSenha: auth.temSenha(req.usuario.id) }));
  app.delete('/identidades/:id', async (req) => {
    auth.reautenticar(req.usuario.id, req.body?.senha, req.ip, req.usuario);
    auth.removerIdentidade(req.usuario.id, req.params.id);
    auditar(db, { usuarioId: req.usuario.id, acao: 'conta.identidade_removida', ip: req.ip });
    return { identidades: auth.identidades(req.usuario.id) };
  });

  // ---------- Entrar com gov.br ----------
  app.get('/govbr/entrar', async (req, reply) => {
    limitar(req);
    if (!govbr) return voltar(reply, 'entrar?erro=govbr-indisponivel');
    const vincular = req.query?.vincular === '1';
    if (vincular && !req.usuario) return voltar(reply, 'entrar');
    const pedido = govbr.novoPedido();
    const navegador = novoNavegador(reply);
    const state = auth.criarPendente('govbr', { ...pedido, vincular: vincular ? req.usuario.id : null }, { navegador });
    return reply.redirect(govbr.urlAutorizacao(state, pedido), 302);
  });
  app.get('/govbr/retorno', async (req, reply) => {
    limitar(req);
    const q = req.query || {};
    const pedido = auth.consumirPendente('govbr', q.state, { navegador: req.cookies[COOKIE_LOGIN] });
    limparNavegador(reply);
    if (!govbr || !pedido) return voltar(reply, 'entrar?erro=govbr-expirado');
    if (q.error) return voltar(reply, pedido.vincular ? 'conta?erro=govbr-cancelado' : 'entrar?erro=govbr-cancelado');
    let cpf;
    try {
      cpf = (await govbr.validarIdToken(await govbr.trocarCodigo(q.code, pedido.verificador), pedido.nonce)).cpf;
    } catch (e) {
      req.log?.warn({ motivo: e.message }, 'gov.br recusado');
      return voltar(reply, pedido.vincular ? 'conta?erro=govbr' : 'entrar?erro=govbr');
    }
    return concluirIdentidade(req, reply, { tipoDocumento: 'CPF', documento: cpf, metodo: 'govbr', vincular: pedido.vincular });
  });

  // ---------- Entrar com certificado digital ----------
  // 1) no app: prende o pedido a este navegador e manda para o host do certificado.
  app.get('/certificado/iniciar', async (req, reply) => {
    limitar(req);
    if (!certificado) return voltar(reply, 'entrar?erro=certificado-indisponivel');
    const vincular = req.query?.vincular === '1';
    if (vincular && !req.usuario) return voltar(reply, 'entrar');
    const navegador = novoNavegador(reply);
    const pedido = auth.criarPendente('certificado-pedido', { vincular: vincular ? req.usuario.id : null }, { navegador });
    return reply.redirect(`${certificado.origem}/api/conta/certificado/entrar?pedido=${pedido}`, 302);
  });
  // 2) no host do certificado (atrás do proxy que pediu o certificado ao navegador).
  app.get('/certificado/entrar', async (req, reply) => {
    limitar(req);
    if (!certificado) return reply.code(404).send({ erro: 'Login com certificado não configurado.' });
    let identidade;
    try {
      identidade = certificado.identidade(req.headers);
    } catch (e) {
      if (e instanceof ErroLoginCertificado && e.codigo === 'proxy') throw new ErroApp(403, 'Acesso recusado.');
      req.log?.warn({ motivo: e.codigo || 'erro' }, 'certificado recusado');
      return voltar(reply, `entrar?erro=certificado&motivo=${encodeURIComponent(e.codigo || 'erro')}`);
    }
    const pedido = String(req.query?.pedido || '');
    if (!/^[A-Za-z0-9_-]{43}$/.test(pedido)) return voltar(reply, 'entrar?erro=certificado-expirado');
    const ticket = auth.criarPendente('certificado-ticket', { pedido, ...identidade }, { validadeMs: 2 * 60_000 });
    return reply.redirect(`${appOrigem}/api/conta/certificado/concluir?ticket=${ticket}`, 302);
  });
  // 3) de volta no app: só o navegador que começou consegue concluir.
  app.get('/certificado/concluir', async (req, reply) => {
    limitar(req);
    const ticket = auth.consumirPendente('certificado-ticket', req.query?.ticket);
    const pedido = ticket && auth.consumirPendente('certificado-pedido', ticket.pedido, { navegador: req.cookies[COOKIE_LOGIN] });
    limparNavegador(reply);
    if (!certificado || !pedido) return voltar(reply, 'entrar?erro=certificado-expirado');
    return concluirIdentidade(req, reply, { tipoDocumento: ticket.tipoDocumento, documento: ticket.documento, metodo: 'certificado', vincular: pedido.vincular });
  });

  function concluirIdentidade(req, reply, { tipoDocumento, documento, metodo, vincular }) {
    if (vincular) {
      // O pedido foi criado com a sessão aberta e está preso a este navegador
      // (cookie nv_login). O cookie de sessão (SameSite=Strict) não volta no
      // redirecionamento vindo do gov.br, então a prova é o próprio pedido.
      try {
        auth.vincularIdentidade(vincular, { tipoDocumento, documento, metodo });
      } catch (e) {
        if (e instanceof ErroApp && e.extra?.codigo === 'IDENTIDADE_EM_OUTRA_CONTA') return voltar(reply, `conta?erro=${metodo}-outra-conta`);
        throw e;
      }
      auditar(db, { usuarioId: vincular, acao: 'conta.identidade_vinculada', detalhes: { metodo, tipoDocumento }, ip: req.ip });
      return voltar(reply, `conta?vinculado=${metodo}`);
    }
    const { usuarioId, token, nova } = auth.entrarComIdentidade({ tipoDocumento, documento, metodo });
    auditar(db, { usuarioId, acao: nova ? 'conta.cadastro' : 'conta.entrada', detalhes: { metodo, tipoDocumento }, ip: req.ip });
    gravarCookie(reply, token);
    // "entrada=" avisa o app que há uma sessão nova para conferir com o servidor.
    return voltar(reply, `${nova ? 'perfil' : ''}?entrada=${metodo}`);
  }

  app.delete('/', async (req, reply) => {
    auth.reautenticar(req.usuario.id, req.body?.senha, req.ip, req.usuario);
    const r = excluirConta({ central: db, contas, usuarioId: req.usuario.id, ip: req.ip });
    reply.clearCookie(COOKIE, { path: '/' });
    return r;
  });
  app.post('/recuperar', async (req) => {
    await auth.recuperar(req.body?.email, req.ip);
    return { ok: true, mensagem: 'Se o e-mail estiver cadastrado, enviaremos as instruções de recuperação.' };
  });
  app.post('/redefinir', async (req, reply) => {
    const usuarioId = auth.redefinir(req.body?.token, req.body?.senha, req.ip);
    auditar(db, { usuarioId, acao: 'conta.senha_redefinida', ip: req.ip });
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/transparencia', async () => {
    const { responsavel = '', contatoPrivacidade = '', retencao = '' } = app.ctx.contaPublica || {};
    return { responsavel, contatoPrivacidade, retencao, configurada: !!(responsavel && contatoPrivacidade && retencao) };
  });
}
