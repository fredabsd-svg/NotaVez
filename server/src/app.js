// Monta o servidor HTTP (Fastify). Separado de index.js para permitir testes.
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { abrirBanco } from './db/banco.js';
import { criarRepositorio } from './db/repositorio.js';
import { criarAutenticacao, COOKIE } from './security/autenticacao.js';
import { criarServicoEmissao } from './fiscal/emissao.js';
import { criarClienteSefin } from './fiscal/sefin/cliente.js';
import { ErroApp } from './util/erros.js';
import { rotasConta } from './routes/conta.js';
import { rotasPerfil } from './routes/perfil.js';
import { rotasClientes } from './routes/clientes.js';
import { rotasServicos } from './routes/servicos.js';
import { rotasNotas } from './routes/notas.js';
import { rotasTabelas } from './routes/tabelas.js';

export async function criarApp({ banco = config.bancoArquivo, fabricaCliente = criarClienteSefin, logger = !config.dev, servirWeb = config.servirWeb } = {}) {
  const db = abrirBanco(banco);
  const repo = criarRepositorio(db);
  const auth = criarAutenticacao(db);
  const emissao = criarServicoEmissao({ repo, fabricaCliente });

  const app = Fastify({ logger: logger && { level: 'info', redact: ['req.headers.cookie'] }, bodyLimit: 1024 * 1024, trustProxy: true });
  await app.register(cookie);

  app.decorate('ctx', { db, repo, auth, emissao });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.url.startsWith('/api/') && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    if (!config.dev) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return payload;
  });

  // Proteção CSRF: toda alteração exige cabeçalho próprio (bloqueado entre origens pelo CORS).
  app.addHook('onRequest', async (req) => {
    if (req.url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-notavez'] !== '1') {
      throw new ErroApp(403, 'Requisição recusada.');
    }
  });

  // Autenticação: rotas /api/* exceto conta/entrar|cadastrar e tabelas públicas.
  app.decorateRequest('usuario', null);
  app.decorateRequest('prestador', null);
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const livre = /^\/api\/(conta\/(entrar|cadastrar)|saude|tabelas\/)/.test(req.url) || (config.demo && req.url.startsWith('/api/demo/'));
    req.usuario = auth.usuarioDaSessao(req.cookies[COOKIE]);
    if (!req.usuario && !livre) throw new ErroApp(401, 'Entre na sua conta para continuar.');
    if (req.usuario) req.prestador = repo.prestadorDoUsuario(req.usuario.id);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ErroApp) return reply.code(err.status).send({ erro: err.message, ...err.extra });
    if (err.validation || err.statusCode === 400) return reply.code(400).send({ erro: 'Dados enviados em formato inválido.' });
    if (err.statusCode === 413) return reply.code(413).send({ erro: 'Arquivo grande demais.' });
    req.log?.error(err);
    return reply.code(500).send({ erro: 'Algo deu errado do nosso lado. Nada foi emitido por causa deste erro. Tente novamente.' });
  });

  app.get('/api/saude', async () => ({ ok: true, demo: config.demo }));
  await app.register(rotasConta, { prefix: '/api/conta' });
  await app.register(rotasPerfil, { prefix: '/api' });
  await app.register(rotasClientes, { prefix: '/api/clientes' });
  await app.register(rotasServicos, { prefix: '/api/servicos' });
  await app.register(rotasNotas, { prefix: '/api' });
  await app.register(rotasTabelas, { prefix: '/api/tabelas' });

  if (servirWeb) {
    await app.register(fastifyStatic, {
      root: fileURLToPath(new URL('../../web/', import.meta.url)),
      setHeaders: (res, caminho) => {
        if (/sw\.js$|index\.html$|manifest/.test(caminho)) res.setHeader('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/')
      ? reply.code(404).send({ erro: 'Rota não encontrada.' })
      : reply.sendFile('index.html')));
  }

  app.addHook('onClose', async () => { emissao.fecharClientes(); db.fechar(); });
  return app;
}
