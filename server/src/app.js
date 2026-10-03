// Monta o servidor HTTP (Fastify). Separado de index.js para permitir testes.
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
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
import { criarLimites } from './security/limites.js';
import { criarEntregaRecuperacao } from './security/recuperacao-entrega.js';

export async function criarApp({ banco = config.bancoArquivo, fabricaCliente = criarClienteSefin, logger = !config.dev, servirWeb = config.servirWeb,
  entregarRecuperacao = criarEntregaRecuperacao(), contaPublica = config.contaPublica, proxiesConfiaveis = config.proxiesConfiaveis,
  assetlinksArquivo = config.assetlinksArquivo } = {}) {
  const db = abrirBanco(banco);
  const repo = criarRepositorio(db);
  const auth = criarAutenticacao(db, { entregarRecuperacao });
  const emissao = criarServicoEmissao({ repo, fabricaCliente });
  const limites = criarLimites(db);

  const app = Fastify({ logger: logger && { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body'] }, bodyLimit: 1024 * 1024, trustProxy: proxiesConfiaveis });
  await app.register(cookie);

  app.decorate('ctx', { db, repo, auth, emissao, contaPublica });

  // Decide pela rota que o roteador escolheu, não pelo texto da URL: o roteador
  // decodifica o caminho (ex.: "/%61pi/notas" cai em "/api/notas"), então checar
  // req.url deixaria passar caminhos codificados sem login nem anti-CSRF.
  const rotaApi = (req) => (req.routeOptions?.url || '').startsWith('/api/');

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if ((rotaApi(req) || req.url.startsWith('/api/')) && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    if (!config.dev) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return payload;
  });

  // Proteção CSRF: toda alteração exige cabeçalho próprio (bloqueado entre origens pelo CORS).
  app.addHook('onRequest', async (req) => {
    if (rotaApi(req) && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-notavez'] !== '1') {
      throw new ErroApp(403, 'Requisição recusada.');
    }
  });

  // Autenticação: rotas /api/* exceto conta/entrar|cadastrar e tabelas públicas.
  app.decorateRequest('usuario', null);
  app.decorateRequest('prestador', null);
  app.addHook('preHandler', async (req) => {
    if (!rotaApi(req)) return;
    const rota = req.routeOptions.url;
    const livre = /^\/api\/(conta\/(entrar|cadastrar|recuperar|redefinir|transparencia)$|saude$|tabelas\/)/.test(rota) || (config.demo && rota.startsWith('/api/demo/'));
    req.usuario = auth.usuarioDaSessao(req.cookies[COOKIE]);
    if (!req.usuario && !livre) throw new ErroApp(401, 'Entre na sua conta para continuar.');
    if (req.usuario) req.prestador = repo.prestadorDoUsuario(req.usuario.id);
    // A sessão pode ter sido trocada em outra aba depois que a tela foi aberta.
    // A identidade esperada é uma precondição, nunca uma fonte de autorização.
    if (req.usuario && !livre && !(req.method === 'GET' && rota === '/api/conta')) {
      const usuario = req.headers['x-notavez-usuario'];
      const prestador = req.headers['x-notavez-prestador'];
      if ((usuario !== undefined && usuario !== req.usuario.id)
        || (prestador !== undefined && prestador !== (req.prestador?.id || ''))) {
        throw new ErroApp(409, 'A conta mudou. Entre novamente antes de continuar.', { codigo: 'CONTA_ALTERADA' });
      }
    }
    limites.requisicao(req);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ErroApp) return reply.code(err.status).send({ erro: err.message, ...err.extra });
    if (err.validation || err.statusCode === 400) return reply.code(400).send({ erro: 'Dados enviados em formato inválido.' });
    if (err.statusCode === 413) return reply.code(413).send({ erro: 'Arquivo grande demais.' });
    // Recusas dos plugins (ex.: caminho malicioso barrado pelo @fastify/static): mantém o 4xx.
    if (err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ erro: { 403: 'Acesso negado.', 404: 'Não encontrado.' }[err.statusCode] || 'Requisição inválida.' });
    }
    req.log?.error(err);
    return reply.code(500).send({ erro: 'Não foi possível concluir a operação. Se você solicitou uma emissão, consulte a situação da nota antes de tentar novamente.', codigo: 'RESULTADO_NAO_CONFIRMADO' });
  });

  // Sem configuração, responde 404 real: nunca devolve index.html como DAL.
  let assetlinks = null;
  if (assetlinksArquivo) {
    assetlinks = JSON.parse(readFileSync(assetlinksArquivo, 'utf8'));
    if (!Array.isArray(assetlinks) || !assetlinks.length) throw new Error('Digital Asset Links inválido.');
  }
  app.get('/.well-known/assetlinks.json', async (_req, reply) => assetlinks
    ? reply.header('Cache-Control', 'public, max-age=300').send(assetlinks)
    : reply.code(404).send({ erro: 'Associação Android ainda não configurada.' }));

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
      // @fastify/static 10: setHeaders recebe o reply do Fastify (não mais o res do Node).
      setHeaders: (reply, caminho) => {
        if (/sw\.js$|index\.html$|manifest/.test(caminho)) reply.header('Cache-Control', 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/')
      ? reply.code(404).send({ erro: 'Rota não encontrada.' })
      : reply.sendFile('index.html')));
  }

  app.addHook('onClose', async () => { emissao.fecharClientes(); db.fechar(); });
  return app;
}
