// Armazenamento no aparelho (IndexedDB): rascunhos (para trabalhar sem
// internet) e cópias de apoio (clientes, serviços, tabelas). Tudo é apagado ao sair.
import { api, ErroApi } from './api.js';

let bancoP;
function banco() {
  bancoP ??= new Promise((ok, erro) => {
    const req = indexedDB.open('notavez', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
      req.result.createObjectStore('rascunhos', { keyPath: 'id' });
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => erro(req.error);
  });
  return bancoP;
}
async function op(loja, modo, fn) {
  const db = await banco();
  return new Promise((ok, erro) => {
    const tx = db.transaction(loja, modo);
    const r = fn(tx.objectStore(loja));
    tx.oncomplete = () => ok(r?.result);
    tx.onerror = () => erro(tx.error);
  });
}

export const kvLer = (k) => op('kv', 'readonly', (s) => s.get(k));
export const kvGravar = (k, v) => op('kv', 'readwrite', (s) => s.put(v, k));
export const rascunhoLocal = (id) => op('rascunhos', 'readonly', (s) => s.get(id));
export const rascunhosLocais = () => op('rascunhos', 'readonly', (s) => s.getAll());
export const removerLocal = (id) => op('rascunhos', 'readwrite', (s) => s.delete(id));
export async function limparTudo() {
  await op('kv', 'readwrite', (s) => s.clear());
  await op('rascunhos', 'readwrite', (s) => s.clear());
}

export async function salvarLocal(id, rascunho, extra = {}) {
  const atual = (await rascunhoLocal(id)) || {};
  const reg = { ...atual, ...extra, id, rascunho, sincronizado: false, atualizadoEm: new Date().toISOString() };
  await op('rascunhos', 'readwrite', (s) => s.put(reg));
  return reg;
}

// Envia o rascunho ao servidor. Devolve a nota do servidor ou null (offline).
export async function sincronizar(id) {
  const reg = await rascunhoLocal(id);
  if (!reg || reg.sincronizado) return null;
  try {
    const r = reg.noServidor
      ? await api('PUT', `/api/notas/${id}`, { rascunho: reg.rascunho })
      : await api('POST', '/api/notas', { id, rascunho: reg.rascunho });
    const atual = await rascunhoLocal(id);
    // Só marca como sincronizado se nada mudou durante o envio.
    if (atual && atual.atualizadoEm === reg.atualizadoEm) {
      await op('rascunhos', 'readwrite', (s) => s.put({ ...atual, noServidor: true, sincronizado: true }));
    } else if (atual) {
      await op('rascunhos', 'readwrite', (s) => s.put({ ...atual, noServidor: true }));
    }
    return r.nota;
  } catch (e) {
    if (e instanceof ErroApi && e.status === 409) {
      // A nota já foi enviada/emitida em outro lugar: a cópia local deixa de valer.
      await removerLocal(id);
      throw e;
    }
    if (e instanceof ErroApi && e.status === 0) return null;
    throw e;
  }
}

export async function sincronizarTodos() {
  for (const r of await rascunhosLocais()) {
    if (!r.sincronizado) { try { await sincronizar(r.id); } catch { /* segue */ } }
  }
}

// Tabelas oficiais completas, guardadas para busca sem internet.
const tabelas = {};
let sinonimos = {};
export async function tabela(nome) {
  if (tabelas[nome]) return tabelas[nome];
  let t = await kvLer(`tabela:${nome}`);
  if (!t && navigator.onLine) {
    t = await api('GET', `/api/tabelas/completas/${nome}`);
    await kvGravar(`tabela:${nome}`, t);
  }
  tabelas[nome] = t ? t[nome] : [];
  if (nome === 'servicos') sinonimos = t?.sinonimos || {};
  return tabelas[nome];
}
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export async function buscarMunicipio(q) {
  const t = semAcento(q).trim();
  if (t.length < 2) return [];
  const [nome, uf] = t.split(/\s*[-/,]\s*/);
  const lista = (await tabela('municipios')).filter((m) => semAcento(m.nome).includes(nome) && (!uf || m.uf.toLowerCase() === uf));
  return lista.sort((a, b) => Number(semAcento(b.nome).startsWith(nome)) - Number(semAcento(a.nome).startsWith(nome))).slice(0, 12);
}
export async function municipioPorCodigo(ibge) {
  return (await tabela('municipios')).find((m) => m.ibge === ibge) || null;
}
export async function buscarServicoNacional(q) {
  const t = semAcento(q).trim();
  if (t.length < 2) return [];
  const dig = t.replace(/\D/g, '');
  const palavras = t.split(/\s+/);
  const lista = await tabela('servicos');
  return lista.filter((s) => (dig.length >= 2 && s.codigo.replace(/^0/, '').startsWith(dig.replace(/^0/, '')))
    || palavras.every((p) => [p, ...(sinonimos[p] || []).map(semAcento)].some((x) => semAcento(`${s.descricao} ${s.item}`).includes(x)))).slice(0, 15);
}
export async function servicoNacionalPorCodigo(c) {
  return (await tabela('servicos')).find((s) => s.codigo === c) || null;
}

// Cópias de apoio para uso sem internet.
export async function comCache(chave, buscar) {
  try {
    const v = await buscar();
    await kvGravar(chave, v);
    return v;
  } catch (e) {
    if (e instanceof ErroApi && e.status === 0) {
      const v = await kvLer(chave);
      if (v) return v;
    }
    throw e;
  }
}
