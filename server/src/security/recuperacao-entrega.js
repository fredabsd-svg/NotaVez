// O operador configura um serviço de entrega; nenhum domínio/remetente é presumido.
export function criarEntregaRecuperacao({ url = process.env.NOTAVEZ_RECUPERACAO_WEBHOOK, token = process.env.NOTAVEZ_RECUPERACAO_WEBHOOK_TOKEN, fetchImpl = globalThis.fetch } = {}) {
  if (!url) return undefined;
  const destino = new URL(url);
  if (destino.protocol !== 'https:' || destino.username || destino.password || destino.hash || !token) throw new Error('Recuperação exige webhook HTTPS e token de autenticação.');
  return async ({ email, token: recuperacaoToken, expiraEm }) => {
    const r = await fetchImpl(destino.href, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email, token: recuperacaoToken, expiraEm }),
    });
    // Não incluir URL, corpo ou token em exceções/logs.
    if (!r.ok) throw new Error('Entrega de recuperação indisponível.');
    await r.body?.cancel();
  };
}
