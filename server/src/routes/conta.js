import { COOKIE } from '../security/autenticacao.js';
import { auditar } from '../security/auditoria.js';
import { config } from '../config.js';

export async function rotasConta(app) {
  const { auth, db } = app.ctx;
  const gravarCookie = (reply, token) => reply.setCookie(COOKIE, token, {
    httpOnly: true, secure: config.cookieSeguro, sameSite: 'strict', path: '/', maxAge: auth.DURACAO_MS / 1000,
  });

  app.post('/cadastrar', async (req, reply) => {
    const { usuarioId, token } = auth.cadastrar(req.body?.email, req.body?.senha);
    auditar(db, { usuarioId, acao: 'conta.cadastro', ip: req.ip });
    gravarCookie(reply, token);
    return { ok: true };
  });

  app.post('/entrar', async (req, reply) => {
    const { usuarioId, token } = auth.entrar(req.body?.email, req.body?.senha, req.ip);
    auditar(db, { usuarioId, acao: 'conta.entrada', ip: req.ip });
    gravarCookie(reply, token);
    return { ok: true };
  });

  app.post('/sair', async (req, reply) => {
    auth.sair(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/', async (req) => ({ email: req.usuario.email, temPerfil: !!req.prestador }));
}
