// Monta o servidor HTTP (Fastify). Separado de index.js para permitir testes.
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { abrirBanco } from './db/banco.js';
import { criarRepositorio } from './db/repositorio.js';
import { criarAutenticacao, COOKIE, opcoesCookie } from './security/autenticacao.js';
import { criarServicoEmissao } from './fiscal/emissao.js';
import { criarClienteSefin } from './fiscal/sefin/cliente.js';
import { ErroApp } from './util/erros.js';
import { rotasConta } from './routes/conta.js';
import { rotasPerfil } from './routes/perfil.js';
import { rotasClientes } from './routes/clientes.js';
import { rotasServicos } from './routes/servicos.js';
import { rotasNotas } from './routes/notas.js';
import { rotasTabelas } from './routes/tabelas.js';
import { rotasEmpresas } from './routes/empresas.js';
import { rotasTomadas } from './routes/tomadas.js';
import { rotasIa } from './routes/ia.js';
import { criarConsultaCnpj } from './cadastro/consulta-cnpj.js';
import { criarServicoTomadas } from './fiscal/tomadas.js';
import { auditar } from './security/auditoria.js';
import { criarGovBr } from './security/govbr.js';
import { criarLimites } from './security/limites.js';
import { criarEntregaRecuperacao } from './security/recuperacao-entrega.js';

export async function criarApp({ banco = config.bancoArquivo, fabricaCliente = criarClienteSefin, logger = !config.dev, servirWeb = config.servirWeb,
  entregarRecuperacao = criarEntregaRecuperacao(), contaPublica = config.contaPublica, proxiesConfiaveis = config.proxiesConfiaveis,
  assetlinksArquivo = config.assetlinksArquivo, consultarCnpj = criarConsultaCnpj(), govbr = config.govbr, pausaEntreEmpresasMs, intervaloSincronizacaoMs, chamarIa, listarModelosIa } = {}) {
  const db = await abrirBanco(banco);
  const repo = criarRepositorio(db);
  const auth = criarAutenticacao(db, { entregarRecuperacao });
  const emissao = criarServicoEmissao({ repo, fabricaCliente });
  const limites = criarLimites(db);

  const app = Fastify({ logger: logger && { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body'] }, bodyLimit: 1024 * 1024, trustProxy: proxiesConfiaveis });
  await app.register(cookie);

  const tomadas = criarServicoTomadas({ repo, emissao, registrar: (evento) => auditar(db, evento), ...(pausaEntreEmpresasMs !== undefined ? { pausaEntreEmpresasMs } : {}),
    ...(intervaloSincronizacaoMs !== undefined ? { intervaloMinimoMs: intervaloSincronizacaoMs } : {}) });
  app.decorate('ctx', { db, repo, auth, emissao, tomadas, limites, consultarCnpj, contaPublica, govbr: criarGovBr(db, govbr) });

  // Decide pela rota que o roteador escolheu, não pelo texto da URL: o roteador
  // decodifica o caminho (ex.: "/%61pi/notas" cai em "/api/notas"), então checar
  // req.url deixaria passar caminhos codificados sem login nem anti-CSRF.
  const rotaApi = (req) => (req.routeOptions?.url || '').startsWith('/api/');

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
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
  app.decorateRequest('empresaPedida', undefined);
  app.addHook('preHandler', async (req, reply) => {
    if (!rotaApi(req)) return;
    const rota = req.routeOptions.url;
    // "sair" é livre: encerra a sessão mesmo se a conta ou a empresa mudaram em outra aba.
    // gov.br: só as rotas GET (descoberta, início e retorno) dispensam sessão.
    const livre = /^\/api\/(conta\/(entrar|cadastrar|recuperar|recuperacao|redefinir|redefinir-codigo|transparencia|sair)$|saude$|tabelas\/)/.test(rota)
      || (req.method === 'GET' && /^\/api\/conta\/govbr(\/(entrar|retorno))?$/.test(rota))
      || (config.demo && rota.startsWith('/api/demo/'))
      // Tarefas agendadas: sem sessão, mas só com o segredo do Cron (conferido na própria rota).
      || (req.method === 'GET' && rota.startsWith('/api/cron/'));
    req.usuario = await auth.usuarioDaSessao(req.cookies[COOKIE]);
    if (req.usuario?.renovada) reply.setCookie(COOKIE, req.cookies[COOKIE], opcoesCookie(true, config.cookieSeguro));
    if (!req.usuario && !livre) throw new ErroApp(401, 'Entre na sua conta para continuar.');
    // A sessão pode ter sido trocada em outra aba depois que a tela foi aberta.
    // A identidade esperada é uma precondição, nunca uma fonte de autorização.
    if (req.usuario && !livre && !(req.method === 'GET' && rota === '/api/conta')) {
      const usuario = req.headers['x-notavez-usuario'];
      if (usuario !== undefined && usuario !== req.usuario.id) {
        throw new ErroApp(409, 'A conta mudou. Entre novamente antes de continuar.', { codigo: 'CONTA_ALTERADA' });
      }
    }
    // Empresa ativa: escolhida pelo app (cabeçalho, ou ?empresa= em links de
    // download) e sempre conferida contra o dono. Sem indicação, a primeira
    // empresa da conta (compatível com quem tem uma só).
    if (req.usuario) {
      const pedida = req.headers['x-notavez-prestador'] ?? (req.method === 'GET' ? req.query?.empresa : undefined);
      const descoberta = req.method === 'GET' && rota === '/api/conta';
      req.empresaPedida = pedida;
      if (pedida === undefined) req.prestador = await repo.prestadorDoUsuario(req.usuario.id);
      else if (pedida) {
        req.prestador = await repo.prestadorDoUsuarioPorId(req.usuario.id, pedida);
        if (!req.prestador && !descoberta && !livre) throw new ErroApp(409, 'Esta empresa não está mais disponível na sua conta.', { codigo: 'EMPRESA_INDISPONIVEL' });
      }
    }
    await limites.requisicao(req);
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

  // Tarefas agendadas (Vercel Cron): conferir notas pendentes e buscar na Receita as notas de todas as
  // empresas. Num servidor contínuo (npm start) elas rodam sozinhas em segundo plano (index.js).
  const cronAutorizado = (req) => {
    const esperado = Buffer.from(`Bearer ${config.cronSegredo}`);
    const recebido = Buffer.from(String(req.headers.authorization || ''));
    return !!config.cronSegredo && esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
  };
  app.get('/api/cron/pendentes', async (req) => {
    if (!cronAutorizado(req)) throw new ErroApp(401, 'Não autorizado.');
    await emissao.verificarPendentes();
    return { ok: true };
  });
  // De hora em hora (24 agendamentos diários no vercel.json: o plano Hobby aceita cada um uma vez por dia).
  app.get('/api/cron/sincronizar', async (req) => {
    if (!cronAutorizado(req)) throw new ErroApp(401, 'Não autorizado.');
    // Para antes do tempo máximo da função; as empresas que faltarem ficam para a próxima rodada (rodízio).
    // Empresa consultada há menos de 30 min fica para a próxima: a Vercel dispara em qualquer minuto da hora marcada.
    const r = await tomadas.sincronizarTodas({ ateMs: Date.now() + Number(process.env.NOTAVEZ_CRON_SEGUNDOS || 240) * 1000, recenteMs: 30 * 60_000 });
    // Só contagens no log (nada de CNPJ ou nome).
    console.log(`[sincronização automática] ${JSON.stringify(r)}`);
    return { ok: true, ...r };
  });
  await app.register(rotasConta, { prefix: '/api/conta' });
  await app.register(rotasPerfil, { prefix: '/api' });
  await app.register(rotasClientes, { prefix: '/api/clientes' });
  await app.register(rotasServicos, { prefix: '/api/servicos' });
  await app.register(rotasNotas, { prefix: '/api' });
  await app.register(rotasTabelas, { prefix: '/api/tabelas' });
  await app.register(rotasEmpresas, { prefix: '/api' });
  await app.register(rotasTomadas, { prefix: '/api/tomadas' });
  await app.register(rotasIa, { prefix: '/api/ia', chamarIa, listarModelosIa });

  if (servirWeb) {
    // Carregado só aqui: na Vercel o PWA é estático e a função não precisa (nem consegue) carregar este plugin.
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, {
      root: fileURLToPath(new URL('../../web/', import.meta.url)),
      // @fastify/static 10: setHeaders recebe o reply do Fastify (não mais o res do Node).
      setHeaders: (reply, caminho) => {
        if (/sw\.js$|index\.html$|manifest/.test(caminho)) reply.header('Cache-Control', 'no-cache');
        // Ícones e logotipos quase nunca mudam: um dia de cache poupa pedidos a cada abertura.
        else if (/[\\/]icons[\\/]/.test(caminho)) reply.header('Cache-Control', 'public, max-age=86400');
      },
    });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/')
      ? reply.code(404).send({ erro: 'Rota não encontrada.' })
      : reply.sendFile('index.html')));
  }

  app.addHook('onClose', async () => { emissao.fecharClientes(); await db.fechar(); });
  return app;
}
