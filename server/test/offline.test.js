import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';

const A = { usuarioId: 'usuario-a', prestadorId: 'prestador-a', email: 'a@exemplo.test' };
const B = { usuarioId: 'usuario-b', prestadorId: 'prestador-b', email: 'b@exemplo.test' };
const legado = { id: 'legado', rascunho: { descricao: 'Sem dono comprovado' } };
globalThis.indexedDB = indexedDB;
await new Promise((resolve, reject) => {
  const req = indexedDB.open('notavez', 1);
  req.onupgradeneeded = () => { req.result.createObjectStore('kv'); req.result.createObjectStore('rascunhos', { keyPath: 'id' }).put(legado); };
  req.onsuccess = () => { req.result.close(); resolve(); }; req.onerror = () => reject(req.error);
});
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
globalThis.CustomEvent = class extends Event { constructor(nome, opts) { super(nome); this.detail = opts?.detail; } };
globalThis.window = new EventTarget();
const store = await import('../../web/js/store.js');
const { api } = await import('../../web/js/api.js');
let sessao = A;
let pedidos = [];
let handler;
globalThis.fetch = async (url, opts) => {
  const body = opts.body ? JSON.parse(opts.body) : null;
  pedidos.push({ url, metodo: opts.method, body, headers: opts.headers });
  if (url === '/api/conta') return sessao ? Response.json(sessao) : Response.json({ erro: 'Sessão expirada' }, { status: 401 });
  if (opts.headers['X-NotaVez-Usuario'] !== sessao.usuarioId || opts.headers['X-NotaVez-Prestador'] !== sessao.prestadorId) {
    return Response.json({ codigo: 'CONTA_ALTERADA' }, { status: 409 });
  }
  return handler(url, opts, body);
};
window.addEventListener('notavez:sessao-expirada', () => { store.definirConta(null); });
const nota = (id, rascunho, versao = 1) => ({ id, rascunho, versao, situacao: 'rascunho' });
const limparPedidos = () => { pedidos = []; };

test('offline: isolamento, versão, resposta perdida e conflitos', async (t) => {
  await t.test('A offline → expiração → B não vê nem envia A; A recupera draft', async () => {
    await store.definirConta(A);
    navigator.onLine = false;
    await store.salvarLocal('a-local', { valor: '150.00' });
    assert.equal(await store.sincronizar('a-local'), null);
    await store.definirConta(null);
    assert.equal(await store.sessaoEncerrada(), true);
    sessao = B; await store.definirConta(B);
    assert.deepEqual(await store.rascunhosLocais(), []);
    assert.equal(await store.rascunhoLocal('a-local'), undefined);
    navigator.onLine = true; limparPedidos();
    await store.sincronizarTodos();
    assert.equal(pedidos.length, 0);
    sessao = A; await store.definirConta(A);
    assert.equal((await store.rascunhoLocal('a-local')).rascunho.valor, '150.00');
  });
  await t.test('partições de caches não misturam clientes; logout não reaproveita conta offline', async () => {
    await store.kvGravar('clientes', { clientes: ['cliente A'] });
    await store.definirConta(null);
    assert.equal(await store.recuperarContaOffline(), null);
    sessao = B; await store.definirConta(B);
    assert.equal(await store.kvLer('clientes'), undefined);
    await store.kvGravar('clientes', { clientes: ['cliente B'] });
    sessao = A; await store.definirConta(A);
    assert.deepEqual(await store.kvLer('clientes'), { clientes: ['cliente A'] });
  });
  await t.test('conta deve ser confirmada antes de sincronizar, inclusive troca em outra aba', async () => {
    sessao = B; limparPedidos();
    await assert.rejects(store.sincronizar('a-local'), { status: 401 });
    assert.deepEqual(pedidos.map((p) => p.url), ['/api/conta']);
    sessao = A; await store.definirConta(A);
    assert.ok(await store.rascunhoLocal('a-local'));
  });
  await t.test('sessão expirada impede sync sem apagar drafts do titular', async () => {
    sessao = null; limparPedidos();
    await assert.rejects(store.sincronizar('a-local'), { status: 401 });
    assert.deepEqual(pedidos.map((p) => p.url), ['/api/conta']);
    sessao = A; await store.definirConta(A);
    assert.equal((await store.rascunhoLocal('a-local')).rascunho.valor, '150.00');
  });
  await t.test('guard de titular bloqueia janela entre confirmação e mutação', async () => {
    sessao = B; limparPedidos();
    await assert.rejects(api('PUT', '/api/notas/a-local', {}), { status: 409 });
    assert.equal(pedidos[0].headers['X-NotaVez-Usuario'], A.usuarioId);
    sessao = A; await store.definirConta(A);
  });
  await t.test('POST resposta perdida repete payload original e envia edição posterior com versão', async () => {
    await store.salvarLocal('perdida', { valor: '100.00' });
    let remota; let primeira = true;
    handler = async (_url, opts, body) => {
      if (opts.method === 'POST') {
        if (primeira) { primeira = false; remota = nota(body.id, body.rascunho); throw new Error('Resposta perdida'); }
        assert.equal(body.rascunho.valor, '100.00');
        return Response.json({ nota: remota });
      }
      assert.equal(body.versao, 1); assert.equal(body.rascunho.valor, '999.00');
      remota = nota('perdida', body.rascunho, 2); return Response.json({ nota: remota });
    };
    assert.equal(await store.sincronizar('perdida'), null);
    await store.salvarLocal('perdida', { valor: '999.00' });
    assert.equal((await store.sincronizar('perdida')).rascunho.valor, '999.00');
    const reg = await store.rascunhoLocal('perdida');
    assert.equal(reg.sincronizado, true); assert.equal(reg.versao, 2);
  });
  await t.test('edição durante PUT não é marcada sincronizada nem apagada', async () => {
    await store.salvarLocal('concorrente', { valor: '100.00' }, { noServidor: true, versao: 4 });
    handler = async (_url, _opts, body) => {
      assert.equal(body.versao, 4);
      await store.salvarLocal('concorrente', { valor: '200.00' });
      return Response.json({ nota: nota('concorrente', body.rascunho, 5) });
    };
    await store.sincronizar('concorrente');
    const reg = await store.rascunhoLocal('concorrente');
    assert.equal(reg.rascunho.valor, '200.00'); assert.equal(reg.sincronizado, false); assert.equal(reg.versao, 5);
  });
  await t.test('409 preserva cópia local e exige escolha explícita antes de sobrescrever', async () => {
    await store.salvarLocal('conflito', { valor: 'local' }, { noServidor: true, versao: 1 });
    handler = async (_url, opts, body) => {
      if (opts.method === 'GET') return Response.json({ nota: nota('conflito', { valor: 'remoto' }, 2) });
      if (body.versao === 1) return Response.json({ erro: 'Outra edição' }, { status: 409 });
      assert.equal(body.versao, 2); return Response.json({ nota: nota('conflito', body.rascunho, 3) });
    };
    await assert.rejects(store.sincronizar('conflito'), { status: 409 });
    assert.equal((await store.rascunhoLocal('conflito')).rascunho.valor, 'local');
    assert.ok((await store.rascunhoLocal('conflito')).conflito);
    limparPedidos(); await assert.rejects(store.sincronizar('conflito'), { status: 409 });
    assert.equal(pedidos.length, 0);
    await store.resolverConflito('conflito', true);
    assert.equal((await store.rascunhoLocal('conflito')).sincronizado, true);
  });
  await t.test('resposta de A após mudar para B não grava cache na partição de B', async () => {
    handler = async () => { sessao = B; await store.definirConta(B); return Response.json({ clientes: ['privado A'] }); };
    await assert.rejects(store.comCache('em-voo', () => api('GET', '/api/clientes')), { status: 401 });
    assert.equal(await store.kvLer('em-voo'), undefined);
    sessao = A; await store.definirConta(A);
  });
  await t.test('duas sincronizações locais simultâneas compartilham o mesmo envio', async () => {
    await store.salvarLocal('duplicada', { valor: '80.00' });
    let chamadas = 0;
    handler = async (_url, _opts, body) => {
      chamadas++;
      return Response.json({ nota: nota(body.id, body.rascunho) });
    };
    const um = store.sincronizar('duplicada');
    const dois = store.sincronizar('duplicada');
    assert.equal(um, dois);
    await Promise.all([um, dois]); assert.equal(chamadas, 1);
  });
  await t.test('formulário de A não grava alterações depois de B entrar', async () => {
    const ctx = store.contextoConta();
    sessao = B; await store.definirConta(B);
    await assert.rejects(store.salvarLocal('form-antigo', { descricao: 'privado A' }, {}, ctx), { status: 401 });
    assert.equal(await store.rascunhoLocal('form-antigo'), undefined);
    sessao = A; await store.definirConta(A);
  });
  await t.test('POST perdido com nota já modificada remotamente mantém conflito sem PUT', async () => {
    await store.salvarLocal('post-alterado', { valor: '100.00' });
    let primeira = true; let updates = 0;
    handler = async (_url, opts, body) => {
      if (opts.method === 'POST' && primeira) { primeira = false; throw new Error('Perdida'); }
      if (opts.method === 'PUT') updates++;
      return Response.json({ nota: nota('post-alterado', { valor: 'remoto' }, 2) });
    };
    assert.equal(await store.sincronizar('post-alterado'), null);
    await store.salvarLocal('post-alterado', { valor: 'local editado' });
    await assert.rejects(store.sincronizar('post-alterado'), { status: 409 });
    assert.equal(updates, 0);
    assert.equal((await store.rascunhoLocal('post-alterado')).rascunho.valor, 'local editado');
  });
  await t.test('exclusão de A apaga apenas dados de A e preserva legado em quarentena', async () => {
    assert.equal(await store.temLegadoEmQuarentena(), true);
    await store.excluirDadosDaConta(A.usuarioId);
    await store.definirConta(A);
    assert.deepEqual(await store.rascunhosLocais(), []);
    assert.equal(await store.kvLer('clientes'), undefined);
    await store.definirConta(B);
    assert.deepEqual(await store.kvLer('clientes'), { clientes: ['cliente B'] });
    assert.equal(await store.temLegadoEmQuarentena(), true);
  });
});
