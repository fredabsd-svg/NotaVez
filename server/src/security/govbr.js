// Entrar com gov.br (Login Único, OpenID Connect, fluxo authorization code).
// - A senha do gov.br é digitada só no site do gov.br: o app nunca a vê.
// - Os tokens do gov.br não são guardados: o app lê o id_token assinado, confere
//   assinatura (JWKS), emissor, destinatário, validade e nonce, e usa o CPF (sub).
// - Entrar com gov.br NÃO autoriza a API da NFS-e: a emissão continua exigindo o
//   certificado A1 do emitente (mTLS), como manda a Receita.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

const b64url = (b) => Buffer.from(b).toString('base64url');
const FOLGA_S = 120;

export function criarGovbr({ clientId, clientSecret, emissor, redirectUri }, { fetchImpl = globalThis.fetch, agoraMs = Date.now } = {}) {
  if (!clientId || !clientSecret || !emissor || !redirectUri) throw new Error('gov.br: configure client id, segredo, ambiente e endereço de retorno.');
  const base = String(emissor).replace(/\/$/, '');
  if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error('gov.br: o emissor precisa ser HTTPS.');
  let jwks = null; let jwksEm = 0;

  async function chaves(forcar = false) {
    if (!forcar && jwks && agoraMs() - jwksEm < 3600_000) return jwks;
    const r = await fetchImpl(`${base}/jwk`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error('gov.br: chaves públicas indisponíveis.');
    jwks = (await r.json()).keys || [];
    jwksEm = agoraMs();
    return jwks;
  }

  return {
    /** Dados que ficam guardados (cifrados) até o retorno: verificador PKCE e nonce. */
    novoPedido() {
      return { verificador: b64url(randomBytes(32)), nonce: b64url(randomBytes(24)) };
    },
    urlAutorizacao(state, { verificador, nonce }) {
      const u = new URL(`${base}/authorize`);
      u.search = new URLSearchParams({
        response_type: 'code', client_id: clientId, scope: 'openid email profile', redirect_uri: redirectUri, state, nonce,
        code_challenge: b64url(createHash('sha256').update(verificador).digest()), code_challenge_method: 'S256',
      }).toString();
      return u.href;
    },
    async trocarCodigo(code, verificador) {
      if (typeof code !== 'string' || !code || code.length > 2048) throw new Error('gov.br: código ausente.');
      const r = await fetchImpl(`${base}/token`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}` },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verificador }).toString(),
      });
      if (!r.ok) throw new Error('gov.br: troca do código recusada.');
      const corpo = await r.json();
      if (typeof corpo.id_token !== 'string') throw new Error('gov.br: resposta sem id_token.');
      return corpo.id_token;
    },
    async validarIdToken(idToken, nonce) {
      const partes = String(idToken).split('.');
      if (partes.length !== 3) throw new Error('gov.br: id_token malformado.');
      const cabecalho = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8'));
      const alg = { RS256: 'sha256', RS512: 'sha512' }[cabecalho.alg];
      if (!alg) throw new Error('gov.br: algoritmo de assinatura não aceito.');
      let jwk = (await chaves()).find((k) => k.kid === cabecalho.kid && k.kty === 'RSA');
      if (!jwk) jwk = (await chaves(true)).find((k) => k.kid === cabecalho.kid && k.kty === 'RSA');
      if (!jwk) throw new Error('gov.br: chave de assinatura desconhecida.');
      const ok = verify(alg, Buffer.from(`${partes[0]}.${partes[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(partes[2], 'base64url'));
      if (!ok) throw new Error('gov.br: assinatura do id_token inválida.');
      const c = JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8'));
      const agora = Math.floor(agoraMs() / 1000);
      if (String(c.iss).replace(/\/$/, '') !== base) throw new Error('gov.br: emissor inesperado.');
      if (!(Array.isArray(c.aud) ? c.aud.includes(clientId) : c.aud === clientId)) throw new Error('gov.br: token emitido para outro serviço.');
      if (!(c.exp > agora - FOLGA_S) || (c.iat && c.iat > agora + FOLGA_S)) throw new Error('gov.br: token fora da validade.');
      if (!nonce || c.nonce !== nonce) throw new Error('gov.br: nonce não confere.');
      const cpf = String(c.sub || '');
      if (!/^\d{11}$/.test(cpf)) throw new Error('gov.br: CPF ausente no token.');
      return { cpf, nome: typeof c.name === 'string' ? c.name : null };
    },
  };
}
