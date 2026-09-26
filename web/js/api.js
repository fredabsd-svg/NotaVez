// Cliente da API do servidor Nota Sem Stress. Sem internet → ErroApi(0).
export class ErroApi extends Error {
  constructor(status, dados) {
    super(dados?.erro || (status === 0 ? 'Sem conexão com a internet.' : 'Não foi possível concluir.'));
    this.status = status;
    this.dados = dados || {};
  }
}

export async function api(metodo, url, corpo) {
  if (!navigator.onLine) throw new ErroApi(0);
  let r;
  try {
    r = await fetch(url, {
      method: metodo,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(metodo !== 'GET' ? { 'Content-Type': 'application/json', 'X-NotaVez': '1' } : {}) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
  } catch {
    throw new ErroApi(0);
  }
  const tipo = r.headers.get('content-type') || '';
  const dados = tipo.includes('json') ? await r.json() : null;
  if (!r.ok) {
    if (r.status === 401 && !url.includes('/api/conta/')) window.dispatchEvent(new CustomEvent('notavez:sessao-expirada'));
    throw new ErroApi(r.status, dados);
  }
  return dados;
}
