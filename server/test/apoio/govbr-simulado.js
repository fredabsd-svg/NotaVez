// Simulador LOCAL do Login Único gov.br (OpenID Connect) para testes: /token
// com PKCE e autenticação do cliente, /jwk com a chave pública, id_token RS256.
// Não substitui a homologação no ambiente staging do gov.br.
import http from 'node:http';
import { createHash, generateKeyPairSync, createSign } from 'node:crypto';

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export async function iniciarGovbrSimulado({ clientId, clientSecret }) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'teste1', alg: 'RS256', use: 'sig' };
  const codigos = new Map();
  let base;
  let cpfNavegador = '52998224725';
  const codigosNavegador = (u) => {
    const code = `codigo-navegador-${codigos.size + 1}-${Date.now()}`;
    codigos.set(code, { cpf: cpfNavegador, nonce: u.searchParams.get('nonce'), desafio: u.searchParams.get('code_challenge'), sobrescrever: {} });
    return { code, state: u.searchParams.get('state') };
  };
  const assinar = (claims, { kid = 'teste1' } = {}) => {
    const cabecalho = b64url({ alg: 'RS256', kid, typ: 'JWT' });
    const corpo = b64url(claims);
    const s = createSign('RSA-SHA256'); s.update(`${cabecalho}.${corpo}`);
    return `${cabecalho}.${corpo}.${s.sign(privateKey).toString('base64url')}`;
  };
  const servidor = http.createServer((req, res) => {
    const responder = (status, corpo) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(corpo)); };
    if (req.url === '/jwk') return responder(200, { keys: [jwk] });
    // Tela de autorização simulada: aprova na hora com um CPF fictício (só para testes no navegador).
    if (req.url.startsWith('/authorize?')) {
      const u = new URL(req.url, base);
      const { code, state } = codigosNavegador(u);
      res.writeHead(302, { Location: `${u.searchParams.get('redirect_uri')}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}` });
      return res.end();
    }
    if (req.url === '/token' && req.method === 'POST') {
      let corpo = '';
      req.on('data', (d) => { corpo += d; });
      req.on('end', () => {
        const p = new URLSearchParams(corpo);
        const esperado = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
        if (req.headers.authorization !== esperado) return responder(401, { error: 'invalid_client' });
        const c = codigos.get(p.get('code'));
        codigos.delete(p.get('code'));
        if (!c || p.get('grant_type') !== 'authorization_code') return responder(400, { error: 'invalid_grant' });
        if (createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== c.desafio) return responder(400, { error: 'invalid_grant', detalhe: 'pkce' });
        const agora = Math.floor(Date.now() / 1000);
        const claims = { iss: `${base}/`, aud: clientId, sub: c.cpf, nonce: c.nonce, iat: agora, exp: agora + 300, name: 'Pessoa de Teste', ...c.sobrescrever };
        return responder(200, { access_token: 'nao-guardar', token_type: 'Bearer', id_token: c.tokenBruto || assinar(claims) });
      });
      return undefined;
    }
    return responder(404, {});
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  return {
    url: base,
    /** O usuário "autorizou" no gov.br: gera o código para a URL de autorização recebida. */
    autorizar(urlAutorizacao, { cpf = '52998224725', sobrescrever = {}, tokenBruto = null } = {}) {
      const u = new URL(urlAutorizacao);
      const code = `codigo-${codigos.size + 1}-${Date.now()}`;
      codigos.set(code, { cpf, nonce: u.searchParams.get('nonce'), desafio: u.searchParams.get('code_challenge'), sobrescrever, tokenBruto });
      return { code, state: u.searchParams.get('state'), params: u.searchParams };
    },
    assinar,
    definirCpfNavegador: (cpf) => { cpfNavegador = cpf; },
    fechar: () => new Promise((r) => servidor.close(r)),
  };
}
