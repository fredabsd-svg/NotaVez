process.env.NODE_ENV = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { abrirCentral: abrirBanco } = await import('../src/db/banco.js');
const { criarLimites } = await import('../src/security/limites.js');
const { criarBackup } = await import('../scripts/backup.mjs');
const { cifrar, decifrar } = await import('../src/security/cripto.js');
const { criarApp } = await import('../src/app.js');

test('limites persistem após reabrir banco, expiram e não guardam chave literal', async () => {
  const pasta = await mkdtemp(join(tmpdir(), 'nv-limites-'));
  let db;
  try {
    const caminho = join(pasta, 'banco.db');
    let tempo = 100;
    db = abrirBanco(caminho);
    criarLimites(db, { agora: () => tempo }).consumir('email@exemplo.com', 1, 1000);
    assert.notEqual(db.get('SELECT chave FROM limites_requisicoes').chave, 'email@exemplo.com');
    db.fechar(); db = abrirBanco(caminho);
    const limites = criarLimites(db, { agora: () => tempo });
    assert.throws(() => limites.consumir('email@exemplo.com', 1, 1000), (e) => e.status === 429);
    tempo = 1100;
    assert.doesNotThrow(() => limites.consumir('email@exemplo.com', 1, 1000));
  } finally { db?.fechar(); await rm(pasta, { recursive: true, force: true }); }
});

test('backup copia catálogo e banco de cada conta, íntegros e cifrados, sem incluir a chave', async () => {
  const pasta = await mkdtemp(join(tmpdir(), 'nv-backup-'));
  let app; let restaurado;
  try {
    app = await criarApp({ banco: join(pasta, 'notavez.db'), logger: false, servirWeb: false });
    const r = await app.inject({ method: 'POST', url: '/api/conta/cadastrar', headers: { 'x-notavez': '1' }, payload: { email: 'bk@example.com', senha: 'senha-segura' } });
    const cookie = r.headers['set-cookie'].split(';')[0];
    await app.inject({ method: 'PUT', url: '/api/perfil', headers: { 'x-notavez': '1', cookie }, payload: { documento: '11.222.333/0001-81', nome: 'Empresa Backup', municipioIbge: '3550308', opSimpNac: '2' } });
    const { usuarioId } = r.json();
    const destino = join(pasta, 'snapshot');
    const manifesto = await criarBackup(join(pasta, 'notavez.db'), destino);
    assert.equal(manifesto.chaveIncluida, false);
    assert.deepEqual(manifesto.arquivos.map((a) => a.arquivo), ['notavez.db', `contas/${usuarioId}.db`]);
    assert.ok(manifesto.arquivos.every((a) => /^[0-9a-f]{64}$/.test(a.sha256)));
    // O banco copiado da conta está cifrado com a chave da conta (envelopada no catálogo).
    restaurado = abrirBanco(join(destino, 'notavez.db'));
    const { abrirChaveConta, criarCriptoConta } = await import('../src/security/cripto.js');
    const { DatabaseSync } = await import('node:sqlite');
    const copia = new DatabaseSync(join(destino, 'contas', `${usuarioId}.db`), { readOnly: true });
    const nomeCifrado = copia.prepare('SELECT nome_cifrado FROM prestadores').get().nome_cifrado;
    copia.close();
    assert.doesNotMatch(await readFile(join(destino, 'contas', `${usuarioId}.db`), 'latin1'), /Empresa Backup/);
    const chave = abrirChaveConta(usuarioId, restaurado.get('SELECT chave_conta FROM usuarios WHERE id = ?', usuarioId).chave_conta);
    assert.equal(criarCriptoConta(usuarioId, chave).decifrar(nomeCifrado), 'Empresa Backup');
    assert.equal(decifrar(cifrar('ok')), 'ok');
    assert.doesNotMatch(await readFile(join(destino, 'manifesto.json'), 'utf8'), /MASTER_KEY/);
    await assert.rejects(criarBackup(join(pasta, 'notavez.db'), destino), { code: 'EEXIST' });
  } finally { restaurado?.fechar(); await app?.close(); await rm(pasta, { recursive: true, force: true }); }
});

test('IP encaminhado não contorna limite quando proxy não é confiado', async () => {
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, proxiesConfiaveis: false });
  try {
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/conta/cadastrar', headers: { 'x-notavez': '1', 'x-forwarded-for': `198.51.100.${i}` }, payload: { email: `inv-${i}`, senha: 'x' } });
      assert.equal(r.statusCode, 422);
    }
    const r = await app.inject({ method: 'POST', url: '/api/conta/cadastrar', headers: { 'x-notavez': '1', 'x-forwarded-for': '203.0.113.2' }, payload: { email: 'nova@example.com', senha: 'senha-segura' } });
    assert.equal(r.statusCode, 429);
  } finally { await app.close(); }
});

test('identidade esperada recusa mutação após troca de cookie', async () => {
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false });
  try {
    const cadastrar = async (email) => app.inject({ method: 'POST', url: '/api/conta/cadastrar', headers: { 'x-notavez': '1' }, payload: { email, senha: 'senha-segura' } });
    await cadastrar('a@example.com');
    const idA = app.ctx.db.get('SELECT id FROM usuarios WHERE email = ?', 'a@example.com').id;
    const b = await cadastrar('b@example.com');
    const cookie = b.headers['set-cookie'].split(';')[0];
    const r = await app.inject({ method: 'PUT', url: '/api/perfil', headers: { cookie, 'x-notavez': '1', 'x-notavez-usuario': idA }, payload: {} });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().codigo, 'CONTA_ALTERADA');
    const idB = app.ctx.db.get('SELECT id FROM usuarios WHERE email = ?', 'b@example.com').id;
    for (const id of [idA, idB]) assert.equal(app.ctx.contas.abrir(id).db.get('SELECT count(*) n FROM prestadores').n, 0);
    const del = await app.inject({ method: 'DELETE', url: '/api/conta', headers: { cookie, 'x-notavez': '1', 'x-notavez-usuario': idA }, payload: { senha: 'senha-segura' } });
    assert.equal(del.statusCode, 409, 'DELETE conta também confere identidade, mesmo quando as senhas coincidem');
    assert.equal(app.ctx.db.get('SELECT count(*) n FROM usuarios').n, 2);
  } finally { await app.close(); }
});

test('erro inesperado não afirma ausência de emissão; DAL não configurado é 404', async () => {
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: true });
  app.get('/falha-teste', async () => { throw new Error('falha depois do envio'); });
  try {
    const r = await app.inject('/falha-teste');
    assert.equal(r.statusCode, 500);
    assert.doesNotMatch(r.json().erro, /nada foi emitido/i);
    assert.match(r.json().erro, /consulte a situação/i);
    assert.equal((await app.inject('/.well-known/assetlinks.json')).statusCode, 404);
  } finally { await app.close(); }
});
