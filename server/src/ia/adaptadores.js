// Adaptadores dos dois dialetos de API de IA para um formato único de conversa.
//
// Histórico neutro (o que fica guardado, cifrado, na conversa):
//   { papel: 'usuario', texto }
//   { papel: 'aviso', texto }                       mensagem automática do app (ex.: "você confirmou a emissão")
//   { papel: 'assistente', texto, chamadas: [{ id, nome, args }], nativo? }
//   { papel: 'ferramentas', resultados: [{ id, nome, conteudo, erro }] }
// `nativo` guarda a resposta original do provedor quando ela precisa voltar intacta na
// próxima chamada (blocos de raciocínio da Anthropic; reasoning_content do DeepSeek/Kimi).
import Anthropic from '@anthropic-ai/sdk';
import { ErroApp } from '../util/erros.js';
import { PROVEDORES } from './provedores.js';
import { anexoParaModelo } from './anexos.js';

const LIMITE_SAIDA = 16000;
const TEMPO_MS = 150_000;

export class ErroIA extends ErroApp {
  constructor(mensagem, extra = {}) { super(502, mensagem, { codigo: 'IA_PROVEDOR', ...extra }); }
}

// Mensagem do usuário com o texto extraído dos arquivos que ele anexou.
const textoDoUsuario = (m) => `${m.texto}${(m.anexos || []).map(anexoParaModelo).join('')}`;
const AVISO = (t) => `[Mensagem automática do aplicativo Nota Sem Stress, não digitada pelo usuário]\n${t}`;
// A Anthropic só aceita identificadores de ferramenta com letras, números, "_" e "-".
const idAnthropic = (id) => String(id || 'chamada').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

function mensagemDeErro(status, corpo, nomeProvedor) {
  const detalhe = String(corpo?.error?.message || corpo?.message || corpo?.error || '').slice(0, 300);
  if (status === 401 || status === 403) return `O provedor ${nomeProvedor} recusou a chave de API (${status}). Confira a chave em Assistente › Configurar.`;
  if (status === 404) return `O provedor ${nomeProvedor} não encontrou o modelo informado. Confira o nome do modelo em Assistente › Configurar.${detalhe ? ` Detalhe: ${detalhe}` : ''}`;
  if (status === 402) return `O provedor ${nomeProvedor} informou falta de créditos na conta da chave de API.`;
  if (status === 429) return `O provedor ${nomeProvedor} limitou as chamadas (muitas seguidas ou sem créditos). Aguarde um pouco e tente de novo.`;
  if (status === 400 || status === 422) return `O provedor ${nomeProvedor} recusou o pedido.${detalhe ? ` Detalhe: ${detalhe}` : ''}`;
  if (status >= 500) return `O provedor ${nomeProvedor} está com instabilidade (${status}). Tente de novo em instantes.`;
  return `Não foi possível falar com o provedor ${nomeProvedor}.${detalhe ? ` Detalhe: ${detalhe}` : ''}`;
}

// ---------------------------------------------------------------- Anthropic (SDK oficial)
// Modelos que aceitam o fallback do servidor quando uma recusa de segurança acontece.
const COM_FALLBACK = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-[12])$/;
// Modelos com raciocínio ligado por padrão (família 5 em diante, Fable, Mythos). Neles o bloco de raciocínio fica
// preso ao começo exato da conversa (system, ferramentas e mensagens anteriores: "preserved thinking"). Pedimos à API
// para DESCARTAR o bloco que não valer mais, em vez de recusar o pedido inteiro (conversa cortada por tamanho,
// prompt ou ferramentas que mudaram numa versão nova do app, troca de modelo, conversas de antes desta correção).
const RACIOCINIO_PADRAO = /^claude-(fable|mythos)-|^claude-(opus|sonnet|haiku)-[5-9](-|$)/;
const BETA_VINCULO = 'thinking-binding-controls-2026-08-01';
// Contexto do emissor guardado com a mensagem do usuário: volta igual em todas as chamadas seguintes.
const CONTEXTO = (c) => `[Contexto do emissor lido pelo aplicativo no momento desta mensagem; não foi digitado pelo usuário]\n${c}`;
const semRaciocinio = (conteudo) => conteudo.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');

function historicoAnthropic(historico, { contextoNasMensagens = false, removerRaciocinio = false } = {}) {
  const msgs = [];
  for (const m of historico) {
    if (m.papel === 'usuario') {
      msgs.push({ role: 'user', content: contextoNasMensagens && m.contexto
        ? [{ type: 'text', text: CONTEXTO(m.contexto) }, { type: 'text', text: textoDoUsuario(m) }]
        : textoDoUsuario(m) });
    }
    else if (m.papel === 'aviso') msgs.push({ role: 'user', content: AVISO(m.texto) });
    else if (m.papel === 'assistente') {
      const nativo = m.nativo?.dialeto === 'anthropic' && Array.isArray(m.nativo.conteudo) ? (removerRaciocinio ? semRaciocinio(m.nativo.conteudo) : m.nativo.conteudo) : [];
      if (nativo.length) {
        msgs.push({ role: 'assistant', content: nativo }); // intacto: blocos de raciocínio voltam como vieram
      } else {
        const conteudo = [];
        if (m.texto) conteudo.push({ type: 'text', text: m.texto });
        for (const c of m.chamadas || []) conteudo.push({ type: 'tool_use', id: idAnthropic(c.id), name: c.nome, input: c.args || {} });
        if (conteudo.length) msgs.push({ role: 'assistant', content: conteudo });
      }
    } else if (m.papel === 'ferramentas') {
      // Todos os resultados de uma rodada numa única mensagem.
      msgs.push({ role: 'user', content: m.resultados.map((r) => ({ type: 'tool_result', tool_use_id: idAnthropic(r.id), content: r.conteudo, ...(r.erro ? { is_error: true } : {}) })) });
    }
  }
  return msgs;
}

async function chamarAnthropic({ modelo, chave, baseUrl, esforco, sistemaFixo, sistemaVariavel, historico, ferramentas, contextoNasMensagens = false, fetch, log }) {
  const client = new Anthropic({ apiKey: chave, ...(baseUrl ? { baseURL: baseUrl } : {}), timeout: TEMPO_MS, maxRetries: 2, ...(fetch ? { fetch } : {}) });
  const fallback = COM_FALLBACK.test(modelo);
  const vinculo = RACIOCINIO_PADRAO.test(modelo);
  const betas = [...(fallback ? ['server-side-fallback-2026-07-01'] : []), ...(vinculo ? [BETA_VINCULO] : [])];
  const pedido = (removerRaciocinio) => client.beta.messages.create({
    model: modelo,
    max_tokens: LIMITE_SAIDA,
    // Ordem estável para o cache: ferramentas → instruções fixas (com marca de cache) → conversa.
    // Com o contexto nas mensagens, o system não muda entre chamadas: a conversa só cresce (append-only).
    system: [
      { type: 'text', text: sistemaFixo, cache_control: { type: 'ephemeral' } },
      ...(contextoNasMensagens || !sistemaVariavel ? [] : [{ type: 'text', text: sistemaVariavel }]),
    ],
    cache_control: { type: 'ephemeral' },
    ...(ferramentas.length ? { tools: ferramentas.map((f) => ({ name: f.nome, description: f.descricao, input_schema: f.parametros })), tool_choice: { type: 'auto' } } : {}),
    messages: historicoAnthropic(historico, { contextoNasMensagens, removerRaciocinio }),
    ...(esforco ? { output_config: { effort: esforco } } : {}),
    ...(vinculo ? { thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } } : {}),
    ...(betas.length ? { betas } : {}),
    ...(fallback ? { fallbacks: 'default' } : {}),
  });
  let r;
  try {
    try {
      r = await pedido(false);
    } catch (e) {
      // Último recurso: o provedor ainda recusou um bloco de raciocínio do histórico. Repete UMA vez sem os blocos
      // de raciocínio (texto e chamadas de ferramenta continuam); a resposta sai sem aquele raciocínio anterior.
      if (!(e instanceof Anthropic.BadRequestError && /thinking/i.test(e.message) && /signature/i.test(e.message))) throw e;
      log?.warn?.({ modelo }, 'IA: blocos de raciocínio recusados pela Anthropic; repetindo sem eles');
      r = await pedido(true);
    }
  } catch (e) {
    if (e instanceof Anthropic.APIConnectionError) throw new ErroIA('Sem resposta do provedor Anthropic (rede ou tempo esgotado). Tente de novo.');
    if (e instanceof Anthropic.APIError) throw new ErroIA(mensagemDeErro(e.status, e.error, 'Anthropic'));
    throw e;
  }
  // Monitoramento: blocos de raciocínio que a API descartou (só contagem e motivo, nunca conteúdo).
  const descartes = (r.input_transformations || []).filter((t) => t?.type === 'thinking_dropped');
  if (descartes.length) log?.info?.({ modelo, descartados: descartes.length, motivos: [...new Set(descartes.map((t) => t.reason))] }, 'IA: raciocínio anterior descartado pela API');
  const texto = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const chamadas = r.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, nome: b.name, args: b.input && typeof b.input === 'object' ? b.input : {} }));
  const fim = r.stop_reason === 'tool_use' && chamadas.length ? 'ferramentas'
    : r.stop_reason === 'refusal' ? 'recusa' : r.stop_reason === 'max_tokens' ? 'limite' : 'fim';
  return {
    texto, chamadas, fim,
    // A resposta inteira volta na próxima chamada (inclusive blocos de raciocínio e de fallback).
    nativo: { dialeto: 'anthropic', modelo: r.model, conteudo: r.content },
    uso: { entrada: r.usage?.input_tokens ?? null, saida: r.usage?.output_tokens ?? null, cache: r.usage?.cache_read_input_tokens ?? null },
    modeloUsado: r.model,
  };
}

// ---------------------------------------------------------------- Formato OpenAI (Chat Completions)
function historicoOpenAI(historico, { devolverRaciocinio }) {
  const msgs = [];
  for (const m of historico) {
    if (m.papel === 'usuario') msgs.push({ role: 'user', content: textoDoUsuario(m) });
    else if (m.papel === 'aviso') msgs.push({ role: 'user', content: AVISO(m.texto) });
    else if (m.papel === 'assistente') {
      const msg = { role: 'assistant', content: m.texto || '' };
      if (m.chamadas?.length) msg.tool_calls = m.chamadas.map((c) => ({ id: c.id, type: 'function', function: { name: c.nome, arguments: JSON.stringify(c.args || {}) } }));
      if (devolverRaciocinio && m.nativo?.dialeto === 'openai' && m.nativo.raciocinio) msg.reasoning_content = m.nativo.raciocinio;
      if (!msg.content && !msg.tool_calls) continue;
      if (!msg.content && msg.tool_calls) msg.content = null;
      msgs.push(msg);
    } else if (m.papel === 'ferramentas') {
      for (const r of m.resultados) msgs.push({ role: 'tool', tool_call_id: r.id, content: r.erro ? `ERRO: ${r.conteudo}` : r.conteudo });
    }
  }
  return msgs;
}

const textoDe = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('') : '');

async function chamarOpenAI({ provedor, modelo, chave, baseUrl, esforco, sistemaFixo, sistemaVariavel, historico, ferramentas, fetch = globalThis.fetch }) {
  const def = PROVEDORES[provedor] || PROVEDORES.personalizado;
  const base = (baseUrl || def.baseUrl).replace(/\/+$/, '');
  const corpo = {
    model: modelo,
    messages: [{ role: 'system', content: `${sistemaFixo}\n\n${sistemaVariavel}` }, ...historicoOpenAI(historico, { devolverRaciocinio: ['deepseek', 'moonshot'].includes(provedor) })],
    ...(ferramentas.length ? { tools: ferramentas.map((f) => ({ type: 'function', function: { name: f.nome, description: f.descricao, parameters: f.parametros } })), tool_choice: 'auto' } : {}),
    ...(def.campoLimite ? { [def.campoLimite]: LIMITE_SAIDA } : {}),
    ...(esforco && provedor === 'openai' ? { reasoning_effort: esforco === 'max' || esforco === 'xhigh' ? 'high' : esforco } : {}),
  };
  let resp; let dados;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${chave}` },
        body: JSON.stringify(corpo), signal: AbortSignal.timeout(TEMPO_MS),
      });
    } catch {
      if (tentativa === 0) { await new Promise((ok) => setTimeout(ok, 800)); continue; }
      throw new ErroIA(`Sem resposta do provedor ${def.nome} (rede ou tempo esgotado). Tente de novo.`);
    }
    dados = await resp.json().catch(() => null);
    if (resp.ok || !(resp.status === 429 || resp.status >= 500) || tentativa === 1) break;
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  if (!resp.ok) throw new ErroIA(mensagemDeErro(resp.status, dados, def.nome));
  const escolha = dados?.choices?.[0];
  if (!escolha?.message) throw new ErroIA(`O provedor ${def.nome} devolveu uma resposta em formato inesperado.`);
  const m = escolha.message;
  const chamadas = (m.tool_calls || []).filter((c) => c?.function?.name).map((c, i) => {
    let args = {}; let invalidos = false;
    try { args = c.function.arguments ? JSON.parse(c.function.arguments) : {}; if (!args || typeof args !== 'object' || Array.isArray(args)) { args = {}; invalidos = true; } } catch { invalidos = true; }
    return { id: c.id || `chamada_${Date.now()}_${i}`, nome: c.function.name, args, ...(invalidos ? { argsInvalidos: true } : {}) };
  });
  const fim = chamadas.length ? 'ferramentas' : escolha.finish_reason === 'length' ? 'limite' : escolha.finish_reason === 'content_filter' ? 'recusa' : 'fim';
  return {
    texto: textoDe(m.content).trim(), chamadas, fim,
    nativo: m.reasoning_content ? { dialeto: 'openai', raciocinio: m.reasoning_content } : null,
    uso: { entrada: dados.usage?.prompt_tokens ?? null, saida: dados.usage?.completion_tokens ?? null, cache: dados.usage?.prompt_tokens_details?.cached_tokens ?? null },
    modeloUsado: dados.model || modelo,
  };
}

export async function chamarModelo(opcoes) {
  const def = PROVEDORES[opcoes.provedor];
  if (!def) throw new ErroApp(422, 'Provedor de IA desconhecido. Escolha outro em Assistente › Configurar.');
  return def.dialeto === 'anthropic' ? chamarAnthropic(opcoes) : chamarOpenAI(opcoes);
}

// ---------------------------------------------------------------- lista de modelos do provedor
// Modelos que não servem para conversar com ferramentas (embeddings, áudio, imagem, moderação…).
const FORA_DO_CHAT = /embed|whisper|tts|dall-?e|moderation|davinci|babbage|audio|realtime|transcribe|image|vision-preview|search|rerank|speech|ocr|sora|-instruct$/i;

export async function listarModelos({ provedor, chave, baseUrl, fetch: buscar }) {
  const def = PROVEDORES[provedor];
  if (!def) throw new ErroApp(422, 'Provedor de IA desconhecido.');
  if (!chave) throw new ErroApp(422, 'Informe a chave de API para carregar os modelos.');
  if (def.dialeto === 'anthropic') {
    const client = new Anthropic({ apiKey: chave, ...(baseUrl ? { baseURL: baseUrl } : {}), timeout: 20_000, maxRetries: 1, ...(buscar ? { fetch: buscar } : {}) });
    const modelos = [];
    try {
      for await (const m of client.models.list({ limit: 100 })) {
        if (m.lifecycle === 'retired') continue;
        modelos.push({ id: m.id, nome: m.display_name || m.id, criadoEm: m.created_at || null, obsoleto: m.lifecycle === 'deprecated' });
      }
    } catch (e) {
      if (e instanceof Anthropic.APIConnectionError) throw new ErroIA('Sem resposta da Anthropic ao listar os modelos. Tente de novo.');
      if (e instanceof Anthropic.APIError) throw new ErroIA(mensagemDeErro(e.status, e.error, 'Anthropic'));
      throw e;
    }
    return modelos;
  }
  const base = (baseUrl || def.baseUrl).replace(/\/+$/, '');
  let resp;
  try {
    resp = await (buscar || globalThis.fetch)(`${base}/models`, { headers: { Accept: 'application/json', Authorization: `Bearer ${chave}` }, signal: AbortSignal.timeout(20_000) });
  } catch { throw new ErroIA(`Sem resposta do provedor ${def.nome} ao listar os modelos. Tente de novo.`); }
  const dados = await resp.json().catch(() => null);
  if (!resp.ok) throw new ErroIA(mensagemDeErro(resp.status, dados, def.nome));
  const lista = Array.isArray(dados?.data) ? dados.data : Array.isArray(dados?.models) ? dados.models : Array.isArray(dados) ? dados : [];
  return lista
    .map((m) => (typeof m === 'string' ? { id: m } : m))
    .filter((m) => m && typeof m.id === 'string' && !FORA_DO_CHAT.test(m.id))
    // OpenRouter informa os parâmetros aceitos: só entram os modelos que usam ferramentas (o assistente precisa delas).
    .filter((m) => !Array.isArray(m.supported_parameters) || m.supported_parameters.includes('tools'))
    .map((m) => ({ id: m.id, nome: m.name || m.display_name || m.id, criadoEm: m.created ? new Date(m.created * 1000).toISOString() : (m.created_at || null), obsoleto: false }))
    .sort((a, b) => String(b.criadoEm || '').localeCompare(String(a.criadoEm || '')) || a.id.localeCompare(b.id))
    .slice(0, 400);
}
