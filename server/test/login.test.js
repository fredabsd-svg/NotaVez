// Formas de entrar: gov.br (OpenID Connect) e certificado digital ICP-Brasil,
// além de e-mail e senha. Usa simuladores locais; nada é enviado ao gov.br.
process.env.NODE_ENV = 'test';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gerarCadeiaIcpTeste } from './apoio/certificado-teste.js';
import { iniciarGovbrSimulado } from './apoio/govbr-simulado.js';
const { criarApp } = await import('../src/app.js');

const CLIENTE = { clientId: 'nota-sem-stress-teste', clientSecret: 'segredo-do-cliente-de-teste' };
const SEGREDO_PROXY = 'segredo-do-proxy-com-mais-de-32-caracteres';
const ORIGEM_CERT = 'https://certificado.app.test';
const ORIGEM_APP = 'https://app.test';
let govbr; let app; let icp;

before(async () => {
  govbr = await iniciarGovbrSimulado(CLIENTE);
  icp = gerarCadeiaIcpTeste();
  app = await criarApp({
    banco: ':memory:', logger: false, servirWeb: false, appOrigem: ORIGEM_APP,
    govbr: { ...CLIENTE, emissor: govbr.url, redirectUri: `${ORIGEM_APP}/api/conta/govbr/retorno` },
    certificadoLogin: { origem: ORIGEM_CERT, segredoProxy: SEGREDO_PROXY, cadeiasPem: icp.cadeiasPem },
  });
});
after(async () => { await app.close(); await govbr.fechar(); });

const cookies = (r) => Object.fromEntries((Array.isArray(r.headers['set-cookie']) ? r.headers['set-cookie'] : [r.headers['set-cookie']]).filter(Boolean)
  .map((c) => c.split(';')[0].split('=')).map(([k, ...v]) => [k, v.join('=')]));
// IPs variados: o limite anti-abuso de entradas por IP é testado à parte.
let ip = 0;
const get = (url, cookie = '', headers = {}) => app.inject({ url, remoteAddress: `10.1.${Math.floor(++ip / 250)}.${ip % 250}`, headers: { ...(cookie ? { cookie } : {}), ...headers } });
const conta = async (sessao) => (await get('/api/conta', `nv_sessao=${sessao}`)).json();

async function entrarGovbr({ cpf = '52998224725', sessao = '', vincular = false, sobrescrever, tokenBruto, navegadorTrocado = false } = {}) {
  const inicio = await get(`/api/conta/govbr/entrar${vincular ? '?vincular=1' : ''}`, sessao ? `nv_sessao=${sessao}` : '');
  assert.equal(inicio.statusCode, 302);
  assert.ok(inicio.headers.location.startsWith(`${govbr.url}/authorize?`));
  const { code, state, params } = govbr.autorizar(inicio.headers.location, { cpf, sobrescrever, tokenBruto });
  const nav = navegadorTrocado ? 'outro-navegador' : cookies(inicio).nv_login;
  const retorno = await get(`/api/conta/govbr/retorno?code=${encodeURIComponent(code)}&state=${state}`, `nv_login=${nav}`);
  return { inicio, retorno, params, state, nav, sessao: cookies(retorno).nv_sessao };
}

test('métodos de entrada disponíveis', async () => {
  assert.deepEqual((await get('/api/conta/metodos')).json(), { senha: true, govbr: true, certificado: true });
});

test('gov.br: PKCE, state e nonce; cria conta pelo CPF sem senha e reconhece no retorno', async () => {
  const { inicio, retorno, params, state, nav, sessao } = await entrarGovbr();
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('client_id'), CLIENTE.clientId);
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.match(params.get('scope'), /openid/);
  assert.match(cookies(inicio).nv_login, /^[A-Za-z0-9_-]{43}$/);
  assert.match(inicio.headers['set-cookie'].toString(), /SameSite=Lax/);
  assert.equal(retorno.statusCode, 302);
  assert.equal(retorno.headers.location, `${ORIGEM_APP}/#/perfil?entrada=govbr`, 'conta nova vai para o perfil');
  const c = await conta(sessao);
  assert.equal(c.metodo, 'govbr');
  assert.equal(c.temSenha, false);
  assert.equal(c.email, null);
  const ids = (await get('/api/conta/identidades', `nv_sessao=${sessao}`)).json();
  assert.deepEqual(ids.identidades.map((i) => [i.tipoDocumento, i.documento, i.metodos]), [['CPF', '***.982.247-**', ['govbr']]]);
  // Mesmo CPF de novo: mesma conta.
  const segunda = await entrarGovbr();
  assert.equal(segunda.retorno.headers.location, `${ORIGEM_APP}/#/?entrada=govbr`);
  assert.equal((await conta(segunda.sessao)).usuarioId, c.usuarioId);
  // O state é de uso único.
  const repetido = await get(`/api/conta/govbr/retorno?code=x&state=${state}`, `nv_login=${nav}`);
  assert.equal(repetido.headers.location, `${ORIGEM_APP}/#/entrar?erro=govbr-expirado`);
  // Nada do gov.br fica guardado: nem tokens nem o CPF em claro.
  const { db } = app.ctx;
  const tudo = JSON.stringify([...db.all('SELECT * FROM identidades'), ...db.all('SELECT * FROM usuarios'), ...db.all('SELECT * FROM logins_pendentes'), ...db.all('SELECT * FROM auditoria')]);
  assert.ok(!tudo.includes('52998224725'));
  assert.ok(!tudo.includes('nao-guardar'));
});

test('gov.br recusa navegador trocado, token adulterado, outro destinatário, nonce errado e validade vencida', async () => {
  assert.equal((await entrarGovbr({ navegadorTrocado: true })).retorno.headers.location, `${ORIGEM_APP}/#/entrar?erro=govbr-expirado`);
  const agora = Math.floor(Date.now() / 1000);
  for (const sobrescrever of [{ aud: 'outro-servico' }, { nonce: 'outro' }, { exp: agora - 3600 }, { iss: 'https://falso.example/' }, { sub: 'nao-e-cpf' }]) {
    const { retorno, sessao } = await entrarGovbr({ cpf: '11144477735', sobrescrever });
    assert.equal(retorno.headers.location, `${ORIGEM_APP}/#/entrar?erro=govbr`, JSON.stringify(sobrescrever));
    assert.equal(sessao, undefined);
  }
  const [cab, corpo] = govbr.assinar({ sub: '11144477735' }).split('.');
  const { retorno } = await entrarGovbr({ cpf: '11144477735', tokenBruto: `${cab}.${corpo}.assinaturaFalsa` });
  assert.equal(retorno.headers.location, `${ORIGEM_APP}/#/entrar?erro=govbr`);
  const cancelado = await get('/api/conta/govbr/retorno?error=access_denied&state=xyz');
  assert.equal(cancelado.headers.location, `${ORIGEM_APP}/#/entrar?erro=govbr-expirado`);
});

test('certificado: proxy autenticado, cadeia ICP-Brasil, ticket de uso único preso ao navegador', async () => {
  const inicio = await get('/api/conta/certificado/iniciar');
  assert.equal(inicio.statusCode, 302);
  const destino = new URL(inicio.headers.location);
  assert.equal(destino.origin, ORIGEM_CERT);
  const nav = cookies(inicio).nv_login;
  const cabecalhos = (cert, segredo = SEGREDO_PROXY) => ({ 'x-notavez-proxy': segredo, 'x-certificado-cliente': cert });
  const certCnpj = icp.titular({ cnpj: '11222333000181' });
  // Sem o segredo do proxy, ninguém injeta certificado.
  assert.equal((await get(`${destino.pathname}${destino.search}`, '', cabecalhos(certCnpj, 'errado'))).statusCode, 403);
  assert.equal((await get(`${destino.pathname}${destino.search}`, '', { 'x-certificado-cliente': certCnpj })).statusCode, 403);
  const entrada = await get(`${destino.pathname}${destino.search}`, '', cabecalhos(certCnpj));
  assert.equal(entrada.statusCode, 302);
  const concluir = new URL(entrada.headers.location);
  assert.equal(concluir.origin, ORIGEM_APP);
  // Outro navegador não conclui (o ticket também é consumido nessa tentativa).
  assert.equal((await get(`${concluir.pathname}${concluir.search}`, 'nv_login=outro')).headers.location, `${ORIGEM_APP}/#/entrar?erro=certificado-expirado`);
  const entrada2 = await get(`${destino.pathname}${destino.search}`, '', cabecalhos(certCnpj));
  const pedidoReusado = new URL(entrada2.headers.location);
  const fim = await get(`${pedidoReusado.pathname}${pedidoReusado.search}`, `nv_login=${nav}`);
  assert.equal(fim.headers.location, `${ORIGEM_APP}/#/entrar?erro=certificado-expirado`, 'pedido já consumido pela tentativa anterior');

  // Fluxo completo e limpo.
  const ini = await get('/api/conta/certificado/iniciar');
  const d = new URL(ini.headers.location);
  const e = new URL((await get(`${d.pathname}${d.search}`, '', cabecalhos(certCnpj))).headers.location);
  const ok = await get(`${e.pathname}${e.search}`, `nv_login=${cookies(ini).nv_login}`);
  assert.equal(ok.headers.location, `${ORIGEM_APP}/#/perfil?entrada=certificado`);
  const c = await conta(cookies(ok).nv_sessao);
  assert.equal(c.metodo, 'certificado');
  const ids = (await get('/api/conta/identidades', `nv_sessao=${cookies(ok).nv_sessao}`)).json().identidades;
  assert.deepEqual(ids.map((i) => [i.tipoDocumento, i.documento]), [['CNPJ', '11.222.333/0001-81']]);
  assert.equal((await get(`${e.pathname}${e.search}`, `nv_login=${cookies(ini).nv_login}`)).headers.location, `${ORIGEM_APP}/#/entrar?erro=certificado-expirado`, 'ticket de uso único');
});

test('certificado recusado: fora da ICP-Brasil, falsificado, sem política, vencido ou de AC', async () => {
  const tentar = async (cert) => {
    const ini = await get('/api/conta/certificado/iniciar');
    const d = new URL(ini.headers.location);
    return (await get(`${d.pathname}${d.search}`, '', { 'x-notavez-proxy': SEGREDO_PROXY, 'x-certificado-cliente': cert })).headers.location;
  };
  const motivo = (url) => new URL(url.replace('#/', '')).searchParams.get('motivo');
  assert.equal(motivo(await tentar(icp.forasteiro({ cpf: '52998224725' }))), 'cadeia_desconhecida');
  assert.equal(motivo(await tentar(icp.falsificado({ cpf: '52998224725' }))), 'cadeia_desconhecida');
  assert.equal(motivo(await tentar(icp.titular({ cpf: '52998224725', comPolitica: false }))), 'politica');
  assert.equal(motivo(await tentar(icp.titular({ cpf: '52998224725', vencido: true }))), 'cadeia_vencida');
  assert.equal(motivo(await tentar('nao-e-certificado')), 'certificado_ilegivel');
  const raiz = icp.cadeiasPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)[0];
  assert.equal(motivo(await tentar(encodeURIComponent(raiz))), 'nao_titular');
});

test('e-CPF e gov.br do mesmo CPF entram na mesma conta; vincular no perfil; outra conta não toma o CPF', async () => {
  const cpf = '39053344705';
  const viaGovbr = await entrarGovbr({ cpf });
  const usuarioGovbr = (await conta(viaGovbr.sessao)).usuarioId;
  const ini = await get('/api/conta/certificado/iniciar');
  const d = new URL(ini.headers.location);
  const e = new URL((await get(`${d.pathname}${d.search}`, '', { 'x-notavez-proxy': SEGREDO_PROXY, 'x-certificado-cliente': icp.titular({ cpf }) })).headers.location);
  const ok = await get(`${e.pathname}${e.search}`, `nv_login=${cookies(ini).nv_login}`);
  assert.equal((await conta(cookies(ok).nv_sessao)).usuarioId, usuarioGovbr);
  const ids = (await get('/api/conta/identidades', `nv_sessao=${cookies(ok).nv_sessao}`)).json().identidades;
  assert.deepEqual(ids[0].metodos, ['govbr', 'certificado']);

  // Conta por e-mail vincula gov.br de OUTRO CPF.
  const cad = await app.inject({ method: 'POST', url: '/api/conta/cadastrar', headers: { 'x-notavez': '1' }, payload: { email: 'vinc@example.test', senha: 'senha-segura' } });
  const sessaoEmail = cookies(cad).nv_sessao;
  const vinc = await entrarGovbr({ cpf: '15350946056', sessao: sessaoEmail, vincular: true });
  assert.equal(vinc.retorno.headers.location, `${ORIGEM_APP}/#/conta?vinculado=govbr`);
  assert.equal(vinc.sessao, undefined, 'vincular não troca a sessão');
  assert.equal((await get('/api/conta/identidades', `nv_sessao=${sessaoEmail}`)).json().identidades.length, 1);
  const depois = await entrarGovbr({ cpf: '15350946056' });
  assert.equal((await conta(depois.sessao)).email, 'vinc@example.test', 'entra pela conta de e-mail vinculada');
  // O CPF de outra conta não pode ser vinculado aqui.
  const tomada = await entrarGovbr({ cpf, sessao: sessaoEmail, vincular: true });
  assert.equal(tomada.retorno.headers.location, `${ORIGEM_APP}/#/conta?erro=govbr-outra-conta`);
  // Vincular exige sessão.
  assert.equal((await get('/api/conta/govbr/entrar?vincular=1')).headers.location, `${ORIGEM_APP}/#/entrar`);
});

test('conta sem senha: remover a única forma de entrar é bloqueado; excluir exige entrada recente', async () => {
  const { sessao } = await entrarGovbr({ cpf: '71428793860' });
  const ids = (await get('/api/conta/identidades', `nv_sessao=${sessao}`)).json().identidades;
  const del = (url, body = {}) => app.inject({ method: 'DELETE', url, payload: body, headers: { cookie: `nv_sessao=${sessao}`, 'x-notavez': '1' } });
  assert.equal((await del(`/api/conta/identidades/${ids[0].id}`)).statusCode, 409);
  // Sessão antiga (mais de 10 min): pede para entrar de novo.
  const { hashToken } = await import('../src/security/cripto.js');
  app.ctx.db.run('UPDATE sessoes SET criado_em = ? WHERE token_hash = ?', new Date(Date.now() - 3600_000).toISOString(), hashToken(sessao));
  const velha = await del('/api/conta');
  assert.equal(velha.statusCode, 401);
  assert.equal(velha.json().codigo, 'REAUTENTICAR');
  const nova = await entrarGovbr({ cpf: '71428793860' });
  const r = await app.inject({ method: 'DELETE', url: '/api/conta', payload: {}, headers: { cookie: `nv_sessao=${nova.sessao}`, 'x-notavez': '1' } });
  assert.equal(r.statusCode, 200);
  // Excluída: a identidade some e o mesmo CPF cria uma conta nova, vazia.
  const depois = await entrarGovbr({ cpf: '71428793860' });
  assert.equal(depois.retorno.headers.location, `${ORIGEM_APP}/#/perfil?entrada=govbr`);
});

test('limite de tentativas também vale para as entradas por gov.br e certificado', async () => {
  let ultimo;
  for (let i = 0; i < 61; i++) ultimo = await app.inject({ url: '/api/conta/govbr/entrar', remoteAddress: '10.9.9.9' });
  assert.equal(ultimo.statusCode, 429);
});

test('sem configuração, gov.br e certificado ficam indisponíveis (sem quebrar e-mail e senha)', async (t) => {
  const simples = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, govbr: null, certificadoLogin: null });
  t.after(() => simples.close());
  assert.deepEqual((await simples.inject('/api/conta/metodos')).json(), { senha: true, govbr: false, certificado: false });
  assert.equal((await simples.inject('/api/conta/govbr/entrar')).headers.location, '/#/entrar?erro=govbr-indisponivel');
  assert.equal((await simples.inject('/api/conta/certificado/iniciar')).headers.location, '/#/entrar?erro=certificado-indisponivel');
  assert.equal((await simples.inject('/api/conta/certificado/entrar')).statusCode, 404);
});
