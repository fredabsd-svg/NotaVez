// E-mail das notas pela conta Google ou Microsoft, sem senha guardada no app (OAuth 2.0 + PKCE).
//
// - Google: envio pela Gmail API (escopo gmail.send: só enviar; o app não lê a caixa de e-mail).
// - Microsoft: envio pelo Microsoft Graph (/me/sendMail, permissão Mail.Send). Não usa SMTP, então funciona
//   mesmo com o "SMTP autenticado" desligado no Microsoft 365 da empresa.
// O fluxo é de uso único (10 min), ligado à conta que pediu e a um cookie deste navegador; o retorno do
// provedor só é aceito com o mesmo state e o mesmo cookie. Guardamos só o refresh token (cifrado).
import { createHash, randomBytes } from 'node:crypto';
import { agora } from '../db/banco.js';
import { cifrar, decifrar } from '../security/cripto.js';
import { ErroApp } from '../util/erros.js';
import { montarMensagem, enderecoValido } from '../security/smtp.js';

const VALIDADE_FLUXO_MS = 10 * 60_000;
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hash = (t) => createHash('sha256').update(`email-oauth:${t}`).digest('hex');

export const PROVEDORES_OAUTH = {
  google: {
    nome: 'Google',
    autorizar: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    token: () => 'https://oauth2.googleapis.com/token',
    escopos: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.send'],
    escopoEnvio: 'https://www.googleapis.com/auth/gmail.send',
    // offline + consent: o Google só devolve o refresh token assim (e de novo a cada nova conexão).
    extras: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
  microsoft: {
    nome: 'Microsoft',
    autorizar: (c) => `https://login.microsoftonline.com/${encodeURIComponent(c.tenant || 'common')}/oauth2/v2.0/authorize`,
    token: (c) => `https://login.microsoftonline.com/${encodeURIComponent(c.tenant || 'common')}/oauth2/v2.0/token`,
    escopos: ['openid', 'email', 'profile', 'offline_access', 'https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/User.Read'],
    escopoEnvio: 'mail.send',
    extras: { prompt: 'select_account', response_mode: 'query' },
  },
};

const erroReconectar = (provedor, detalhe = '') => new ErroApp(409,
  `A conexão com a conta ${PROVEDORES_OAUTH[provedor]?.nome || ''} expirou ou foi desfeita. Entre de novo em Conta › E-mail para enviar notas.${detalhe ? ` (${detalhe})` : ''}`.replace('conta  ', 'conta '),
  { codigo: 'EMAIL_RECONECTAR' });

// Payload do id_token recebido direto do provedor por TLS (OpenID Connect permite usar sem conferir a assinatura).
function claims(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8')) || {}; } catch { return {}; }
}

export function criarOAuthEmail({ db, credenciais = {}, fetch: buscar = globalThis.fetch, agoraMs = Date.now } = {}) {
  const cred = (p) => credenciais[p] || {};
  const disponivel = (p) => !!(PROVEDORES_OAUTH[p] && cred(p).clientId && cred(p).clientSecret);
  const disponiveis = () => Object.fromEntries(Object.keys(PROVEDORES_OAUTH).map((p) => [p, disponivel(p)]));
  // Access tokens em memória (por refresh token), até 1 min antes de vencer.
  const cache = new Map();

  async function chamarJson(url, opcoes, rotulo) {
    let r;
    try { r = await buscar(url, { redirect: 'error', signal: AbortSignal.timeout(20_000), ...opcoes }); } catch {
      throw new ErroApp(502, `Sem resposta do ${rotulo}. Tente de novo em instantes.`, { codigo: 'EMAIL_FALHOU' });
    }
    const texto = await r.text();
    let corpo = null;
    try { corpo = texto ? JSON.parse(texto) : null; } catch { corpo = null; }
    return { status: r.status, ok: r.ok, corpo };
  }

  async function pedirToken(provedor, campos) {
    const c = cred(provedor);
    const corpo = new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...campos });
    return await chamarJson(PROVEDORES_OAUTH[provedor].token(c), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: corpo.toString() },
      `login da ${PROVEDORES_OAUTH[provedor].nome}`);
  }

  // ------------------------------------------------------------------ conexão
  async function iniciar({ provedor, usuarioId, redirectUri, voltar = null }) {
    if (!disponivel(provedor)) throw new ErroApp(409, `O botão "Entrar com ${PROVEDORES_OAUTH[provedor]?.nome || provedor}" ainda não foi ativado neste servidor.`, { codigo: 'EMAIL_OAUTH_INDISPONIVEL' });
    const def = PROVEDORES_OAUTH[provedor];
    const token = randomBytes(32).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    const verificador = randomBytes(48).toString('base64url');
    await db.run('DELETE FROM email_oauth_fluxos WHERE expira_em <= ?', agora());
    await db.run('INSERT INTO email_oauth_fluxos (token_hash, usuario_id, provedor, state, verificador_cifrado, redirect_uri, voltar, expira_em) VALUES (?,?,?,?,?,?,?,?)',
      hash(token), usuarioId, provedor, state, cifrar(verificador), redirectUri, voltar, new Date(agoraMs() + VALIDADE_FLUXO_MS).toISOString());
    const q = new URLSearchParams({
      client_id: cred(provedor).clientId, redirect_uri: redirectUri, response_type: 'code', scope: def.escopos.join(' '), state,
      code_challenge: b64url(createHash('sha256').update(verificador).digest()), code_challenge_method: 'S256', ...def.extras,
    });
    return { token, url: `${def.autorizar(cred(provedor))}?${q}` };
  }

  // Retorno do provedor: confere fluxo (cookie + state + validade, uso único), troca o código e descobre o e-mail.
  async function concluir({ provedor, token, state, code }) {
    const fluxo = token ? await db.get('SELECT * FROM email_oauth_fluxos WHERE token_hash = ?', hash(token)) : null;
    if (fluxo) await db.run('DELETE FROM email_oauth_fluxos WHERE token_hash = ?', fluxo.token_hash);
    if (!fluxo || fluxo.provedor !== provedor || fluxo.state !== state || fluxo.expira_em <= agora() || typeof code !== 'string' || !code) {
      throw new ErroApp(400, 'O pedido de conexão expirou ou não é deste navegador. Comece de novo.', { codigo: 'fluxo' });
    }
    const r = await pedirToken(provedor, { grant_type: 'authorization_code', code, redirect_uri: fluxo.redirect_uri, code_verifier: decifrar(fluxo.verificador_cifrado) });
    if (!r.ok || !r.corpo?.access_token) throw new ErroApp(400, 'O provedor não confirmou a conexão.', { codigo: 'token' });
    const t = r.corpo;
    const escopos = String(t.scope || '').toLowerCase();
    if (!escopos.includes(PROVEDORES_OAUTH[provedor].escopoEnvio)) throw new ErroApp(400, 'A permissão para enviar e-mails não foi concedida.', { codigo: 'permissao' });
    if (!t.refresh_token) throw new ErroApp(400, 'O provedor não devolveu a autorização duradoura.', { codigo: 'token' });
    let conta = null; let nome = null;
    if (provedor === 'google') {
      const c = claims(t.id_token);
      if (c.email && c.email_verified !== false) { conta = c.email; nome = c.name || null; }
    } else {
      const eu = await chamarJson('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', { headers: { Authorization: `Bearer ${t.access_token}` } }, 'Microsoft Graph');
      const c = claims(t.id_token);
      conta = eu.corpo?.mail || (enderecoValido(String(eu.corpo?.userPrincipalName || '')) ? eu.corpo.userPrincipalName : null) || c.email || c.preferred_username || null;
      nome = eu.corpo?.displayName || c.name || null;
    }
    conta = String(conta || '').trim().toLowerCase();
    if (!enderecoValido(conta)) throw new ErroApp(400, 'Não foi possível saber o e-mail desta conta.', { codigo: 'conta' });
    cache.set(hash(t.refresh_token), { accessToken: t.access_token, expiraEm: agoraMs() + (Number(t.expires_in) || 3600) * 1000 - 60_000 });
    return { usuarioId: fluxo.usuario_id, voltar: fluxo.voltar, conta, nome: nome ? String(nome).slice(0, 120) : null, refreshToken: t.refresh_token };
  }

  // Access token válido; a Microsoft troca o refresh token a cada renovação (o novo volta para ser guardado).
  async function acesso(cfg) {
    const chave = hash(cfg.refreshToken);
    const guardado = cache.get(chave);
    if (guardado && guardado.expiraEm > agoraMs()) return { accessToken: guardado.accessToken, refreshToken: null };
    const def = PROVEDORES_OAUTH[cfg.tipo];
    const r = await pedirToken(cfg.tipo, { grant_type: 'refresh_token', refresh_token: cfg.refreshToken, ...(cfg.tipo === 'microsoft' ? { scope: def.escopos.join(' ') } : {}) });
    if (!r.ok || !r.corpo?.access_token) {
      if (r.status === 400 || r.status === 401) throw erroReconectar(cfg.tipo, r.corpo?.error || '');
      throw new ErroApp(502, `O login da ${def.nome} não respondeu agora. Tente de novo em instantes.`, { codigo: 'EMAIL_FALHOU' });
    }
    const novo = r.corpo.refresh_token && r.corpo.refresh_token !== cfg.refreshToken ? r.corpo.refresh_token : null;
    cache.delete(chave);
    cache.set(hash(novo || cfg.refreshToken), { accessToken: r.corpo.access_token, expiraEm: agoraMs() + (Number(r.corpo.expires_in) || 3600) * 1000 - 60_000 });
    return { accessToken: r.corpo.access_token, refreshToken: novo };
  }

  // ------------------------------------------------------------------ envio
  // aoRenovar: guarda o refresh token novo ANTES de enviar (se o envio falhar, o antigo já não vale mais).
  async function enviar(cfg, m, { aoRenovar } = {}) {
    if (!disponivel(cfg.tipo)) throw new ErroApp(409, `O envio pela conta ${PROVEDORES_OAUTH[cfg.tipo]?.nome || ''} foi desativado neste servidor. Configure outro e-mail em Conta › E-mail para enviar notas.`, { codigo: 'EMAIL_OAUTH_INDISPONIVEL' });
    const { accessToken, refreshToken } = await acesso(cfg);
    if (refreshToken) await aoRenovar?.(refreshToken);
    const autorizacao = { Authorization: `Bearer ${accessToken}` };
    if (cfg.tipo === 'google') {
      const raw = Buffer.from(montarMensagem({ de: cfg.conta, nomeRemetente: m.nomeRemetente, para: m.para, cco: m.cco, responderPara: m.responderPara,
        assunto: m.assunto, texto: m.texto, anexos: m.anexos })).toString('base64url');
      const r = await chamarJson('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { ...autorizacao, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }) }, 'Gmail');
      if (!r.ok) throw erroApi('google', r);
    } else {
      const quem = (lista) => lista.map((address) => ({ emailAddress: { address } }));
      const message = {
        subject: m.assunto, body: { contentType: 'Text', content: m.texto }, toRecipients: quem(m.para), bccRecipients: quem(m.cco || []),
        ...(m.responderPara ? { replyTo: quem([m.responderPara]) } : {}),
        attachments: (m.anexos || []).map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.nome, contentType: a.tipo, contentBytes: Buffer.from(a.conteudo).toString('base64') })),
      };
      const r = await chamarJson('https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST', headers: { ...autorizacao, 'Content-Type': 'application/json' }, body: JSON.stringify({ message, saveToSentItems: true }) }, 'Microsoft Graph');
      if (!r.ok) throw erroApi('microsoft', r);
    }
    return { ok: true };
  }

  function erroApi(provedor, r) {
    const nome = PROVEDORES_OAUTH[provedor].nome;
    const detalhe = String(r.corpo?.error?.message || r.corpo?.error_description || r.corpo?.error?.code || '').slice(0, 200);
    if (r.status === 401) return erroReconectar(provedor);
    const codigoMs = r.corpo?.error?.code;
    const mensagem = codigoMs === 'MailboxNotEnabledForRESTAPI' || codigoMs === 'MailboxNotHostedInExchangeOnline'
      ? 'Esta conta Microsoft não tem caixa de e-mail no Exchange Online (Microsoft 365 ou Outlook.com), então não pode enviar por aqui.'
      : r.status === 403
        ? `A ${nome} não autorizou o envio por esta conta. Conecte de novo e aceite a permissão de enviar e-mails${provedor === 'microsoft' ? '; no Microsoft 365, o administrador pode precisar aprovar o app' : ''}.`
        : r.status === 413 || codigoMs === 'ErrorMessageSizeExceeded' ? 'Os anexos passaram do tamanho aceito.'
          : r.status === 429 ? `A ${nome} limitou os envios desta conta por agora. Tente de novo mais tarde.`
            : `A ${nome} recusou o envio.`;
    return new ErroApp(502, `${mensagem}${detalhe ? ` Resposta: ${detalhe}` : ''}`, { codigo: 'EMAIL_RECUSADO' });
  }

  // Desconectar: o Google permite revogar o acesso na hora (a Microsoft, só pelo próprio usuário em myaccount.microsoft.com).
  async function revogar(cfg) {
    if (cfg?.tipo !== 'google' || !cfg.refreshToken) return;
    try {
      await buscar('https://oauth2.googleapis.com/revoke', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: cfg.refreshToken }).toString() });
    } catch { /* melhor esforço: a conexão já sai do app de qualquer jeito */ }
    cache.delete(hash(cfg.refreshToken));
  }

  return { disponiveis, disponivel, iniciar, concluir, enviar, revogar };
}
