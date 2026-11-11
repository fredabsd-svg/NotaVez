import { COOKIE } from '../security/autenticacao.js';
import { auditar } from '../security/auditoria.js';
import { excluirConta } from '../conta/exclusao.js';
import { config } from '../config.js';

export async function rotasConta(app) {
  const { auth, db } = app.ctx;
  const gravarCookie = (reply, token) => reply.setCookie(COOKIE, token, {
    httpOnly: true, secure: config.cookieSeguro, sameSite: 'strict', path: '/', maxAge: auth.DURACAO_MS / 1000,
  });
  app.post('/cadastrar', async (req, reply) => {
    const { usuarioId, token } = auth.cadastrar(req.body?.email, req.body?.senha, req.ip);
    auditar(db, { usuarioId, acao: 'conta.cadastro', ip: req.ip });
    gravarCookie(reply, token);
    return { ok: true, usuarioId };
  });
  app.post('/entrar', async (req, reply) => {
    const { usuarioId, token } = auth.entrar(req.body?.email, req.body?.senha, req.ip);
    auditar(db, { usuarioId, acao: 'conta.entrada', ip: req.ip });
    gravarCookie(reply, token);
    return { ok: true, usuarioId };
  });
  app.post('/sair', async (req, reply) => {
    auth.sair(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/', async (req) => ({ usuarioId: req.usuario.id, prestadorId: req.prestador?.id ?? null, email: req.usuario.email, temPerfil: !!req.prestador }));
  app.delete('/', async (req, reply) => {
    auth.reautenticar(req.usuario.id, req.body?.senha, req.ip);
    const prestadores = db.all('SELECT id FROM prestadores WHERE usuario_id = ?', req.usuario.id);
    const r = excluirConta(db, req.usuario.id);
    for (const p of prestadores) app.ctx.emissao.fecharClientesDoPrestador(p.id);
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
