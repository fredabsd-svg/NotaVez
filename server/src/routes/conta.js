import { formatarDocumento } from '../util/documentos.js';
import { COOKIE, opcoesCookie } from '../security/autenticacao.js';
import { auditar } from '../security/auditoria.js';
import { excluirConta } from '../conta/exclusao.js';
import { config } from '../config.js';
import { ErroApp } from '../util/erros.js';

export async function rotasConta(app) {
  const { auth, db } = app.ctx;
  const gravarCookie = (reply, token, lembrar = true) => reply.setCookie(COOKIE, token, opcoesCookie(lembrar, config.cookieSeguro));
  const gravarAparelho = (reply, nome, t) => reply.setCookie(nome, t, { path: '/api/conta/entrar', httpOnly: true, sameSite: 'strict', secure: config.cookieSeguro, maxAge: 400 * 86400 });
  // "Manter conectado neste aparelho" vem marcado; só false explícito pede sessão curta.
  const lembrar = (req) => req.body?.lembrar !== false;
  app.post('/cadastrar', async (req, reply) => {
    const { usuarioId, token, codigoRecuperacao } = auth.cadastrar(req.body?.email, req.body?.senha, req.ip, { documento: req.body?.documento, nome: req.body?.nome, lembrar: lembrar(req) });
    auditar(db, { usuarioId, acao: 'conta.cadastro', ip: req.ip });
    gravarCookie(reply, token, lembrar(req));
    gravarAparelho(reply, auth.nomeCookieAparelho(usuarioId), auth.marcarAparelho(usuarioId));
    // Mostrado uma única vez: troca a senha sem depender de e-mail.
    return { ok: true, usuarioId, codigoRecuperacao };
  });
  app.post('/entrar', async (req, reply) => {
    // `usuario`: CPF, CNPJ ou e-mail (o campo `email` continua aceito).
    const { usuarioId, token, aparelho, nomeAparelho } = auth.entrar(req.body?.usuario ?? req.body?.email, req.body?.senha, req.ip, { lembrar: lembrar(req), cookieAparelho: (nome) => req.cookies?.[nome] });
    // Marca o aparelho onde o dono já entrou: ele fica fora do teto global de tentativas da conta.
    if (aparelho) gravarAparelho(reply, nomeAparelho, aparelho);
    auditar(db, { usuarioId, acao: 'conta.entrada', ip: req.ip });
    gravarCookie(reply, token, lembrar(req));
    return { ok: true, usuarioId };
  });
  app.post('/sair', async (req, reply) => {
    auth.sair(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  // Com várias empresas e nenhuma pedida (?empresa=), o app mostra a lista para escolher.
  app.get('/', async (req) => {
    const empresas = app.ctx.repo.contarPrestadores(req.usuario.id);
    const prestador = req.empresaPedida || empresas === 1 ? req.prestador : null;
    const t = auth.titular(req.usuario.id);
    return { usuarioId: req.usuario.id, prestadorId: prestador?.id ?? null, email: t.email, temPerfil: !!prestador, empresas, empresaNome: prestador?.nome ?? null,
      empresaDocumentoFormatado: prestador?.documento ? formatarDocumento(prestador.tipoDocumento, prestador.documento) : null, empresaAmbiente: prestador?.ambiente ?? null,
      nome: t.nome, documentoFormatado: t.documentoFormatado, documentoVerificado: t.documentoVerificado, govbr: t.govbr, temCodigoRecuperacao: t.temCodigoRecuperacao, govbrDisponivel: app.ctx.govbr.configurado };
  });
  app.delete('/', async (req, reply) => {
    auth.reautenticar(req.usuario.id, req.body?.senha, req.ip);
    const prestadores = db.all('SELECT id FROM prestadores WHERE usuario_id = ?', req.usuario.id);
    const r = excluirConta(db, req.usuario.id);
    for (const p of prestadores) app.ctx.emissao.fecharClientesDoPrestador(p.id);
    reply.clearCookie(COOKIE, { path: '/' });
    return r;
  });
  app.get('/recuperacao', async () => ({ modo: auth.modoRecuperacao }));
  app.post('/recuperar', async (req) => {
    await auth.recuperar(req.body?.usuario ?? req.body?.email, req.ip);
    return { ok: true, mensagem: auth.modoRecuperacao === 'terminal'
      ? 'Se a conta existir, o link para criar a nova senha apareceu na janela (terminal) onde o Nota Sem Stress está rodando. Copie e abra no navegador.'
      : 'Se a conta existir e tiver e-mail, enviamos o link para criar a nova senha. Confira também a caixa de spam.' };
  });
  // Código de recuperação: troca a senha sem e-mail. Devolve um código novo (o usado deixa de valer).
  app.post('/redefinir-codigo', async (req, reply) => {
    const { usuarioId, codigo } = auth.redefinirComCodigo(req.body?.usuario, req.body?.codigo, req.body?.senha, req.ip);
    auditar(db, { usuarioId, acao: 'conta.senha_redefinida_codigo', ip: req.ip });
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true, codigoRecuperacao: codigo };
  });
  // Gerar um código novo (o anterior deixa de valer): pede a senha atual.
  app.post('/codigo-recuperacao', async (req) => {
    auth.reautenticar(req.usuario.id, req.body?.senha, req.ip, 'Senha incorreta.');
    const codigo = auth.gerarCodigoRecuperacao(req.usuario.id);
    auditar(db, { usuarioId: req.usuario.id, acao: 'conta.codigo_recuperacao_gerado', ip: req.ip });
    return { codigoRecuperacao: codigo };
  });
  app.post('/redefinir', async (req, reply) => {
    const usuarioId = auth.redefinir(req.body?.token, req.body?.senha, req.ip);
    auditar(db, { usuarioId, acao: 'conta.senha_redefinida', ip: req.ip });
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });
  // ---------- gov.br ----------
  // O retorno vem de outro site: o cookie do fluxo precisa ser Lax (o da sessão é Strict).
  const COOKIE_GOVBR = 'nv_govbr';
  const gravarFluxo = (reply, token) => reply.setCookie(COOKIE_GOVBR, token, {
    httpOnly: true, secure: config.cookieSeguro, sameSite: 'lax', path: '/api/conta/govbr', maxAge: 600,
  });
  const voltar = (reply, destino) => reply.redirect(destino, 303);
  app.get('/govbr', async () => ({ disponivel: app.ctx.govbr.configurado }));
  app.get('/govbr/entrar', async (req, reply) => {
    if (!app.ctx.govbr.configurado) return voltar(reply, '/#/entrar?govbr=indisponivel');
    app.ctx.limites.consumir(`govbr:ip:${req.ip}`, 30, 15 * 60_000);
    const { token, url } = app.ctx.govbr.iniciar({ modo: 'entrar' });
    gravarFluxo(reply, token);
    return voltar(reply, url);
  });
  // Vincular exige a sessão (e o cabeçalho anti-CSRF): devolve o endereço para o app abrir.
  app.post('/govbr/vincular', async (req, reply) => {
    const { token, url } = app.ctx.govbr.iniciar({ modo: 'vincular', usuarioId: req.usuario.id });
    gravarFluxo(reply, token);
    return { url };
  });
  // Conta criada pelo gov.br não tem senha: a exclusão é confirmada entrando de novo no gov.br.
  app.post('/govbr/excluir', async (req, reply) => {
    if (!auth.titular(req.usuario.id)?.govbr) throw new ErroApp(409, 'Esta conta não está vinculada ao gov.br. Exclua informando a senha.');
    const { token, url } = app.ctx.govbr.iniciar({ modo: 'excluir', usuarioId: req.usuario.id });
    gravarFluxo(reply, token);
    return { url };
  });
  app.delete('/govbr', async (req) => {
    // Conta criada pelo gov.br sem e-mail não teria outra forma de entrar.
    if (!auth.titular(req.usuario.id)?.email) throw new ErroApp(409, 'Esta conta foi criada pelo gov.br e só entra por ele: o vínculo não pode ser removido.');
    auth.desvincularGovbr(req.usuario.id);
    auditar(db, { usuarioId: req.usuario.id, acao: 'conta.govbr_desvinculado', ip: req.ip });
    return { ok: true };
  });
  app.get('/govbr/retorno', async (req, reply) => {
    const q = req.query || {};
    reply.clearCookie(COOKIE_GOVBR, { path: '/api/conta/govbr' });
    if (q.error) return voltar(reply, '/#/entrar?govbr=cancelado');
    try {
      const r = await app.ctx.govbr.concluir({ token: req.cookies[COOKIE_GOVBR], state: q.state, code: q.code });
      if (r.modo === 'excluir') {
        if (!r.usuarioId || !auth.govbrConfere(r.usuarioId, r.cpf)) return voltar(reply, '/#/conta?govbr=outro');
        const prestadores = db.all('SELECT id FROM prestadores WHERE usuario_id = ?', r.usuarioId);
        try { excluirConta(db, r.usuarioId); } catch (e) {
          if (e.extra?.codigo === 'CONTA_COM_EMISSAO_PENDENTE') return voltar(reply, '/#/conta?govbr=pendente');
          throw e;
        }
        for (const p of prestadores) app.ctx.emissao.fecharClientesDoPrestador(p.id);
        reply.clearCookie(COOKIE, { path: '/' });
        return voltar(reply, `/#/entrar?govbr=excluida&u=${encodeURIComponent(r.usuarioId)}`);
      }
      if (r.modo === 'vincular') {
        auth.vincularGovbr(r.usuarioId, r);
        auditar(db, { usuarioId: r.usuarioId, acao: 'conta.govbr_vinculado', ip: req.ip });
        return voltar(reply, '/#/conta?govbr=vinculado');
      }
      const { usuarioId, token, novo } = auth.entrarGovbr(r);
      auditar(db, { usuarioId, acao: novo ? 'conta.cadastro_govbr' : 'conta.entrada_govbr', ip: req.ip });
      gravarCookie(reply, token);
      return voltar(reply, '/#/?govbr=entrou');
    } catch (e) {
      const codigo = { GOVBR_VINCULAR: 'vincular', GOVBR_EM_USO: 'em-uso', GOVBR_FLUXO: 'expirou' }[e.extra?.codigo] || 'erro';
      if (!e.extra?.codigo) req.log?.warn({ err: e.message }, 'falha no retorno do gov.br');
      return voltar(reply, `/#/entrar?govbr=${codigo}`);
    }
  });

  app.get('/transparencia', async () => {
    const { responsavel = '', contatoPrivacidade = '', retencao = '' } = app.ctx.contaPublica || {};
    return { responsavel, contatoPrivacidade, retencao, configurada: !!(responsavel && contatoPrivacidade && retencao) };
  });
}
