// Entrar com gov.br (Login Único, OpenID Connect com PKCE). Serve só para
// IDENTIFICAR o titular no Nota Sem Stress: o gov.br não autoriza terceiros a
// emitir NFS-e (isso continua exigindo o certificado A1 da empresa).
// Requer credenciais (client_id/secret) concedidas pelo governo para a URL de
// retorno do app; sem elas o botão não aparece.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { agora } from '../db/banco.js';
import { hashToken } from './cripto.js';
import { cpfValido } from '../util/documentos.js';
import { ErroApp } from '../util/erros.js';

export const BASES_GOVBR = { producao: 'https://sso.acesso.gov.br', staging: 'https://sso.staging.acesso.gov.br' };
const VALIDADE_FLUXO_MS = 10 * 60_000;
const VALIDADE_JWKS_MS = 3600_000;
const FOLGA_RELOGIO_S = 120;
const b64url = (b) => Buffer.from(b).toString('base64url');
const jsonB64 = (t) => JSON.parse(Buffer.from(t, 'base64url').toString('utf8'));

export function criarGovBr(db, { clientId, clientSecret, redirectUri, base = BASES_GOVBR.producao, buscar = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS govbr_fluxos (
    token_hash TEXT PRIMARY KEY, state TEXT NOT NULL, nonce TEXT NOT NULL, verificador TEXT NOT NULL,
    modo TEXT NOT NULL, usuario_id TEXT REFERENCES usuarios(id) ON DELETE CASCADE, expira_em TEXT NOT NULL
  );`);
  const configurado = !!(clientId && clientSecret && redirectUri && base);
  const raiz = String(base || '').replace(/\/+$/, '');
  let jwks = null;

  async function chaves(forcar = false) {
    if (!forcar && jwks && Date.now() - jwks.em < VALIDADE_JWKS_MS) return jwks.chaves;
    const r = await buscar(`${raiz}/jwk`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`jwk http_${r.status}`);
    jwks = { em: Date.now(), chaves: (await r.json()).keys || [] };
    return jwks.chaves;
  }

  // id_token: assinatura RS256 com a chave publicada pelo gov.br, emissor, público, nonce e validade.
  async function validarIdToken(idToken, nonce) {
    const partes = String(idToken || '').split('.');
    if (partes.length !== 3) throw new Error('id_token malformado');
    const cab = jsonB64(partes[0]);
    if (cab.alg !== 'RS256') throw new Error('algoritmo não aceito');
    let jwk = (await chaves()).find((k) => k.kid === cab.kid);
    if (!jwk) jwk = (await chaves(true)).find((k) => k.kid === cab.kid);
    if (!jwk) throw new Error('chave desconhecida');
    const ok = verify('RSA-SHA256', Buffer.from(`${partes[0]}.${partes[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(partes[2], 'base64url'));
    if (!ok) throw new Error('assinatura inválida');
    const c = jsonB64(partes[1]);
    const agoraS = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (String(c.iss || '').replace(/\/+$/, '') !== raiz) throw new Error('emissor inválido');
    if (!aud.includes(clientId)) throw new Error('público inválido');
    if (c.nonce !== nonce) throw new Error('nonce inválido');
    if (!(Number(c.exp) + FOLGA_RELOGIO_S > agoraS) || (c.iat && Number(c.iat) - FOLGA_RELOGIO_S > agoraS)) throw new Error('token expirado');
    if (!cpfValido(c.sub)) throw new Error('CPF ausente');
    return c;
  }

  return {
    configurado,
    // Começa o login: guarda state/nonce/PKCE ligados a um cookie deste navegador.
    iniciar({ modo = 'entrar', usuarioId = null } = {}) {
      if (!configurado) throw new ErroApp(503, 'O acesso com gov.br ainda não está disponível neste servidor.');
      const token = randomBytes(32).toString('base64url');
      const state = randomBytes(24).toString('base64url');
      const nonce = randomBytes(24).toString('base64url');
      const verificador = randomBytes(48).toString('base64url');
      db.run('DELETE FROM govbr_fluxos WHERE expira_em <= ?', agora());
      db.run('INSERT INTO govbr_fluxos (token_hash, state, nonce, verificador, modo, usuario_id, expira_em) VALUES (?,?,?,?,?,?,?)',
        hashToken(`govbr:${token}`), state, nonce, verificador, modo, usuarioId, new Date(Date.now() + VALIDADE_FLUXO_MS).toISOString());
      const qs = new URLSearchParams({
        response_type: 'code', client_id: clientId, scope: 'openid email profile', redirect_uri: redirectUri,
        nonce, state, code_challenge: b64url(createHash('sha256').update(verificador).digest()), code_challenge_method: 'S256',
      });
      return { token, url: `${raiz}/authorize?${qs}` };
    },

    // Retorno do gov.br: o fluxo é de uso único e precisa do mesmo navegador (cookie) e state.
    async concluir({ token, state, code }) {
      if (!configurado) throw new ErroApp(503, 'O acesso com gov.br ainda não está disponível neste servidor.');
      const fluxo = token ? db.get('SELECT * FROM govbr_fluxos WHERE token_hash = ?', hashToken(`govbr:${token}`)) : null;
      if (fluxo) db.run('DELETE FROM govbr_fluxos WHERE token_hash = ?', fluxo.token_hash);
      if (!fluxo || fluxo.state !== state || fluxo.expira_em <= agora() || typeof code !== 'string' || !code) {
        throw new ErroApp(400, 'O acesso com gov.br expirou ou foi aberto em outro navegador. Tente de novo.', { codigo: 'GOVBR_FLUXO' });
      }
      let claims;
      try {
        const r = await buscar(`${raiz}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: fluxo.verificador }).toString(),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!r.ok) throw new Error(`token http_${r.status}`);
        claims = await validarIdToken((await r.json()).id_token, fluxo.nonce);
      } catch {
        throw new ErroApp(502, 'Não foi possível confirmar o acesso com o gov.br. Tente de novo em instantes.', { codigo: 'GOVBR_FALHA' });
      }
      return {
        modo: fluxo.modo, usuarioId: fluxo.usuario_id,
        cpf: String(claims.sub), nome: claims.social_name || claims.name || null,
        email: claims.email || null, emailVerificado: claims.email_verified === true || claims.email_verified === 'true',
      };
    },
  };
}
