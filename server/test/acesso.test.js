// Acesso como no Portal da NFS-e: primeiro acesso com CPF/CNPJ e senha, e
// "Entrar com gov.br" (Login Único simulado: OIDC + PKCE + id_token RS256).
process.env.NODE_ENV = 'test';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

const { criarApp } = await import('../src/app.js');

const BASE = 'https://sso.simulado.gov.invalid';
const CLIENTE = { clientId: 'nota-sem-stress', clientSecret: 'segredo-teste', redirectUri: 'https://app.exemplo/api/conta/govbr/retorno', base: BASE };
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'rsa1', alg: 'RS256', use: 'sig' };
const { privateKey: chaveIntrusa } = generateKeyPairSync('rsa', { modulusLength: 2048 });

// Provedor simulado: guarda o que veio no /authorize e confere PKCE no /token.
const govbr = { pedidos: new Map(), titular: null, assinarCom: privateKey, ajustar: (c) => c, chamadasToken: 0 };
function idToken(claims, chave = govbr.assinarCom) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const corpo = `${b({ alg: 'RS256', kid: 'rsa1', typ: 'JWT' })}.${b(claims)}`;
  return `${corpo}.${sign('RSA-SHA256', Buffer.from(corpo), chave).toString('base64url')}`;
}
async function provedor(url, opts = {}) {
  const u = new URL(url);
  if (u.pathname === '/jwk') return Response.json({ keys: [jwk] });
  if (u.pathname === '/token') {
    govbr.chamadasToken += 1;
    assert.equal(opts.headers.Authorization, `Basic ${Buffer.from('nota-sem-stress:segredo-teste').toString('base64')}`);
    const corpo = new URLSearchParams(opts.body);
    const pedido = govbr.pedidos.get(corpo.get('code'));
    if (!pedido || corpo.get('redirect_uri') !== CLIENTE.redirectUri) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    const desafio = createHash('sha256').update(corpo.get('code_verifier')).digest('base64url');
    if (desafio !== pedido.code_challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    const agora = Math.floor(Date.now() / 1000);
    const claims = govbr.ajustar({ iss: `${BASE}/`, aud: CLIENTE.clientId, nonce: pedido.nonce, iat: agora, exp: agora + 60, ...govbr.titular });
    return Response.json({ access_token: 'x', token_type: 'Bearer', expires_in: 60, id_token: idToken(claims) });
  }
  return new Response('', { status: 404 });
}

let app;
before(async () => { app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, govbr: { ...CLIENTE, buscar: provedor } }); });
after(() => app.close());

let ip = 0;
function navegador() {
  const remoteAddress = `198.51.100.${++ip}`;
  const cookies = new Map();
  const cookie = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const guardar = (r) => {
    const sc = r.headers['set-cookie'];
    for (const c of (Array.isArray(sc) ? sc : sc ? [sc] : [])) {
      const [par] = c.split(';');
      const [k, v] = par.split('=');
      if (v) cookies.set(k, v); else cookies.delete(k);
    }
  };
  const pedir = async (method, url, payload) => {
    const r = await app.inject({ method, url, payload, remoteAddress, headers: { cookie: cookie(), ...(method !== 'GET' ? { 'x-notavez': '1' } : {}) } });
    guardar(r);
    return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body, headers: r.headers };
  };
  // Simula o usuário autenticando no gov.br e voltando ao app.
  async function viaGovbr(urlAutorizar) {
    const u = new URL(urlAutorizar);
    assert.equal(u.origin + u.pathname, `${BASE}/authorize`);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    const code = `code-${Math.random()}`;
    govbr.pedidos.set(code, Object.fromEntries(u.searchParams));
    return pedir('GET', `/api/conta/govbr/retorno?code=${code}&state=${u.searchParams.get('state')}`);
  }
  async function entrarGovbr() {
    const ini = await pedir('GET', '/api/conta/govbr/entrar');
    assert.equal(ini.status, 303);
    return viaGovbr(ini.headers.location);
  }
  return { pedir, viaGovbr, entrarGovbr, cookies };
}

test('primeiro acesso com CPF/CNPJ: entra por CPF, CNPJ ou e-mail; documento único e validado', async () => {
  const a = navegador();
  const r = await a.pedir('POST', '/api/conta/cadastrar', { documento: '529.982.247-25', nome: 'Maria da Silva', email: 'maria@exemplo.test', senha: 'senha-segura' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const conta = (await a.pedir('GET', '/api/conta')).body;
  assert.equal(conta.documentoFormatado, '529.982.247-25');
  assert.equal(conta.nome, 'Maria da Silva');
  assert.equal(conta.govbr, false);
  assert.equal(conta.govbrDisponivel, true);

  for (const usuario of ['52998224725', '529.982.247-25', 'MARIA@exemplo.test']) {
    const e = await navegador().pedir('POST', '/api/conta/entrar', { usuario, senha: 'senha-segura' });
    assert.equal(e.status, 200, usuario);
  }
  const errada = await navegador().pedir('POST', '/api/conta/entrar', { usuario: '52998224725', senha: 'outra-senha' });
  assert.equal(errada.status, 401);
  assert.equal(errada.body.erro, 'Usuário ou senha incorretos.');
  assert.equal((await navegador().pedir('POST', '/api/conta/entrar', { email: 'maria@exemplo.test', senha: 'senha-segura' })).status, 200, 'campo antigo continua aceito');

  const repetido = await navegador().pedir('POST', '/api/conta/cadastrar', { documento: '52998224725', email: 'outra@exemplo.test', senha: 'senha-segura' });
  assert.equal(repetido.status, 409);
  assert.match(repetido.body.erro, /CPF/);
  assert.equal((await navegador().pedir('POST', '/api/conta/cadastrar', { documento: '111.111.111-11', email: 'x@exemplo.test', senha: 'senha-segura' })).status, 422);
  const cnpj = await navegador().pedir('POST', '/api/conta/cadastrar', { documento: '11.222.333/0001-81', email: 'empresa@exemplo.test', senha: 'senha-segura' });
  assert.equal(cnpj.status, 200);
  assert.equal((await navegador().pedir('POST', '/api/conta/entrar', { usuario: '11222333000181', senha: 'senha-segura' })).status, 200);
  // O CPF fica cifrado, com índice cego.
  assert.equal(app.ctx.db.get("SELECT count(*) n FROM usuarios WHERE documento_cifrado LIKE '%52998224725%' OR documento_indice = '52998224725'").n, 0);
});

test('entrar com gov.br cria a conta pelo CPF confirmado e reconhece o vínculo depois', async () => {
  govbr.titular = { sub: '39053344705', name: 'João Pereira', email: 'joao@exemplo.test', email_verified: 'true' };
  const n = navegador();
  const r = await n.entrarGovbr();
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/#/?govbr=entrou');
  const conta = (await n.pedir('GET', '/api/conta')).body;
  assert.equal(conta.email, 'joao@exemplo.test');
  assert.equal(conta.documentoFormatado, '390.533.447-05');
  assert.equal(conta.documentoVerificado, true);
  assert.equal(conta.govbr, true);
  // Outro navegador, mesmo gov.br: mesma conta.
  const outro = navegador();
  await outro.entrarGovbr();
  assert.equal((await outro.pedir('GET', '/api/conta')).body.usuarioId, conta.usuarioId);
  assert.equal(app.ctx.db.get('SELECT count(*) n FROM usuarios WHERE id = ?', conta.usuarioId).n, 1);
});

test('gov.br nunca junta contas sozinho: CPF ou e-mail já usados pedem login com senha e vínculo', async () => {
  const dono = navegador();
  await dono.pedir('POST', '/api/conta/cadastrar', { documento: '16899535009', email: 'ana@exemplo.test', senha: 'senha-segura' });
  govbr.titular = { sub: '16899535009', name: 'Ana' };
  const tentativa = await navegador().entrarGovbr();
  assert.equal(tentativa.headers.location, '/#/entrar?govbr=vincular');
  assert.equal(tentativa.headers['set-cookie']?.toString().includes('nv_sessao='), false);

  // Logada com senha, a titular vincula; depois entra direto pelo gov.br.
  const v = await dono.pedir('POST', '/api/conta/govbr/vincular', {});
  assert.equal(v.status, 200);
  const retorno = await dono.viaGovbr(v.body.url);
  assert.equal(retorno.headers.location, '/#/conta?govbr=vinculado');
  const conta = (await dono.pedir('GET', '/api/conta')).body;
  assert.equal(conta.govbr, true);
  assert.equal(conta.documentoVerificado, true);
  const depois = navegador();
  await depois.entrarGovbr();
  assert.equal((await depois.pedir('GET', '/api/conta')).body.usuarioId, conta.usuarioId);

  // O mesmo gov.br não pode ser vinculado a uma segunda conta.
  const segunda = navegador();
  await segunda.pedir('POST', '/api/conta/cadastrar', { email: 'segunda@exemplo.test', senha: 'senha-segura' });
  const v2 = await segunda.pedir('POST', '/api/conta/govbr/vincular', {});
  assert.equal((await segunda.viaGovbr(v2.body.url)).headers.location, '/#/entrar?govbr=em-uso');
  // E-mail verificado igual ao de uma conta com senha também não cria nem entra.
  govbr.titular = { sub: '86288366757', email: 'segunda@exemplo.test', email_verified: true };
  assert.equal((await navegador().entrarGovbr()).headers.location, '/#/entrar?govbr=vincular');
  // Vincular exige sessão e o cabeçalho anti-CSRF.
  assert.equal((await navegador().pedir('POST', '/api/conta/govbr/vincular', {})).status, 401);
});

test('retorno do gov.br é recusado sem o cookie do fluxo, com state trocado, reutilizado, token falso ou nonce errado', async () => {
  govbr.titular = { sub: '71428793860', name: 'Teste' };
  const a = navegador();
  const ini = await a.pedir('GET', '/api/conta/govbr/entrar');
  const u = new URL(ini.headers.location);
  const code = 'code-fixo';
  govbr.pedidos.set(code, Object.fromEntries(u.searchParams));
  const retorno = (n, state = u.searchParams.get('state')) => n.pedir('GET', `/api/conta/govbr/retorno?code=${code}&state=${state}`);

  // Link de retorno aberto em outro navegador (sem o cookie do fluxo): recusado.
  assert.equal((await retorno(navegador())).headers.location, '/#/entrar?govbr=expirou');
  assert.equal((await retorno(a, 'state-trocado')).headers.location, '/#/entrar?govbr=expirou');
  // O state trocado consumiu o fluxo: nem o correto vale mais.
  assert.equal((await retorno(a)).headers.location, '/#/entrar?govbr=expirou');

  for (const [nome, ajuste] of [['assinatura de outra chave', () => { govbr.assinarCom = chaveIntrusa; }], ['nonce errado', () => { govbr.ajustar = (c) => ({ ...c, nonce: 'outro' }); }],
    ['outro público', () => { govbr.ajustar = (c) => ({ ...c, aud: 'outro-app' }); }], ['expirado', () => { govbr.ajustar = (c) => ({ ...c, exp: 1000 }); }]]) {
    ajuste();
    try {
      const r = await navegador().entrarGovbr();
      assert.equal(r.headers.location, '/#/entrar?govbr=erro', nome);
      assert.equal(r.headers['set-cookie']?.toString().includes('nv_sessao='), false, nome);
    } finally { govbr.assinarCom = privateKey; govbr.ajustar = (c) => c; }
  }
  assert.equal((await navegador().pedir('GET', '/api/conta/govbr/retorno?error=access_denied')).headers.location, '/#/entrar?govbr=cancelado');
});

test('sem credenciais o gov.br fica indisponível; conta só-gov.br não desvincula nem recebe recuperação', async () => {
  const semGovbr = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, govbr: {} });
  try {
    assert.deepEqual((await semGovbr.inject('/api/conta/govbr')).json(), { disponivel: false });
    const r = await semGovbr.inject('/api/conta/govbr/entrar');
    assert.equal(r.headers.location, '/#/entrar?govbr=indisponivel');
  } finally { await semGovbr.close(); }

  govbr.titular = { sub: '94821553007', name: 'Sem E-mail' };
  const n = navegador();
  await n.entrarGovbr();
  const conta = (await n.pedir('GET', '/api/conta')).body;
  assert.equal(conta.email, null);
  assert.equal((await n.pedir('DELETE', '/api/conta/govbr')).status, 409);
});

test('manter conectado: sessão longa renovada a cada uso; sem marcar, cookie de sessão de 12 h sem renovação', async () => {
  const n = navegador();
  await n.pedir('POST', '/api/conta/cadastrar', { documento: '29537914852', email: 'lembrar@exemplo.test', senha: 'senha-segura' });
  const longa = await navegador().pedir('POST', '/api/conta/entrar', { usuario: '29537914852', senha: 'senha-segura' });
  assert.match(longa.headers['set-cookie'], /Max-Age=7776000/, 'marcado por padrão: 90 dias');
  const curta = navegador();
  const r = await curta.pedir('POST', '/api/conta/entrar', { usuario: '29537914852', senha: 'senha-segura', lembrar: false });
  assert.doesNotMatch(r.headers['set-cookie'], /Max-Age/, 'some ao fechar o navegador');

  const { db } = app.ctx;
  const sessoes = () => db.all("SELECT s.token_hash, s.expira_em, s.lembrar FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id WHERE u.email = 'lembrar@exemplo.test' ORDER BY s.criado_em");
  const [, , s3] = sessoes();
  assert.equal(s3.lembrar, 0);
  assert.ok(new Date(s3.expira_em) - Date.now() <= 12 * 3600_000 + 5000);

  // Sessão longa perto de vencer: o uso a renova e reenvia o cookie.
  db.run("UPDATE sessoes SET expira_em = ? WHERE lembrar = 1 AND usuario_id = (SELECT id FROM usuarios WHERE email = 'lembrar@exemplo.test')", new Date(Date.now() + 5 * 86400_000).toISOString());
  const uso = await n.pedir('GET', '/api/conta');
  assert.equal(uso.status, 200);
  assert.match(uso.headers['set-cookie'] || '', /Max-Age=7776000/);
  assert.ok(new Date(sessoes()[0].expira_em) - Date.now() > 89 * 86400_000);
  // Logo depois não regrava (no máximo uma vez por dia).
  assert.equal((await n.pedir('GET', '/api/conta')).headers['set-cookie'], undefined);
  // A curta não é renovada.
  const antes = sessoes()[2].expira_em;
  assert.equal((await curta.pedir('GET', '/api/conta')).headers['set-cookie'], undefined);
  assert.equal(sessoes()[2].expira_em, antes);
});
