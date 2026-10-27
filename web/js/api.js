// Cliente da API do servidor Nota Sem Stress. Sem internet → ErroApi(0).
export class ErroApi extends Error {
  constructor(status, dados) {
    super(dados?.erro || (status === 0 ? 'Sem conexão com a internet.' : 'Não foi possível concluir.'));
    this.status = status;
    this.dados = dados || {};
  }
}

let identidade = null;
let epoca = 0;
export function definirIdentidadeApi(conta) {
  const proxima = conta?.usuarioId ? { usuarioId: conta.usuarioId, prestadorId: conta.prestadorId || null } : null;
  if (JSON.stringify(proxima) !== JSON.stringify(identidade)) epoca++;
  identidade = proxima;
}

// Cabeçalhos de identidade para downloads feitos com fetch fora de api().
export function cabecalhosIdentidade() {
  return identidade ? { 'X-NotaVez-Usuario': identidade.usuarioId, 'X-NotaVez-Prestador': identidade.prestadorId || '' } : {};
}
// Links abertos pelo navegador (sem cabeçalhos) dizem a empresa na URL.
export const comEmpresa = (url) => (identidade?.prestadorId ? `${url}${url.includes('?') ? '&' : '?'}empresa=${encodeURIComponent(identidade.prestadorId)}` : url);
export const urlConta = (empresa) => (empresa ? `/api/conta?empresa=${encodeURIComponent(empresa)}` : '/api/conta');

export async function api(metodo, url, corpo) {
  if (!navigator.onLine) throw new ErroApi(0);
  const identidadePedido = identidade;
  const epocaPedido = epoca;
  const descoberta = (metodo === 'GET' && /^\/api\/conta(\?|$)/.test(url)) || /^\/api\/conta\/(entrar|cadastrar|recuperar|redefinir)$/.test(url);
  let r;
  try {
    r = await fetch(url, {
      method: metodo,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(!descoberta && identidadePedido ? { 'X-NotaVez-Usuario': identidadePedido.usuarioId, 'X-NotaVez-Prestador': identidadePedido.prestadorId || '' } : {}), ...(metodo !== 'GET' ? { 'Content-Type': 'application/json', 'X-NotaVez': '1' } : {}) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
  } catch {
    throw new ErroApi(0);
  }
  const tipo = r.headers.get('content-type') || '';
  const dados = tipo.includes('json') ? await r.json() : null;
  if (!descoberta && epocaPedido !== epoca) throw new ErroApi(401, { erro: 'A conta mudou durante esta operação.' });
  if (!r.ok) {
    if ((r.status === 401 && !url.includes('/api/conta/')) || dados?.codigo === 'CONTA_ALTERADA') window.dispatchEvent(new CustomEvent('notavez:sessao-expirada'));
    if (dados?.codigo === 'EMPRESA_INDISPONIVEL') window.dispatchEvent(new CustomEvent('notavez:empresa-indisponivel'));
    throw new ErroApi(r.status, dados);
  }
  return dados;
}
