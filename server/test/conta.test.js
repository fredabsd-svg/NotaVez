process.env.NODE_ENV = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { criarApp } = await import('../src/app.js');
const { abrirBanco } = await import('../src/db/banco.js');
const { criarAutenticacao } = await import('../src/security/autenticacao.js');
const { criarEntregaRecuperacao } = await import('../src/security/recuperacao-entrega.js');
const { agora } = await import('../src/db/banco.js');
const { hashToken } = await import('../src/security/cripto.js');
const post = (app, url, payload, cookie) => app.inject({ method: 'POST', url, payload, headers: { 'x-notavez': '1', ...(cookie ? { cookie } : {}) } });
const sessao = (r) => r.headers['set-cookie'].split(';')[0];

test('conta expõe identidade; exclusão exige senha, impede pendência e apaga cascatas, chamadas e auditoria apenas do titular', async (t) => {
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: true });
  t.after(() => app.close());
  const a = await post(app, '/api/conta/cadastrar', { email: 'a@teste.invalid', senha: 'senha-segura' });
  const b = await post(app, '/api/conta/cadastrar', { email: 'b@teste.invalid', senha: 'senha-segura' });
  const cookie = sessao(a);
  const conta = (await app.inject({ url: '/api/conta', headers: { cookie } })).json();
  assert.equal(conta.email, 'a@teste.invalid');
  assert.equal(conta.prestadorId, null);
  assert.equal(typeof conta.usuarioId, 'string');
  const { db } = app.ctx;
  const segundaSessao = await post(app, '/api/conta/entrar', { email: 'a@teste.invalid', senha: 'senha-segura' });
  db.run('INSERT INTO recuperacoes_senha (token_hash,usuario_id,expira_em) VALUES (?,?,?)', hashToken('token-secreto'), conta.usuarioId, '2099-01-01T00:00:00.000Z');
  const fechados = [];
  app.ctx.emissao.fecharClientesDoPrestador = (id) => fechados.push(id);
  db.run('INSERT INTO prestadores (id,usuario_id,criado_em,atualizado_em) VALUES (?,?,?,?)', 'pa', conta.usuarioId, agora(), agora());
  db.run('INSERT INTO notas (id,prestador_id,situacao,rascunho_cifrado,criado_em,atualizado_em) VALUES (?,?,?,?,?,?)', 'na', 'pa', 'enviando', 'cifrado', agora(), agora());
  db.run('INSERT INTO servicos (id,prestador_id,apelido,c_trib_nac,descricao,criado_em,atualizado_em) VALUES (?,?,?,?,?,?,?)', 'sa', 'pa', 'serviço', '010101', 'descrição', agora(), agora());
  db.run('INSERT INTO certificados (id,prestador_id,pfx_cifrado,senha_cifrada,criado_em) VALUES (?,?,?,?,?)', 'ca', 'pa', 'a1', 'segredo', agora());
  db.run('INSERT INTO clientes (id,prestador_id,dados_cifrados,criado_em,atualizado_em) VALUES (?,?,?,?,?)', 'clientea', 'pa', 'dados', agora(), agora());
  db.run('INSERT INTO chamadas_api (nota_id,operacao,resultado,criado_em) VALUES (?,?,?,?)', 'na', 'envio', 'incerta', agora());
  db.run('INSERT INTO auditoria (acao,entidade_id,criado_em) VALUES (?,?,?)', 'nota.envio', 'na', agora());
  const del = (senha) => app.inject({ method: 'DELETE', url: '/api/conta', payload: { senha }, headers: { cookie, 'x-notavez': '1' } });
  assert.equal((await del('errada')).statusCode, 401);
  assert.equal((await del('senha-segura')).statusCode, 409);
  assert.ok(db.get('SELECT id FROM usuarios WHERE id = ?', conta.usuarioId));
  db.run("UPDATE notas SET situacao = 'emitida' WHERE id = 'na'");
  assert.equal((await del('senha-segura')).statusCode, 200);
  for (const tabela of ['prestadores','notas','certificados','clientes','servicos','chamadas_api','recuperacoes_senha']) assert.equal(db.get(`SELECT count(*) AS n FROM ${tabela}`).n, 0, tabela);
  assert.equal(db.get('SELECT count(*) AS n FROM auditoria WHERE entidade_id = ?', 'na').n, 0);
  assert.equal(db.get('SELECT count(*) AS n FROM auditoria WHERE usuario_id = ?', conta.usuarioId).n, 0);
  assert.deepEqual(fechados, ['pa']);
  assert.equal((await app.inject({ url: '/api/conta', headers: { cookie } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/conta', headers: { cookie: sessao(segundaSessao) } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/conta', headers: { cookie: sessao(b) } })).statusCode, 200);
  for (const url of ['/privacidade.html','/excluir-conta.html','/recuperar-conta.html']) assert.equal((await app.inject({ url })).statusCode, 200);
});

test('recuperação entrega segredo só no adaptador, expira, é uso único e revoga todas sessões', async (t) => {
  const entregas = [];
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, entregarRecuperacao: async (r) => entregas.push(r) });
  t.after(() => app.close());
  const cadastro = await post(app, '/api/conta/cadastrar', { email: 'rec@teste.invalid', senha: 'senha-antiga' });
  const cookie = sessao(cadastro);
  const a = await post(app, '/api/conta/recuperar', { email: 'rec@teste.invalid' });
  const b = await post(app, '/api/conta/recuperar', { email: 'ausente@teste.invalid' });
  assert.equal(a.statusCode, 200);
  assert.deepEqual(a.json(), b.json());
  assert.equal(a.json().token, undefined);
  assert.equal(entregas.length, 1);
  const token = entregas[0].token;
  assert.equal(token.length, 43);
  assert.ok(app.ctx.db.get('SELECT token_hash FROM recuperacoes_senha').token_hash !== token);
  assert.equal((await post(app, '/api/conta/redefinir', { token, senha: 'senha-nova' })).statusCode, 200);
  assert.equal((await post(app, '/api/conta/redefinir', { token, senha: 'senha-outra' })).statusCode, 422);
  assert.equal((await app.inject({ url: '/api/conta', headers: { cookie } })).statusCode, 401);
  assert.equal((await post(app, '/api/conta/entrar', { email: 'rec@teste.invalid', senha: 'senha-antiga' })).statusCode, 401);
  assert.equal((await post(app, '/api/conta/entrar', { email: 'rec@teste.invalid', senha: 'senha-nova' })).statusCode, 200);
  await post(app, '/api/conta/recuperar', { email: 'rec@teste.invalid' });
  app.ctx.db.run('UPDATE recuperacoes_senha SET expira_em = ?', '2000-01-01T00:00:00.000Z');
  assert.equal((await post(app, '/api/conta/redefinir', { token: entregas[1].token, senha: 'senha-nova2' })).statusCode, 422);
});

test('tokens anteriores invalidados e entrega falha não enumera contas nem deixa token válido; limites persistem', async (t) => {
  const db = abrirBanco(':memory:');
  t.after(() => db.fechar());
  const entregas = [];
  const auth = criarAutenticacao(db, { entregarRecuperacao: async (r) => entregas.push(r) });
  auth.cadastrar('seguro@teste.invalid', 'senha-segura', 'cadastro');
  await auth.recuperar('seguro@teste.invalid', 'ip1');
  await auth.recuperar('seguro@teste.invalid', 'ip1');
  assert.throws(() => auth.redefinir(entregas[0].token, 'senha-nova', 'ip2'), { status: 422 });
  const falha = criarAutenticacao(db, { entregarRecuperacao: async () => { throw new Error('serviço ausente'); } });
  await falha.recuperar('seguro@teste.invalid', 'ip1');
  assert.equal(db.get('SELECT count(*) AS n FROM recuperacoes_senha').n, 0);
  await auth.recuperar('seguro@teste.invalid', 'ip1');
  await auth.recuperar('seguro@teste.invalid', 'ip1');
  const reiniciado = criarAutenticacao(db, { entregarRecuperacao: async () => {} });
  await assert.rejects(reiniciado.recuperar('seguro@teste.invalid', 'outro-ip'), { status: 429 });
});

test('adaptador exige HTTPS autenticado, não segue redirect e só envia ao transporte configurado', async () => {
  assert.equal(criarEntregaRecuperacao({ url: '' }), undefined);
  assert.throws(() => criarEntregaRecuperacao({ url: 'http://example.invalid', token: 'x' }));
  assert.throws(() => criarEntregaRecuperacao({ url: 'https://example.invalid', token: '' }));
  const chamadas = [];
  const entrega = criarEntregaRecuperacao({ url: 'https://example.invalid/entregar', token: 'secreto', fetchImpl: async (...args) => { chamadas.push(args); return { ok: true }; } });
  await entrega({ email: 'a@teste.invalid', token: 'temporario', expiraEm: 'data' });
  assert.equal(chamadas[0][1].redirect, 'error');
  assert.equal(chamadas[0][1].headers.Authorization, 'Bearer secreto');
  assert.deepEqual(JSON.parse(chamadas[0][1].body), { email: 'a@teste.invalid', token: 'temporario', expiraEm: 'data' });
});


test('recuperação pública ainda exige anti-CSRF e informa indisponibilidade de configuração', async (t) => {
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, entregarRecuperacao: null });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: '/api/conta/recuperar', payload: { email: 'a@teste.invalid' } })).statusCode, 403);
  assert.equal((await post(app, '/api/conta/recuperar', { email: 'a@teste.invalid' })).statusCode, 503);
  const transparencia = await app.inject({ url: '/api/conta/transparencia' });
  assert.equal(transparencia.statusCode, 200);
  assert.equal(transparencia.json().configurada, false);
});
