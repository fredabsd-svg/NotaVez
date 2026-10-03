// Rascunho da nota: sempre salvo primeiro no aparelho, depois na conta.
import { rascunhoLocal, salvarLocal, sincronizar, contextoConta, conferirContexto } from './store.js';
import { api, ErroApi } from './api.js';
import { hoje } from './ui.js';

export const rascunhoVazio = () => ({
  clienteId: null, tomador: null, servicoId: null, cTribNac: '', cTribMun: null, cNBS: null,
  descricao: '', competencia: hoje(), valor: '', localPrestacaoIbge: null, revisar: [],
  issRetido: false, pAliq: null, pTotTribSN: null,
});

// Carrega a versão mais recente: local (não sincronizada) ou do servidor.
export async function carregar(id) {
  const ctx = contextoConta();
  const local = await rascunhoLocal(id, ctx);
  if (local && !local.sincronizado) return { rascunho: local.rascunho, meta: local.meta || {}, situacao: 'rascunho', local: true, conflito: local.conflito };
  try {
    const { nota } = await api('GET', `/api/notas/${id}`);
    conferirContexto(ctx);
    const meta = {
      cliente: nota.tomadorExibicao ? { nome: nota.tomadorExibicao.nome, documentoExibicao: nota.tomadorExibicao.documentoExibicao, tipo: nota.tomadorExibicao.tipo } : null,
      servicoNacional: nota.servicoNacional,
    };
    if (['rascunho', 'rejeitada'].includes(nota.situacao)) {
      await salvarLocal(id, nota.rascunho, { meta, noServidor: true, versao: nota.versao, sincronizado: true }, ctx);
    }
    return { rascunho: nota.rascunho, meta, situacao: nota.situacao, nota };
  } catch (e) {
    if (local && e instanceof ErroApi && e.status === 0) return { rascunho: local.rascunho, meta: local.meta || {}, situacao: 'rascunho', local: true, conflito: local.conflito };
    throw e;
  }
}

const temporizadores = new Map();
const gravacoes = new Map();
export async function salvar(id, rascunho, meta, aoSincronizar, ctx = contextoConta()) {
  const chave = `${ctx.chave}:${id}`;
  const gravacao = salvarLocal(id, rascunho, { meta }, ctx);
  gravacoes.set(chave, gravacao);
  await gravacao;
  conferirContexto(ctx);
  clearTimeout(temporizadores.get(chave));
  temporizadores.set(chave, setTimeout(async () => {
    try {
      conferirContexto(ctx);
      const n = await sincronizar(id);
      conferirContexto(ctx);
      aoSincronizar?.(n ? 'conta' : 'aparelho', n);
    } catch (e) {
      try { conferirContexto(ctx); aoSincronizar?.('erro', null, e); } catch { /* tela de outro titular */ }
    }
  }, 700));
}

export async function salvarAgora(id) {
  const ctx = contextoConta();
  const chave = `${ctx.chave}:${id}`;
  clearTimeout(temporizadores.get(chave));
  await gravacoes.get(chave);
  conferirContexto(ctx);
  return sincronizar(id);
}

export async function aplicar(id, patch, metaPatch = {}) {
  const ctx = contextoConta();
  const atual = await carregar(id);
  conferirContexto(ctx);
  const rascunho = { ...atual.rascunho, ...patch };
  const meta = { ...atual.meta, ...metaPatch };
  await salvarLocal(id, rascunho, { meta }, ctx);
  try { await sincronizar(id); } catch { /* fica no aparelho */ }
  conferirContexto(ctx);
  return { rascunho, meta };
}
