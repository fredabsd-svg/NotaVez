// Catálogo de provedores de IA. Dois "dialetos" cobrem todos:
//  - anthropic: Messages API da Anthropic (SDK oficial @anthropic-ai/sdk);
//  - openai: Chat Completions no formato da OpenAI, que OpenAI, xAI (Grok), OpenRouter e os
//    provedores chineses (DeepSeek, Qwen, Kimi, GLM, MiniMax, Doubao, ERNIE, StepFun) aceitam.
// Os modelos listados são SUGESTÕES: o campo é livre, porque cada provedor lança modelos novos
// o tempo todo. Confira o identificador exato no painel do provedor.

export const PROVEDORES = {
  anthropic: {
    nome: 'Anthropic (Claude)', dialeto: 'anthropic', baseUrl: 'https://api.anthropic.com',
    modelos: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'], modeloPadrao: 'claude-opus-5-5',
    ondeObterChave: 'platform.claude.com › API Keys',
  },
  openai: {
    nome: 'OpenAI (GPT)', dialeto: 'openai', baseUrl: 'https://api.openai.com/v1',
    modelos: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'], modeloPadrao: 'gpt-5', ondeObterChave: 'platform.openai.com › API keys',
    // Modelos de raciocínio da OpenAI recusam max_tokens: o limite vai em max_completion_tokens.
    campoLimite: 'max_completion_tokens',
  },
  xai: {
    nome: 'xAI (Grok)', dialeto: 'openai', baseUrl: 'https://api.x.ai/v1',
    modelos: ['grok-4', 'grok-4-fast', 'grok-3'], modeloPadrao: 'grok-4', ondeObterChave: 'console.x.ai › API Keys',
  },
  openrouter: {
    nome: 'OpenRouter (vários modelos)', dialeto: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
    modelos: ['anthropic/claude-opus-5.5', 'openai/gpt-5', 'x-ai/grok-4', 'deepseek/deepseek-chat', 'qwen/qwen-max', 'moonshotai/kimi-k2', 'z-ai/glm-4.6'],
    modeloPadrao: 'anthropic/claude-opus-5.5', ondeObterChave: 'openrouter.ai › Keys',
  },
  deepseek: {
    nome: 'DeepSeek', dialeto: 'openai', baseUrl: 'https://api.deepseek.com/v1',
    modelos: ['deepseek-chat', 'deepseek-reasoner'], modeloPadrao: 'deepseek-chat', ondeObterChave: 'platform.deepseek.com › API keys',
  },
  qwen: {
    nome: 'Alibaba Qwen (DashScope / Model Studio)', dialeto: 'openai', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    modelos: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen3-max'], modeloPadrao: 'qwen-max', ondeObterChave: 'Alibaba Cloud Model Studio › API Key',
  },
  moonshot: {
    nome: 'Moonshot (Kimi)', dialeto: 'openai', baseUrl: 'https://api.moonshot.ai/v1',
    modelos: ['kimi-k2-turbo-preview', 'kimi-k2-0905-preview', 'moonshot-v1-128k'], modeloPadrao: 'kimi-k2-turbo-preview', ondeObterChave: 'platform.moonshot.ai › API Keys',
  },
  zhipu: {
    nome: 'Zhipu / Z.ai (GLM)', dialeto: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4',
    modelos: ['glm-4.6', 'glm-4.5', 'glm-4.5-air'], modeloPadrao: 'glm-4.6', ondeObterChave: 'z.ai › API Keys (na China: open.bigmodel.cn)',
  },
  minimax: {
    nome: 'MiniMax', dialeto: 'openai', baseUrl: 'https://api.minimax.io/v1',
    modelos: ['MiniMax-M2', 'MiniMax-M1'], modeloPadrao: 'MiniMax-M2', ondeObterChave: 'minimax.io › API Keys',
  },
  doubao: {
    nome: 'ByteDance Doubao (Volcengine Ark)', dialeto: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modelos: ['doubao-seed-1-6-250615', 'doubao-1-5-pro-32k-250115'], modeloPadrao: 'doubao-seed-1-6-250615', ondeObterChave: 'console.volcengine.com › Ark › API Key',
  },
  ernie: {
    nome: 'Baidu ERNIE (Qianfan)', dialeto: 'openai', baseUrl: 'https://qianfan.baidubce.com/v2',
    modelos: ['ernie-4.5-turbo-128k', 'ernie-x1-turbo-32k'], modeloPadrao: 'ernie-4.5-turbo-128k', ondeObterChave: 'console.bce.baidu.com › Qianfan › API Key',
  },
  stepfun: {
    nome: 'StepFun', dialeto: 'openai', baseUrl: 'https://api.stepfun.com/v1',
    modelos: ['step-2-16k', 'step-1-128k'], modeloPadrao: 'step-2-16k', ondeObterChave: 'platform.stepfun.com › API Keys',
  },
  personalizado: {
    nome: 'Outro compatível com OpenAI', dialeto: 'openai', baseUrl: '', modelos: [], modeloPadrao: '',
    ondeObterChave: 'No painel do provedor. Informe o endereço da API (termina em /v1, em geral).', exigeBaseUrl: true,
  },
};

export const provedorPublico = (id, p) => ({
  id, nome: p.nome, dialeto: p.dialeto, baseUrl: p.baseUrl, modelos: p.modelos, modeloPadrao: p.modeloPadrao,
  ondeObterChave: p.ondeObterChave, exigeBaseUrl: !!p.exigeBaseUrl,
});

// Endereço próprio (provedor "personalizado" ou outro endereço para um provedor conhecido):
// o servidor faria a chamada, então ele não pode apontar para a rede interna (SSRF).
const PRIVADO = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
export function validarBaseUrl(texto, { permitirLocal = false } = {}) {
  let u;
  try { u = new URL(String(texto || '').trim()); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')
    || PRIVADO.some((r) => r.test(host)) || host === '::1' || /^f[cd]/.test(host) || /^fe80:/.test(host) || !host.includes('.') && !host.includes(':');
  if (local && !permitirLocal) return null;
  if (u.protocol !== 'https:' && !(permitirLocal && u.protocol === 'http:')) return null;
  return u.toString().replace(/\/+$/, '');
}
