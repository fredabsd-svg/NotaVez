// "Entrar com o Google / a Microsoft" para enviar as notas: fluxo OAuth com PKCE, state e cookie do fluxo
// (uso único, sem sessão no retorno), envio pela Gmail API e pelo Microsoft Graph, renovação e troca do
// refresh token, desconexão (revogação), recusas explicadas e sigilo. Google e Microsoft simulados aqui.
process.env.NODE_ENV = 'test';
process.env.NOTAVEZ_ESPERA_REENVIO_MS = '0';
process.env.NOTAVEZ_TIMEOUT_SEFIN_MS = '1500';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gerarCertificadoTeste } from './apoio/certificado-teste.js';
import { iniciarSefinSimulada } from './apoio/sefin-simulada.js';

const { criarApp } = await import('../src/app.js');
const { criarClienteSefin } = await import('../src/fiscal/sefin/cliente.js');
const { ambientesSefin } = await import('../src/config.js');
const { criarOAuthEmail } = await import('../src/email/oauth.js');
const { criarServicoEmail } = await import('../src/email/servico.js');
const { decifrarJson } = await import('../src/security/cripto.js');

const cert = gerarCertificadoTeste({ cnpj: '11222333000181' });
const CREDENCIAIS = { google: { clientId: 'cliente-google', clientSecret: 'segredo-google' }, microsoft: { clientId: 'cliente-ms', clientSecret: 'segredo-ms', tenant: 'common' } };
const jwt = (claims) => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.assinatura`;

// ------------------------------------------------------------------ Google e Microsoft simulados
const prov = {
  desafios: new Map(),           // code → code_challenge (PKCE)
  escopoGoogle: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send',
  revogados: new Set(), validosMs: new Set(['rt-ms-1']), trocasMs: 0,
  tokens: 0, gmail: [], graph: [], graphFalha: null, revogacoes: [],
};
const json = (status, corpo) => new Response(corpo === undefined ? '' : JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });
async function fetchFalso(url, op = {}) {
  const u = new URL(url);
  const form = typeof op.body === 'string' && op.headers?.['Content-Type'] === 'application/x-www-form-urlencoded' ? Object.fromEntries(new URLSearchParams(op.body)) : {};
  const auth = op.headers?.Authorization || '';
  if (url === 'https://oauth2.googleapis.com/token' || url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
    prov.tokens++;
    const google = u.host.includes('google');
    const c = CREDENCIAIS[google ? 'google' : 'microsoft'];
    if (form.client_id !== c.clientId || form.client_secret !== c.clientSecret) return json(401, { error: 'invalid_client' });
    if (form.grant_type === 'authorization_code') {
      const desafio = prov.desafios.get(form.code);
      const confere = desafio && createHash('sha256').update(form.code_verifier || '').digest('base64url') === desafio;
      if (!confere || !form.redirect_uri?.endsWith(`/api/email/oauth/${google ? 'google' : 'microsoft'}/retorno`)) return json(400, { error: 'invalid_grant' });
      prov.desafios.delete(form.code);
      return google
        ? json(200, { access_token: 'ya29-acesso-1', expires_in: 3599, refresh_token: 'rt-google-1', scope: form.code === 'sem-envio' ? 'openid email' : prov.escopoGoogle,
          id_token: jwt({ email: 'escritorio@gmail.test', email_verified: true, name: 'Escritório Teste' }) })
        : json(200, { access_token: 'ms-acesso-1', expires_in: 3599, refresh_token: 'rt-ms-1', scope: 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read openid profile email', id_token: jwt({ preferred_username: 'outro@nada.test' }) });
    }
    if (form.grant_type === 'refresh_token') {
      if (google) return prov.revogados.has(form.refresh_token) ? json(400, { error: 'invalid_grant' }) : json(200, { access_token: 'ya29-acesso-2', expires_in: 3599, scope: prov.escopoGoogle });
      if (!prov.validosMs.has(form.refresh_token) || !String(form.scope).includes('Mail.Send')) return json(400, { error: 'invalid_grant' });
      // A Microsoft troca o refresh token: o antigo deixa de valer.
      prov.validosMs.delete(form.refresh_token);
      const novo = `rt-ms-${2 + prov.trocasMs++}`;
      prov.validosMs.add(novo);
      return json(200, { access_token: `ms-acesso-${novo}`, expires_in: 3599, refresh_token: novo });
    }
  }
  if (url === 'https://oauth2.googleapis.com/revoke') { prov.revogacoes.push(form.token); prov.revogados.add(form.token); return json(200, {}); }
  if (url.startsWith('https://graph.microsoft.com/v1.0/me?')) {
    if (!auth.startsWith('Bearer ms-acesso')) return json(401, {});
    return json(200, { displayName: 'Frederico Contábil', mail: 'Contabil@Escritorio.test', userPrincipalName: 'contabil@escritorio.onmicrosoft.test' });
  }
  if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
    if (!auth.startsWith('Bearer ya29-')) return json(401, { error: { code: 401, message: 'Invalid Credentials' } });
    prov.gmail.push({ auth, raw: Buffer.from(JSON.parse(op.body).raw, 'base64url').toString('latin1') });
    return json(200, { id: `msg-${prov.gmail.length}`, labelIds: ['SENT'] });
  }
  if (url === 'https://graph.microsoft.com/v1.0/me/sendMail') {
    if (prov.graphFalha) return json(prov.graphFalha.status, { error: prov.graphFalha.erro });
    if (!auth.startsWith('Bearer ms-acesso')) return json(401, { error: { code: 'InvalidAuthenticationToken' } });
    prov.graph.push({ auth, corpo: JSON.parse(op.body) });
    return new Response(null, { status: 202 });
  }
  throw new Error(`endereço não simulado: ${url}`);
}

// O "navegador" segue o link do provedor: confere o pedido e devolve o código para o retorno do app.
function autorizarNoProvedor(url, { code }) {
  const u = new URL(url);
  prov.desafios.set(code, u.searchParams.get('code_challenge'));
  return { state: u.searchParams.get('state'), u };
}

// ------------------------------------------------------------------ app de teste
let sefin; let app;
before(async () => {
  sefin = await iniciarSefinSimulada({ caPem: cert.caPem, caChavePem: cert.caChavePem, certClientePem: cert.certPem });
  Object.assign(ambientesSefin.producao_restrita, { sefin: sefin.baseUrl, parametros: sefin.baseParametros, adn: sefin.baseAdn });
  app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, fabricaCliente: (o) => criarClienteSefin({ ...o, ca: sefin.ca, timeoutMs: 1500 }),
    emailOAuth: CREDENCIAIS, fetchEmailOAuth: fetchFalso });
});
after(async () => { await app.close(); await sefin.fechar(); });

let ips = 0;
function sessao() {
  const remoteAddress = `203.0.113.${++ips}`;
  const cookies = {};
  const cabecalhoCookie = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const guardar = (r) => {
    for (const c of [r.headers['set-cookie'] || []].flat()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const nome = kv.slice(0, i); const valor = kv.slice(i + 1);
      if (valor && !/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) cookies[nome] = valor; else delete cookies[nome];
    }
  };
  const api = async (method, url, payload, { semSessao = false, headers = {} } = {}) => {
    if (method === 'POST' && url.endsWith('/emitir') && payload === undefined) {
      const v = await api('POST', url.replace(/emitir$/, 'validar'));
      payload = { versao: v.body.versao, revisao: v.body.revisao };
    }
    const enviados = semSessao ? Object.entries(cookies).filter(([k]) => k !== 'nv_sessao').map(([k, v]) => `${k}=${v}`).join('; ') : cabecalhoCookie();
    const r = await app.inject({ method, url, payload, remoteAddress, headers: { cookie: enviados, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}), ...headers } });
    guardar(r);
    let body; try { body = r.json(); } catch { body = r.body; }
    return { status: r.statusCode, body, headers: r.headers };
  };
  api.cookies = cookies;
  return api;
}

async function contaComNota(email) {
  const api = sessao();
  assert.equal((await api('POST', '/api/conta/cadastrar', { email, senha: 'senha-segura-1' })).status, 200);
  assert.equal((await api('PUT', '/api/perfil', { documento: '11.222.333/0001-81', nome: 'ESTUDIO WEB LTDA', municipioIbge: '3550308', opSimpNac: '2' })).status, 200);
  assert.equal((await api('POST', '/api/certificado', { pfxBase64: cert.pfx.toString('base64'), senha: cert.senha, consentimento: true })).status, 200);
  const cli = (await api('POST', '/api/clientes', { documento: '529.982.247-25', nome: 'Maria da Silva', email: 'maria@cliente.test' })).body.cliente;
  const serv = (await api('POST', '/api/servicos', { apelido: 'Site', cTribNac: '010101', descricao: 'Criação de site', valorPadrao: '350,00' })).body.servico;
  const n = (await api('POST', '/api/notas', { rascunho: { clienteId: cli.id, servicoId: serv.id } })).body.nota;
  const e = await api('POST', `/api/notas/${n.id}/emitir`);
  assert.equal(e.body.nota?.situacao, 'emitida', JSON.stringify(e.body).slice(0, 300));
  return { api, nota: e.body.nota };
}

// Conecta como o navegador faria: iniciar (com sessão) → provedor → retorno (SEM o cookie da sessão, que é Strict).
async function conectar(api, provedor, { code = `codigo-${provedor}`, voltar } = {}) {
  const ini = await api('POST', `/api/email/oauth/${provedor}/iniciar`, voltar ? { voltar } : {});
  assert.equal(ini.status, 200, JSON.stringify(ini.body));
  const { state, u } = autorizarNoProvedor(ini.body.url, { code });
  const ret = await api('GET', `/api/email/oauth/${provedor}/retorno?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, undefined, { semSessao: true });
  return { ini, u, state, ret, destino: ret.headers.location };
}

const usuarioDe = async (email) => (await app.ctx.db.get('SELECT id FROM usuarios WHERE email = ?', email)).id;
const configGuardada = async (email) => decifrarJson((await app.ctx.db.get('SELECT dados_cifrados FROM email_config WHERE usuario_id = ?', await usuarioDe(email))).dados_cifrados);

// ------------------------------------------------------------------ testes
test('sem as credenciais no servidor, os botões ficam desligados e nada começa', async () => {
  const o = criarOAuthEmail({ db: app.ctx.db, credenciais: { google: { clientId: 'x' } } });
  assert.deepEqual(o.disponiveis(), { google: false, microsoft: false });
  await assert.rejects(o.iniciar({ provedor: 'google', usuarioId: 'u', redirectUri: 'https://x/r' }), (e) => e.extra.codigo === 'EMAIL_OAUTH_INDISPONIVEL');
});

test('Entrar com o Google: PKCE, state e cookie do fluxo; retorno sem sessão; uso único; envio pela Gmail API com PDF, XML e cópia oculta', async () => {
  const { api, nota } = await contaComNota('google@exemplo.test');
  assert.deepEqual((await api('GET', '/api/email/config')).body.oauth, { google: true, microsoft: true });

  // Sem sessão ou sem o cabeçalho anti-CSRF, o fluxo nem começa.
  assert.equal((await app.inject({ method: 'POST', url: '/api/email/oauth/google/iniciar', headers: { 'x-notavez': '1' } })).statusCode, 401);
  assert.equal((await api('POST', '/api/email/oauth/google/iniciar', {}, { headers: { 'x-notavez': '0' } })).status, 403);
  assert.equal((await api('POST', '/api/email/oauth/yahoo/iniciar', {})).status, 404);

  const { ini, u, state, ret, destino } = await conectar(api, 'google', { voltar: `/notas/${nota.id}/email` });
  // Pedido ao Google: só a permissão de ENVIAR (gmail.send), offline, PKCE S256.
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('client_id'), 'cliente-google');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:80/api/email/oauth/google/retorno');
  assert.match(u.searchParams.get('scope'), /https:\/\/www\.googleapis\.com\/auth\/gmail\.send/);
  assert.ok(!/mail\.google\.com|gmail\.readonly|gmail\.modify/.test(u.searchParams.get('scope')), 'não pede para ler a caixa');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  const cookieFluxo = [ini.headers['set-cookie']].flat().find((c) => c.startsWith('nv_email_oauth='));
  assert.match(cookieFluxo, /HttpOnly/i); assert.match(cookieFluxo, /SameSite=Lax/i); assert.match(cookieFluxo, /Path=\/api\/email\/oauth/);
  // Retorno: vai para a tela de configuração, avisando que conectou e para onde voltar.
  assert.equal(ret.status, 303);
  assert.equal(destino, `/#/email?conexao=ok&provedor=google&voltar=${encodeURIComponent(`/notas/${nota.id}/email`)}`);
  const cfg = (await api('GET', '/api/email/config')).body.config;
  assert.deepEqual({ tipo: cfg.tipo, conta: cfg.conta, remetenteEmail: cfg.remetenteEmail, provedorNome: cfg.provedorNome, nomeConta: cfg.nomeConta },
    { tipo: 'google', conta: 'escritorio@gmail.test', remetenteEmail: 'escritorio@gmail.test', provedorNome: 'Google', nomeConta: 'Escritório Teste' });
  assert.ok(!JSON.stringify(cfg).includes('rt-google'), 'o token não vai para a tela');

  // O mesmo retorno de novo (uso único), sem o cookie, com outro state, ou cancelado no Google: não conecta nada.
  const repetido = await api('GET', `/api/email/oauth/google/retorno?code=codigo-google&state=${state}`, undefined, { semSessao: true });
  assert.match(repetido.headers.location, /conexao=erro&motivo=fluxo/);
  const ini2 = await api('POST', '/api/email/oauth/google/iniciar', {});
  const { state: s2 } = autorizarNoProvedor(ini2.body.url, { code: 'outro' });
  const semCookie = await app.inject({ method: 'GET', url: `/api/email/oauth/google/retorno?code=outro&state=${s2}` });
  assert.match(semCookie.headers.location, /conexao=erro&motivo=fluxo/, 'sem o cookie deste navegador, recusado');
  const cancelado = await api('GET', '/api/email/oauth/google/retorno?error=access_denied&state=x', undefined, { semSessao: true });
  assert.match(cancelado.headers.location, /conexao=cancelada/);
  // Desmarcou a permissão de enviar na tela do Google: não conecta.
  const outra = sessao();
  await outra('POST', '/api/conta/cadastrar', { email: 'semenvio@exemplo.test', senha: 'senha-segura-1' });
  const sem = await conectar(outra, 'google', { code: 'sem-envio' });
  assert.match(sem.destino, /conexao=erro&motivo=permissao/);
  assert.equal((await outra('GET', '/api/email/config')).body.config.configurado, false);

  // Teste e envio pela Gmail API: o access token do login é reaproveitado (sem pedir outro).
  const tokensAntes = prov.tokens;
  assert.equal((await api('POST', '/api/email/config/testar', {})).status, 200);
  assert.equal(prov.tokens, tokensAntes, 'access token em cache');
  const env = await api('POST', `/api/notas/${nota.id}/email`, { para: ['maria@cliente.test'], copiaParaMim: true, assunto: 'Nota fiscal nº 1 - 11/2026', corpo: 'Olá, Maria!\n\nSegue a nota.', anexos: ['pdf', 'xml'] });
  assert.equal(env.status, 200, JSON.stringify(env.body));
  const raw = prov.gmail.at(-1).raw;
  assert.match(raw, /^From: "Empresa Simulada MEI" <escritorio@gmail\.test>/m, 'nome da empresa da nota, e-mail da conta conectada');
  assert.match(raw, /^To: <maria@cliente\.test>$/m);
  assert.match(raw, /^Bcc: <escritorio@gmail\.test>$/m, 'a cópia para mim vai em Bcc (o Gmail tira o cabeçalho ao entregar)');
  assert.match(raw, /filename="DANFSe-\d{50}\.pdf"/);
  assert.match(raw, /filename="NFSe-\d{50}\.xml"/);
  assert.equal(env.body.envios.length, 1);

  // Sigilo: o refresh token e o cookie do fluxo nunca ficam em claro no banco.
  const banco = JSON.stringify([...await app.ctx.db.all('SELECT * FROM email_config'), ...await app.ctx.db.all('SELECT * FROM email_oauth_fluxos'), ...await app.ctx.db.all("SELECT * FROM auditoria WHERE acao LIKE 'email.%'")]);
  for (const segredo of ['rt-google-1', 'ya29-', 'escritorio@gmail.test', 'Escritório Teste']) assert.ok(!banco.includes(segredo), segredo);
  assert.ok(!banco.includes(api.cookies.nv_email_oauth || 'cookie-ja-usado'), 'só o hash do cookie do fluxo');
});

test('Entrar com a Microsoft: envio pelo Microsoft Graph (não depende do SMTP autenticado), refresh token trocado e guardado, recusas explicadas', async () => {
  const { api, nota } = await contaComNota('microsoft@exemplo.test');
  // Preferências escolhidas antes (no SMTP) continuam depois de conectar.
  assert.equal((await api('PUT', '/api/email/config', { host: 'smtp.office365.com', porta: 587, seguranca: 'starttls', usuario: 'contabil@escritorio.test', senha: 'x',
    remetenteEmail: 'contabil@escritorio.test', responderPara: 'financeiro@escritorio.test', copiaParaMim: false })).status, 200);
  const { u, destino } = await conectar(api, 'microsoft');
  assert.equal(u.origin + u.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.match(u.searchParams.get('scope'), /offline_access/);
  assert.match(u.searchParams.get('scope'), /https:\/\/graph\.microsoft\.com\/Mail\.Send/);
  assert.match(destino, /conexao=ok&provedor=microsoft$/);
  const cfg = (await api('GET', '/api/email/config')).body.config;
  assert.deepEqual({ tipo: cfg.tipo, conta: cfg.conta, nomeConta: cfg.nomeConta, responderPara: cfg.responderPara, copiaParaMim: cfg.copiaParaMim },
    { tipo: 'microsoft', conta: 'contabil@escritorio.test', nomeConta: 'Frederico Contábil', responderPara: 'financeiro@escritorio.test', copiaParaMim: false });
  assert.equal(cfg.host, undefined, 'a configuração SMTP antiga foi trocada');

  const prep = await api('GET', `/api/notas/${nota.id}/email`);
  assert.deepEqual(prep.body.remetente, { email: 'contabil@escritorio.test', nome: 'Frederico Contábil', via: 'Microsoft' });
  const env = await api('POST', `/api/notas/${nota.id}/email`, { para: ['maria@cliente.test', 'financeiro@cliente.test'], copiaParaMim: true, assunto: 'Nota fiscal nº 1', corpo: 'Olá!\nSegue a nota.', anexos: ['pdf', 'xml'] });
  assert.equal(env.status, 200, JSON.stringify(env.body));
  const { corpo } = prov.graph.at(-1);
  assert.equal(corpo.saveToSentItems, true, 'fica nos Itens Enviados do Outlook');
  assert.equal(corpo.message.subject, 'Nota fiscal nº 1');
  assert.deepEqual(corpo.message.body, { contentType: 'Text', content: 'Olá!\nSegue a nota.' });
  assert.deepEqual(corpo.message.toRecipients.map((r) => r.emailAddress.address), ['maria@cliente.test', 'financeiro@cliente.test']);
  assert.deepEqual(corpo.message.bccRecipients.map((r) => r.emailAddress.address), ['contabil@escritorio.test']);
  assert.deepEqual(corpo.message.replyTo.map((r) => r.emailAddress.address), ['financeiro@escritorio.test']);
  assert.deepEqual(corpo.message.attachments.map((a) => [a['@odata.type'], a.contentType]), [['#microsoft.graph.fileAttachment', 'application/pdf'], ['#microsoft.graph.fileAttachment', 'application/xml']]);
  assert.equal(Buffer.from(corpo.message.attachments[0].contentBytes, 'base64').subarray(0, 5).toString(), '%PDF-');
  const xml = await api('GET', `/api/notas/${nota.id}/xml`);
  assert.equal(Buffer.from(corpo.message.attachments[1].contentBytes, 'base64').toString('utf8'), xml.body);

  // Outro processo (sem cache): renova o acesso; a Microsoft troca o refresh token e o novo fica guardado.
  const oauth2 = criarOAuthEmail({ db: app.ctx.db, credenciais: CREDENCIAIS, fetch: fetchFalso });
  const servico2 = criarServicoEmail(app.ctx, { oauth: oauth2 });
  const usuarioId = await usuarioDe('microsoft@exemplo.test');
  assert.equal((await servico2.testar(usuarioId)).ok, true);
  assert.equal((await configGuardada('microsoft@exemplo.test')).refreshToken, 'rt-ms-2');
  assert.ok(!prov.validosMs.has('rt-ms-1'));
  assert.ok(prov.graph.at(-1).auth.endsWith('rt-ms-2'));

  // Recusas do Graph em linguagem comum; nada registrado quando o envio falha.
  prov.graphFalha = { status: 403, erro: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' } };
  const negado = await api('POST', `/api/notas/${nota.id}/email`, { para: ['maria@cliente.test'], assunto: 'a', corpo: 'b' });
  assert.equal(negado.status, 502);
  assert.match(negado.body.erro, /não autorizou o envio.*administrador pode precisar aprovar o app/);
  prov.graphFalha = { status: 404, erro: { code: 'MailboxNotEnabledForRESTAPI', message: 'The mailbox is either inactive, soft-deleted, or is hosted on-premise.' } };
  assert.match((await api('POST', '/api/email/config/testar', {})).body.erro, /não tem caixa de e-mail no Exchange Online/);
  prov.graphFalha = null;
  assert.equal((await api('GET', `/api/notas/${nota.id}/email`)).body.envios.length, 1);
  // Mesmo com o envio recusado, o refresh token trocado na renovação ficou guardado (o anterior já não vale).
  assert.ok(prov.validosMs.has((await configGuardada('microsoft@exemplo.test')).refreshToken));

  // Refresh token que deixou de valer (revogado pelo usuário na Microsoft): pede para conectar de novo.
  prov.validosMs.clear();
  const servico3 = criarServicoEmail(app.ctx, { oauth: criarOAuthEmail({ db: app.ctx.db, credenciais: CREDENCIAIS, fetch: fetchFalso }) });
  await assert.rejects(servico3.testar(usuarioId), (e) => e.extra.codigo === 'EMAIL_RECONECTAR' && /Entre de novo em Conta › E-mail para enviar notas/.test(e.message));
});

test('desconectar e trocar de forma de envio: o acesso do Google é revogado; preferências valem para qualquer forma', async () => {
  const { api } = await contaComNota('troca@exemplo.test');
  await conectar(api, 'google');
  // Preferências da conta conectada (nome do remetente, responder para, cópia).
  const pref = await api('PUT', '/api/email/config/preferencias', { remetenteNome: 'Escritório Frederico', responderPara: 'ruim', copiaParaMim: false });
  assert.equal(pref.status, 422);
  const ok = await api('PUT', '/api/email/config/preferencias', { remetenteNome: 'Escritório Frederico', responderPara: '', copiaParaMim: false });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.config.tipo, ok.body.config.remetenteNome, ok.body.config.copiaParaMim], ['google', 'Escritório Frederico', false]);
  assert.equal((await configGuardada('troca@exemplo.test')).refreshToken, 'rt-google-1', 'mudar preferência não perde a conexão');
  // Trocar por usuário e senha: o token do Google é revogado.
  const antes = prov.revogacoes.length;
  assert.equal((await api('PUT', '/api/email/config', { host: 'smtp.exemplo.test', porta: 465, seguranca: 'ssl', usuario: 'a@b.test', senha: 'x', remetenteEmail: 'a@b.test' })).status, 200);
  assert.deepEqual(prov.revogacoes.slice(antes), ['rt-google-1']);
  // Conectar de novo e desconectar: revoga também.
  prov.revogados.clear();
  await conectar(api, 'google');
  assert.equal((await api('DELETE', '/api/email/config')).body.config.configurado, false);
  assert.equal(prov.revogacoes.at(-1), 'rt-google-1');
  // Acesso revogado (ex.: pelo próprio usuário no Google): pede para conectar de novo.
  await conectar(api, 'google');
  prov.revogados.add('rt-google-1');
  const servico = criarServicoEmail(app.ctx, { oauth: criarOAuthEmail({ db: app.ctx.db, credenciais: CREDENCIAIS, fetch: fetchFalso }) });
  await assert.rejects(servico.testar(await usuarioDe('troca@exemplo.test')), (e) => e.extra.codigo === 'EMAIL_RECONECTAR');
});

test('o retorno de uma conta não conecta outra: o fluxo é da conta e do navegador que começaram', async () => {
  const a = sessao(); const b = sessao();
  await a('POST', '/api/conta/cadastrar', { email: 'a-fluxo@exemplo.test', senha: 'senha-segura-1' });
  await b('POST', '/api/conta/cadastrar', { email: 'b-fluxo@exemplo.test', senha: 'senha-segura-1' });
  // A começa; B (outro navegador) tenta usar o state de A: recusado, nada conectado em nenhuma das duas.
  const ini = await a('POST', '/api/email/oauth/google/iniciar', {});
  const { state } = autorizarNoProvedor(ini.body.url, { code: 'roubado' });
  const r = await b('GET', `/api/email/oauth/google/retorno?code=roubado&state=${state}`);
  assert.match(r.headers.location, /conexao=erro&motivo=fluxo/);
  assert.equal((await a('GET', '/api/email/config')).body.config.configurado, false);
  assert.equal((await b('GET', '/api/email/config')).body.config.configurado, false);
});
