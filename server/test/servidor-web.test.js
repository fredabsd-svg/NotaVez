// Servidor com o PWA (NOTAVEZ_SERVIR_WEB): arquivos estáticos, cabeçalhos de
// cache e proteção das rotas /api contra caminhos codificados.
process.env.NODE_ENV = 'test';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { criarApp } = await import('../src/app.js');
let app;
before(async () => { app = await criarApp({ banco: ':memory:', logger: false, servirWeb: true }); });
after(async () => { await app.close(); });

const get = (url, extra = {}) => app.inject({ url, ...extra });

test('serve o PWA com cache correto e volta ao index nas rotas do app', async () => {
  for (const url of ['/', '/index.html', '/sw.js', '/manifest.webmanifest']) {
    const r = await get(url);
    assert.equal(r.statusCode, 200, url);
    assert.equal(r.headers['cache-control'], 'no-cache', `${url}: a casca do app precisa atualizar sem atraso`);
  }
  const logo = await get('/icons/logo.svg');
  assert.equal(logo.statusCode, 200);
  assert.match(logo.headers['content-type'], /image\/svg\+xml/);
  const rotaDoApp = await get('/qualquer/rota');
  assert.equal(rotaDoApp.statusCode, 200);
  assert.match(rotaDoApp.body, /<!doctype html>/i);
  const apiInexistente = await get('/api/nao-existe');
  assert.equal(apiInexistente.statusCode, 404, 'rota /api desconhecida não devolve o index');
  assert.deepEqual(apiInexistente.json(), { erro: 'Rota não encontrada.' });
});

test('caminhos codificados não escapam de web/ nem pulam o login e o anti-CSRF', async () => {
  for (const url of ['/%2e%2e/server/package.json', '/..%2fserver%2fpackage.json', '/icons/..%2f..%2fserver%2fpackage.json', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
    const r = await get(url);
    assert.doesNotMatch(r.body, /nota-sem-stress-server|root:/, `${url} vazou arquivo de fora`);
    assert.ok(r.statusCode < 500, `${url}: ${r.statusCode}`);
  }
  // O roteador decodifica "/%61pi" como "/api": a proteção tem de valer igual.
  for (const url of ['/%61pi/notas', '/%61%70%69/clientes', '/api/%6eotas']) {
    const r = await get(url);
    assert.equal(r.statusCode, 401, `${url} sem sessão: ${r.statusCode} ${r.body}`);
    assert.equal(r.headers['cache-control'], 'no-store');
  }
  const semCabecalho = await app.inject({ method: 'POST', url: '/%61pi/conta/sair' });
  assert.equal(semCabecalho.statusCode, 403, 'anti-CSRF também no caminho codificado');
  const recusado = await get('//api/notas');
  assert.ok([403, 404].includes(recusado.statusCode), `recusa do plugin mantém o 4xx (era 500): ${recusado.statusCode}`);
  // Rotas públicas continuam públicas.
  assert.equal((await get('/api/saude')).statusCode, 200);
  assert.equal((await get('/api/tabelas/municipios?q=campinas')).statusCode, 200);
});
