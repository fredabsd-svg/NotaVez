// Rascunho da nota: sempre salvo primeiro no aparelho, depois na conta.
import { rascunhoLocal, salvarLocal, sincronizar } from './store.js';
import { api, ErroApi } from './api.js';
import { hoje } from './ui.js';

export const rascunhoVazio = () => ({
  clienteId: null, tomador: null, servicoId: null, cTribNac: '', cTribMun: null, cNBS: null,
  descricao: '', competencia: hoje(), valor: '', localPrestacaoIbge: null, revisar: [],
  issRetido: false, pAliq: null, pTotTribSN: null,
});

// Carrega a versão mais recente: local (não sincronizada) ou do servidor.
export async function carregar(id) {
  const local = await rascunhoLocal(id);
  if (local && !local.sincronizado) return { rascunho: local.rascunho, meta: local.meta || {}, situacao: 'rascunho', local: true };
  try {
    const { nota } = await api('GET', `/api/notas/${id}`);
    const meta = {
      cliente: nota.tomadorExibicao ? { nome: nota.tomadorExibicao.nome, documentoExibicao: nota.tomadorExibicao.documentoExibicao, tipo: nota.tomadorExibicao.tipo } : null,
      servicoNacional: nota.servicoNacional,
    };
    if (['rascunho', 'rejeitada'].includes(nota.situacao)) {
      await salvarLocal(id, nota.rascunho, { meta, noServidor: true, sincronizado: true });
    }
    return { rascunho: nota.rascunho, meta, situacao: nota.situacao, nota };
  } catch (e) {
    if (local && e instanceof ErroApi && e.status === 0) return { rascunho: local.rascunho, meta: local.meta || {}, situacao: 'rascunho', local: true };
    throw e;
  }
}

let temporizador;
export async function salvar(id, rascunho, meta, aoSincronizar) {
  await salvarLocal(id, rascunho, { meta });
  clearTimeout(temporizador);
  temporizador = setTimeout(async () => {
    try {
      const n = await sincronizar(id);
      aoSincronizar?.(n ? 'conta' : 'aparelho', n);
    } catch (e) {
      aoSincronizar?.('erro', null, e);
    }
  }, 700);
}

export async function salvarAgora(id) {
  clearTimeout(temporizador);
  return sincronizar(id);
}

export async function aplicar(id, patch, metaPatch = {}) {
  const atual = await carregar(id).catch(() => ({ rascunho: rascunhoVazio(), meta: {} }));
  const rascunho = { ...atual.rascunho, ...patch };
  const meta = { ...atual.meta, ...metaPatch };
  await salvarLocal(id, rascunho, { meta });
  try { await sincronizar(id); } catch { /* fica no aparelho */ }
  return { rascunho, meta };
}
