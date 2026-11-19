// E-mail das notas: configuração do envio (por conta), conexão com a conta Google ou Microsoft e envio de uma
// nota emitida ao cliente.
import { exigirPrestador } from './perfil.js';
import { ErroApp } from '../util/erros.js';
import { config } from '../config.js';
import { PROVEDORES_OAUTH } from '../email/oauth.js';

// O retorno do Google/Microsoft vem de outro site: o cookie do fluxo é Lax (o da sessão é Strict) e só vale no retorno.
const COOKIE_FLUXO = 'nv_email_oauth';
const CAMINHO_FLUXO = '/api/email/oauth';
// Para onde a tela de configuração devolve depois de conectar (só telas do próprio app).
const VOLTAR_PERMITIDO = /^\/notas\/[\w-]{1,64}\/email$/;

export async function rotasEmail(app) {
  const { email, limites, emailOAuth } = app.ctx;
  const enderecoRetorno = (req, provedor) => {
    // Fora do computador de desenvolvimento, sempre https (atrás da borda da Vercel a conexão interna é http).
    const base = (config.urlPublica || `${config.dev ? req.protocol : 'https'}://${req.host}`).replace(/\/+$/, '');
    return `${base}${CAMINHO_FLUXO}/${provedor}/retorno`;
  };
  const provedorDe = (req) => {
    const p = String(req.params.provedor || '');
    if (!PROVEDORES_OAUTH[p]) throw new ErroApp(404, 'Provedor de e-mail desconhecido.');
    return p;
  };

  app.get('/email/config', async (req) => ({ config: await email.configPublica(req.usuario.id), oauth: emailOAuth.disponiveis() }));
  app.put('/email/config', async (req) => ({ config: await email.salvarConfig(req.usuario.id, req.body || {}, req.ip) }));
  app.put('/email/config/preferencias', async (req) => ({ config: await email.salvarPreferencias(req.usuario.id, req.body || {}, req.ip) }));
  app.delete('/email/config', async (req) => ({ config: await email.removerConfig(req.usuario.id, req.ip) }));
  app.post('/email/config/testar', async (req) => {
    await limites.consumir(`email-teste:${req.usuario.id}`, 10, 10 * 60_000);
    return await email.testar(req.usuario.id, req.ip);
  });

  // "Entrar com o Google / a Microsoft": exige a sessão e o cabeçalho anti-CSRF; devolve o endereço para o app abrir.
  app.post('/email/oauth/:provedor/iniciar', async (req, reply) => {
    const provedor = provedorDe(req);
    await limites.consumir(`email-oauth:${req.usuario.id}`, 20, 15 * 60_000);
    const voltar = VOLTAR_PERMITIDO.test(String(req.body?.voltar || '')) ? req.body.voltar : null;
    const { token, url } = await emailOAuth.iniciar({ provedor, usuarioId: req.usuario.id, redirectUri: enderecoRetorno(req, provedor), voltar });
    reply.setCookie(COOKIE_FLUXO, token, { httpOnly: true, secure: config.cookieSeguro, sameSite: 'lax', path: CAMINHO_FLUXO, maxAge: 600 });
    return { url };
  });

  // Retorno do provedor (sem sessão: o cookie da sessão é Strict). Vale só com o cookie e o state deste fluxo.
  app.get('/email/oauth/:provedor/retorno', async (req, reply) => {
    const provedor = provedorDe(req);
    const q = req.query || {};
    const token = req.cookies[COOKIE_FLUXO];
    reply.clearCookie(COOKIE_FLUXO, { path: CAMINHO_FLUXO });
    const ir = (params) => reply.redirect(`/#/email?${new URLSearchParams(params)}`, 303);
    if (q.error) return ir({ conexao: q.error === 'access_denied' ? 'cancelada' : 'erro', motivo: 'provedor', provedor });
    try {
      const r = await emailOAuth.concluir({ provedor, token, state: q.state, code: q.code });
      await email.conectarOAuth(r.usuarioId, { provedor, conta: r.conta, nome: r.nome, refreshToken: r.refreshToken }, req.ip);
      return ir({ conexao: 'ok', provedor, ...(r.voltar ? { voltar: r.voltar } : {}) });
    } catch (e) {
      if (!(e instanceof ErroApp)) req.log?.error(e);
      return ir({ conexao: 'erro', motivo: e instanceof ErroApp && /^[a-z]+$/.test(e.extra?.codigo || '') ? e.extra.codigo : 'falha', provedor });
    }
  });

  // Destinatários do cadastro, anexos, remetente e envios anteriores (sem IA: abre a tela na hora).
  app.get('/notas/:id/email', async (req) => await email.preparar(req.usuario.id, exigirPrestador(req), req.params.id));
  // Assunto e mensagem escritos pela IA da conta (ou pelo modelo simples).
  app.post('/notas/:id/email/texto', async (req) => {
    await limites.consumir(`email-texto:${req.usuario.id}`, 60, 3600_000);
    return await email.texto(req.usuario.id, exigirPrestador(req), req.params.id, req.body || {});
  });
  app.post('/notas/:id/email', async (req) => {
    // Teto por hora: o e-mail sai pela conta do próprio usuário, mas um envio em massa por engano não deve passar.
    await limites.consumir(`email-envio:${req.usuario.id}`, 120, 3600_000);
    return await email.enviarNota(req.usuario.id, exigirPrestador(req), req.params.id, req.body || {}, req.ip);
  });
}
