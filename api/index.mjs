// Função da Vercel: toda chamada a /api/* (e /.well-known/assetlinks.json) chega aqui e é atendida
// pelo mesmo servidor Fastify do app. O PWA (pasta web/) é servido como arquivos estáticos pela Vercel.
import { criarApp } from '../server/src/app.js';

let pronto = null;
function servidor() {
  pronto ??= criarApp({ servirWeb: false }).then(async (app) => { await app.ready(); return app; })
    .catch((e) => { pronto = null; throw e; }); // falhou ao subir (ex.: banco fora): a próxima chamada tenta de novo
  return pronto;
}

export default async function handler(req, res) {
  let app;
  try { app = await servidor(); } catch (e) {
    console.error('[nota-sem-stress] falha ao iniciar:', e?.message || e);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ erro: 'O servidor está iniciando ou sem acesso ao banco de dados. Tente de novo em instantes.' }));
    return;
  }
  app.server.emit('request', req, res);
}
