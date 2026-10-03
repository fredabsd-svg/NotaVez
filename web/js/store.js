// Cada titular tem sua própria partição. Sair/expirar preserva seus rascunhos;
// apagar a conta ou descartar um rascunho são ações explícitas.
import { api, ErroApi, definirIdentidadeApi } from './api.js';

let bancoP;
function banco() {
  bancoP ??= new Promise((ok, erro) => {
    const req = indexedDB.open('notavez', 2);
    req.onupgradeneeded = () => {
      // As lojas antigas permanecem em quarentena: não é possível provar o dono.
      if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
      if (!req.result.objectStoreNames.contains('rascunhos')) req.result.createObjectStore('rascunhos', { keyPath: 'id' });
      req.result.createObjectStore('contas');
      req.result.createObjectStore('cachePorConta');
      req.result.createObjectStore('rascunhosPorConta', { keyPath: 'chave' });
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
    tx.onabort = () => erro(tx.error);
  });
}
const dono = (c) => c?.usuarioId ? JSON.stringify([c.usuarioId, c.prestadorId || null]) : null;
let contaAtiva = null;
let epoca = 0;
export function contextoConta() { return { conta: contaAtiva, chave: dono(contaAtiva), epoca }; }
export function conferirContexto(ctx) {
  if (!ctx.chave || ctx.epoca !== epoca || ctx.chave !== dono(contaAtiva)) throw new ErroApi(401, { erro: 'A conta mudou. Entre novamente para continuar.' });
}
export async function definirConta(conta) {
  if (dono(conta) !== dono(contaAtiva)) epoca++;
  contaAtiva = conta?.usuarioId ? { ...conta } : null;
  definirIdentidadeApi(contaAtiva);
  const salvarConta = contaAtiva;
  await op('contas', 'readwrite', (s) => { s.put(!salvarConta, 'encerrada'); return salvarConta ? s.put(salvarConta, 'ativa') : s.delete('ativa'); });
  for (const k of Object.keys(tabelas)) delete tabelas[k];
  sinonimos = {};
  return contaAtiva;
}
export const sessaoEncerrada = () => op('contas', 'readonly', (s) => s.get('encerrada'));
export async function recuperarContaOffline() {
  const c = await op('contas', 'readonly', (s) => s.get('ativa'));
  return definirConta(c || null);
}
export async function temLegadoEmQuarentena() {
  return (await op('rascunhos', 'readonly', (s) => s.getAll())).length > 0;
}
const chaveLocal = (ctx, id) => `${ctx.chave}:${id}`;
export async function kvLer(k) {
  const ctx = contextoConta(); conferirContexto(ctx);
  const v = await op('cachePorConta', 'readonly', (s) => s.get(chaveLocal(ctx, k)));
  conferirContexto(ctx); return v;
}
export async function kvGravar(k, v, ctx = contextoConta()) {
  conferirContexto(ctx);
  await op('cachePorConta', 'readwrite', (s) => s.put(v, chaveLocal(ctx, k)));
  conferirContexto(ctx);
}
export async function rascunhoLocal(id, ctx = contextoConta()) {
  conferirContexto(ctx);
  const r = await op('rascunhosPorConta', 'readonly', (s) => s.get(chaveLocal(ctx, id)));
  conferirContexto(ctx); return r;
}
export async function rascunhosLocais() {
  const ctx = contextoConta(); conferirContexto(ctx);
  const todos = await op('rascunhosPorConta', 'readonly', (s) => s.getAll());
  conferirContexto(ctx); return todos.filter((r) => r.dono === ctx.chave);
}
export async function removerLocal(id) {
  const ctx = contextoConta(); conferirContexto(ctx);
  return op('rascunhosPorConta', 'readwrite', (s) => s.delete(chaveLocal(ctx, id)));
}
export async function excluirDadosDaConta(usuarioId) {
  if (!usuarioId) throw new Error('Titular não informado.');
  for (const loja of ['cachePorConta', 'rascunhosPorConta']) {
    await op(loja, 'readwrite', (s) => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result; if (!c) return;
        // A chave começa com JSON.stringify([usuarioId, prestadorId]).
        if (String(c.key).startsWith(`[${JSON.stringify(usuarioId)},`)) c.delete();
        c.continue();
      };
    });
  }
  const ativa = await op('contas', 'readonly', (s) => s.get('ativa'));
  if (ativa?.usuarioId === usuarioId || contaAtiva?.usuarioId === usuarioId) await definirConta(null);
}
export async function limparTudo() {
  const ctx = contextoConta(); conferirContexto(ctx);
  return excluirDadosDaConta(ctx.conta.usuarioId);
}
async function alterarRegistro(ctx, id, fn) {
  conferirContexto(ctx);
  const reg = await op('rascunhosPorConta', 'readwrite', (s) => {
    const resultado = {};
    const req = s.get(chaveLocal(ctx, id));
    req.onsuccess = () => {
      resultado.result = fn(req.result);
      if (resultado.result) s.put(resultado.result);
    };
    return resultado;
  });
  conferirContexto(ctx); return reg;
}
export async function salvarLocal(id, rascunho, extra = {}, ctx = contextoConta()) {
  const snapshot = structuredClone(rascunho);
  const extras = structuredClone(extra);
  return alterarRegistro(ctx, id, (atual = {}) => ({ ...atual, ...extras, id, chave: chaveLocal(ctx, id), dono: ctx.chave,
    usuarioId: ctx.conta.usuarioId, prestadorId: ctx.conta.prestadorId || null,
    rascunho: snapshot, sincronizado: extras.sincronizado === true,
    revisaoLocal: crypto.randomUUID(), atualizadoEm: new Date().toISOString() }));
}
async function validarSessao(ctx) {
  conferirContexto(ctx);
  const c = await api('GET', '/api/conta');
  conferirContexto(ctx);
  if (dono(c) !== ctx.chave) {
    window.dispatchEvent(new CustomEvent('notavez:sessao-expirada'));
    throw new ErroApi(401, { erro: 'A conta mudou. Seus rascunhos continuam guardados para o titular.' });
  }
}
const sincronizacoes = new Map();
export function sincronizar(id) {
  const ctx = contextoConta(); conferirContexto(ctx);
  const chave = `${ctx.epoca}:${chaveLocal(ctx, id)}`;
  if (sincronizacoes.has(chave)) return sincronizacoes.get(chave);
  const p = sincronizarRegistro(id, ctx).finally(() => sincronizacoes.delete(chave));
  sincronizacoes.set(chave, p); return p;
}
async function sincronizarRegistro(id, ctx) {
  let reg = await rascunhoLocal(id, ctx);
  if (!reg || reg.sincronizado) return null;
  if (reg.conflito) throw new ErroApi(409, { erro: 'Há uma alteração em outro aparelho. Escolha qual rascunho manter.', codigo: 'CONFLITO_RASCUNHO' });
  try {
    await validarSessao(ctx);
    let nota;
    if (!reg.noServidor) {
      // Persistir o primeiro payload antes de enviá-lo permite repetir um POST
      // cuja resposta se perdeu, sem confundir edições posteriores com sucesso.
      if (!reg.criacao) {
        reg = await alterarRegistro(ctx, id, (atual) => ({ ...atual, criacao: { rascunho: atual.rascunho, revisaoLocal: atual.revisaoLocal } }));
      }
      const res = await api('POST', '/api/notas', { id, rascunho: reg.criacao.rascunho });
      nota = res.nota; conferirContexto(ctx);
      const atual = await rascunhoLocal(id, ctx);
      if (!atual) return nota;
      if (nota.versao !== 1 || !['rascunho', 'rejeitada'].includes(nota.situacao)) {
        await alterarRegistro(ctx, id, (ultimo) => ultimo && ({ ...ultimo, noServidor: true, versao: nota.versao, conflito: nota }));
        throw new ErroApi(409, { erro: 'Este rascunho mudou na conta. Sua cópia foi preservada.', codigo: 'CONFLITO_RASCUNHO' });
      }
      reg = await alterarRegistro(ctx, id, (ultimo) => {
        if (!ultimo) return null;
        const igual = ultimo.revisaoLocal === reg.criacao.revisaoLocal;
        return { ...ultimo, noServidor: true, versao: nota.versao, criacao: null, sincronizado: igual,
          ...(igual ? { rascunho: nota.rascunho } : {}) };
      });
      if (!reg || reg.sincronizado) return nota;
    }
    if (!Number.isInteger(reg.versao) || reg.versao < 1) {
      const res = await api('GET', `/api/notas/${id}`);
      await alterarRegistro(ctx, id, (ultimo) => ultimo && ({ ...ultimo, conflito: res.nota }));
      throw new ErroApi(409, { erro: 'Confirme qual versão do rascunho manter.', codigo: 'CONFLITO_RASCUNHO' });
    }
    const res = await api('PUT', `/api/notas/${id}`, { rascunho: reg.rascunho, versao: reg.versao });
    nota = res.nota; conferirContexto(ctx);
    await alterarRegistro(ctx, id, (atual) => {
      if (!atual) return null;
      const igual = atual.revisaoLocal === reg.revisaoLocal;
      return { ...atual, noServidor: true, versao: nota.versao,
        sincronizado: igual, ...(igual ? { rascunho: nota.rascunho } : {}) };
    });
    return nota;
  } catch (e) {
    if (e instanceof ErroApi && e.status === 409 && e.dados.codigo !== 'CONTA_ALTERADA') {
      const atual = await rascunhoLocal(id, ctx);
      if (atual && !atual.conflito) {
        let remota = null;
        try { remota = (await api('GET', `/api/notas/${id}`)).nota; } catch { /* cópia local preservada */ }
        await alterarRegistro(ctx, id, (ultimo) => ultimo && ({ ...ultimo, conflito: remota || { indisponivel: true } }));
      }
    }
    if (e instanceof ErroApi && e.status === 0) return null;
    throw e;
  }
}
export async function resolverConflito(id, manterLocal) {
  const ctx = contextoConta();
  await validarSessao(ctx);
  const local = await rascunhoLocal(id, ctx);
  const { nota } = await api('GET', `/api/notas/${id}`); conferirContexto(ctx);
  if (!['rascunho', 'rejeitada'].includes(nota.situacao)) throw new ErroApi(409, { erro: 'A nota já foi enviada. A cópia local foi preservada; consulte o resultado antes de descartar.' });
  await salvarLocal(id, manterLocal ? local.rascunho : nota.rascunho,
    { noServidor: true, versao: nota.versao, conflito: null, criacao: null, sincronizado: !manterLocal,
      ...(!manterLocal ? { meta: { cliente: nota.tomadorExibicao, servicoNacional: nota.servicoNacional } } : {}) }, ctx);
  return manterLocal ? sincronizar(id) : nota;
}
export async function sincronizarTodos() {
  for (const r of await rascunhosLocais()) {
    if (!r.sincronizado && !r.conflito) { try { await sincronizar(r.id); } catch (e) { if (e.status === 401 || e.dados?.codigo === 'CONTA_ALTERADA') break; } }
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
  const ctx = contextoConta(); conferirContexto(ctx);
  try {
    const v = await buscar();
    conferirContexto(ctx);
    await kvGravar(chave, v, ctx);
    return v;
  } catch (e) {
    if (e instanceof ErroApi && e.status === 0) {
      conferirContexto(ctx);
      const v = await kvLer(chave);
      if (v) return v;
    }
    throw e;
  }
}
