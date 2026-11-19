// Envio das notas ao cliente por e-mail: configuração da conta (cifrada) — conta Google ou Microsoft conectada
// (OAuth, sem senha guardada) ou servidor SMTP com usuário e senha —, texto escrito pela IA da conta (ou modelo
// simples, sem IA), envio com o PDF (DANFSe) e o XML oficiais em anexo e histórico por nota.
import { agora } from '../db/banco.js';
import { cifrar, decifrarJson } from '../security/cripto.js';
import { ErroApp, invalido, naoEncontrado } from '../util/erros.js';
import { auditar } from '../security/auditoria.js';
import { config, ambientesSefin } from '../config.js';
import { enviarEmail, enderecoValido, ErroSmtp, PORTAS_SMTP } from '../security/smtp.js';
import { gerarDanfse, lerXmlNfse } from '../fiscal/danfse/index.js';
import { xmlOficial, marcaDaguaDanfse } from '../routes/notas.js';
import { fatosDaNota, emailsDoCliente, MODELO_PADRAO, CAMPOS_MODELO, camposDesconhecidos, valoresDoModelo, preencherModelo,
  SISTEMA_SERVICOS, pedidoServicos, lerServicos, SISTEMA_AJUSTE, pedidoAjuste, lerRedacao, faltasNoTexto } from './nota.js';
import { PROVEDORES_OAUTH } from './oauth.js';

export const MAX_DESTINATARIOS = 10;
const SEGURANCAS = ['ssl', 'starttls'];
const nomeHost = (h) => /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h);
const umaLinha = (s, max) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const minusculo = (s) => String(s ?? '').trim().toLowerCase();

export function criarServicoEmail(appCtx, { enviar = enviarEmail, permitirRedeLocal = false, oauth = null } = {}) {
  const { db, repo } = appCtx;
  const ehOAuth = (c) => !!PROVEDORES_OAUTH[c?.tipo];

  // ---------------------------------------------------------- configuração (por conta)
  async function configBruta(usuarioId) {
    const r = await db.get('SELECT dados_cifrados, atualizado_em FROM email_config WHERE usuario_id = ?', usuarioId);
    return r ? { tipo: 'smtp', ...decifrarJson(r.dados_cifrados), atualizadoEm: r.atualizado_em } : null;
  }
  const gravar = async (usuarioId, dados) => db.run(`INSERT INTO email_config (usuario_id, dados_cifrados, atualizado_em) VALUES (?,?,?)
    ON CONFLICT (usuario_id) DO UPDATE SET dados_cifrados = excluded.dados_cifrados, atualizado_em = excluded.atualizado_em`, usuarioId, cifrar(dados), agora());
  const semDataDeAtualizacao = ({ atualizadoEm, ...c }) => c;

  // Modelo do texto da conta (vazio = o padrão).
  const modeloDe = (c) => ({ modeloAssunto: c?.modeloAssunto || MODELO_PADRAO.assunto, modeloCorpo: c?.modeloCorpo || MODELO_PADRAO.corpo,
    modeloProprio: !!(c?.modeloAssunto || c?.modeloCorpo) });
  const guardarModelo = (c) => ({ modeloAssunto: c?.modeloAssunto || '', modeloCorpo: c?.modeloCorpo || '' });

  async function configPublica(usuarioId) {
    const c = await configBruta(usuarioId);
    if (!c) return { configurado: false };
    const comum = { configurado: true, tipo: c.tipo, remetenteEmail: c.remetenteEmail, remetenteNome: c.remetenteNome || '', responderPara: c.responderPara || '',
      copiaParaMim: c.copiaParaMim !== false, atualizadoEm: c.atualizadoEm, ...modeloDe(c) };
    if (ehOAuth(c)) return { ...comum, provedorNome: PROVEDORES_OAUTH[c.tipo].nome, conta: c.conta, nomeConta: c.nomeConta || '', conectadoEm: c.conectadoEm || null };
    return { ...comum, host: c.host, porta: c.porta, seguranca: c.seguranca, usuario: c.usuario || '', temSenha: !!c.senha };
  }

  async function salvarConfig(usuarioId, b = {}, ip = null) {
    const atual = await configBruta(usuarioId);
    const erros = {};
    const host = minusculo(b.host);
    if (!nomeHost(host) && !(permitirRedeLocal && /^(localhost|[\d.]+)$/.test(host))) erros.host = 'Informe o servidor de saída (ex.: smtp.gmail.com).';
    const porta = Number(b.porta);
    if (!Number.isInteger(porta) || (!PORTAS_SMTP.includes(porta) && !(permitirRedeLocal && porta > 0 && porta < 65536))) erros.porta = `Use a porta ${PORTAS_SMTP.join(', ')}.`;
    const seguranca = SEGURANCAS.includes(b.seguranca) ? b.seguranca : null;
    if (!seguranca) erros.seguranca = 'Escolha SSL/TLS ou STARTTLS.';
    const usuario = String(b.usuario ?? '').trim().slice(0, 200);
    // Senha em branco ao editar: mantém a guardada (a tela nunca recebe a senha de volta).
    const senha = typeof b.senha === 'string' && b.senha !== '' ? b.senha.slice(0, 300) : (atual?.senha || '');
    if (usuario && !senha) erros.senha = 'Informe a senha (no Gmail e no Outlook, a "senha de app").';
    const remetenteEmail = minusculo(b.remetenteEmail);
    if (!enderecoValido(remetenteEmail)) erros.remetenteEmail = 'Informe o e-mail que aparece como remetente.';
    const remetenteNome = umaLinha(b.remetenteNome, 80);
    const responderPara = minusculo(b.responderPara);
    if (responderPara && !enderecoValido(responderPara)) erros.responderPara = 'E-mail inválido.';
    if (Object.keys(erros).length) throw invalido('Confira a configuração de e-mail.', erros);
    const dados = { tipo: 'smtp', host, porta, seguranca, usuario, senha, remetenteEmail, remetenteNome, responderPara, copiaParaMim: b.copiaParaMim !== false, ...guardarModelo(atual) };
    await gravar(usuarioId, dados);
    // Trocou a conta Google conectada por usuário e senha: desfaz a autorização antiga.
    if (ehOAuth(atual)) await oauth?.revogar(atual);
    await auditar(db, { usuarioId, acao: 'email.config_salva', detalhes: { tipo: 'smtp', porta, seguranca }, ip });
    return await configPublica(usuarioId);
  }

  // Conta Google ou Microsoft conectada (retorno do OAuth): guarda o refresh token cifrado e mantém as preferências.
  async function conectarOAuth(usuarioId, { provedor, conta, nome, refreshToken }, ip = null) {
    const atual = await configBruta(usuarioId);
    await gravar(usuarioId, { tipo: provedor, conta, nomeConta: nome || '', refreshToken, remetenteEmail: conta, conectadoEm: agora(),
      remetenteNome: atual?.remetenteNome || '', responderPara: atual?.responderPara || '', copiaParaMim: atual ? atual.copiaParaMim !== false : true, ...guardarModelo(atual) });
    if (ehOAuth(atual) && atual.refreshToken !== refreshToken) await oauth?.revogar(atual);
    await auditar(db, { usuarioId, acao: 'email.conta_conectada', detalhes: { provedor }, ip });
    return await configPublica(usuarioId);
  }

  // Nome do remetente, "responder para" e cópia: valem para qualquer forma de envio.
  async function salvarPreferencias(usuarioId, b = {}, ip = null) {
    const atual = await exigirConfig(usuarioId);
    const responderPara = minusculo(b.responderPara);
    if (responderPara && !enderecoValido(responderPara)) throw invalido('Confira a configuração de e-mail.', { responderPara: 'E-mail inválido.' });
    await gravar(usuarioId, { ...semDataDeAtualizacao(atual), remetenteNome: umaLinha(b.remetenteNome, 80), responderPara, copiaParaMim: b.copiaParaMim !== false });
    await auditar(db, { usuarioId, acao: 'email.preferencias_salvas', ip });
    return await configPublica(usuarioId);
  }

  // Modelo do e-mail: assunto e mensagem com campos entre chaves. Igual ao padrão (ou padrao: true) = volta ao padrão.
  async function salvarModelo(usuarioId, b = {}, ip = null) {
    const atual = await exigirConfig(usuarioId);
    let assunto = b.padrao === true ? '' : umaLinha(b.assunto, 200);
    let corpo = b.padrao === true ? '' : String(b.corpo ?? '').replace(/\r\n/g, '\n').trim().slice(0, 4000);
    const erros = {};
    if (b.padrao !== true) {
      if (!assunto) erros.assunto = 'Escreva o assunto do modelo.';
      if (!corpo) erros.corpo = 'Escreva a mensagem do modelo.';
      for (const [campo, texto] of [['assunto', assunto], ['corpo', corpo]]) {
        const ruins = camposDesconhecidos(texto);
        if (ruins.length) erros[campo] = `Campo desconhecido: ${ruins.map((c) => `{${c}}`).join(', ')}. Use: ${Object.keys(CAMPOS_MODELO).map((c) => `{${c}}`).join(', ')}.`;
      }
      if (Object.keys(erros).length) throw invalido('Confira o modelo do e-mail.', erros);
      if (assunto === MODELO_PADRAO.assunto) assunto = '';
      if (corpo === MODELO_PADRAO.corpo) corpo = '';
    }
    await gravar(usuarioId, { ...semDataDeAtualizacao(atual), modeloAssunto: assunto, modeloCorpo: corpo });
    await auditar(db, { usuarioId, acao: 'email.modelo_salvo', detalhes: { padrao: !assunto && !corpo }, ip });
    return await configPublica(usuarioId);
  }

  async function removerConfig(usuarioId, ip = null) {
    const atual = await configBruta(usuarioId);
    await db.run('DELETE FROM email_config WHERE usuario_id = ?', usuarioId);
    if (ehOAuth(atual)) await oauth?.revogar(atual);
    await auditar(db, { usuarioId, acao: 'email.config_removida', ip });
    return { configurado: false };
  }

  async function exigirConfig(usuarioId) {
    const c = await configBruta(usuarioId);
    if (!c) throw new ErroApp(409, 'Configure o e-mail de envio antes: Conta › E-mail para enviar notas.', { codigo: 'EMAIL_NAO_CONFIGURADO' });
    return c;
  }

  async function mandar(usuarioId, c, mensagem) {
    if (ehOAuth(c)) {
      if (!oauth) throw new ErroApp(409, 'O envio pela conta conectada não está disponível neste servidor.', { codigo: 'EMAIL_OAUTH_INDISPONIVEL' });
      // A Microsoft troca o refresh token a cada renovação: o novo é guardado na hora (o antigo deixa de valer),
      // mesmo que o envio em seguida falhe.
      return await oauth.enviar(c, { responderPara: c.responderPara || '', ...mensagem },
        { aoRenovar: (refreshToken) => gravar(usuarioId, { ...semDataDeAtualizacao(c), refreshToken }) });
    }
    try {
      return await enviar({ host: c.host, porta: c.porta, seguranca: c.seguranca, usuario: c.usuario, senha: c.senha, de: c.remetenteEmail,
        responderPara: c.responderPara || '', permitirRedeLocal, ...mensagem });
    } catch (e) {
      if (e instanceof ErroSmtp) throw new ErroApp(502, e.message, { codigo: 'EMAIL_RECUSADO', etapa: e.etapa });
      throw new ErroApp(502, 'Não foi possível enviar o e-mail agora. Tente de novo em instantes.', { codigo: 'EMAIL_FALHOU' });
    }
  }

  // E-mail de teste para o próprio remetente (confere servidor, porta, segurança, usuário e senha).
  async function testar(usuarioId, ip = null) {
    const c = await exigirConfig(usuarioId);
    await mandar(usuarioId, c, { nomeRemetente: c.remetenteNome || 'Nota Sem Stress', para: [c.remetenteEmail], assunto: 'Teste de envio do Nota Sem Stress',
      texto: 'Tudo certo! Este é um e-mail de teste do Nota Sem Stress.\n\nSe ele chegou, o aplicativo já consegue enviar as notas fiscais aos seus clientes por este endereço.\n' });
    await auditar(db, { usuarioId, acao: 'email.testado', ip });
    return { ok: true, para: c.remetenteEmail };
  }

  // ---------------------------------------------------------- nota → e-mail
  async function notaEmitida(p, notaId) {
    const n = await repo.nota(p.id, notaId);
    if (!n) throw naoEncontrado('Nota');
    if (n.situacao === 'cancelada') throw new ErroApp(409, 'Esta NFS-e foi cancelada: ela não vale como nota fiscal e não deve ser enviada ao cliente.');
    if (n.situacao !== 'emitida') throw new ErroApp(409, 'Só dá para enviar por e-mail uma nota já emitida.');
    const { nota, xml } = await xmlOficial(appCtx, p, n);
    const amb = ambientesSefin[nota.ambiente || p.ambiente];
    return { n: nota, xml, consultaPublica: nota.chaveAcesso && amb?.consultaPublica ? `${amb.consultaPublica}${nota.chaveAcesso}` : null };
  }

  const ANEXOS = { pdf: 'PDF (DANFSe)', xml: 'XML da NFS-e' };
  const nomesAnexos = (n) => ({ pdf: `DANFSe-${n.chaveAcesso}.pdf`, xml: `${n.canal === 'emissor_nacional' && !n.importadaConferida ? 'NAO-CONFERIDA-' : ''}NFSe-${n.chaveAcesso}.xml` });

  function fatos(p, n, xml, consultaPublica, anexos = ['pdf', 'xml']) {
    return fatosDaNota(xml, { prestador: p, consultaPublica, homologacao: (n.ambiente || p.ambiente) === 'producao_restrita', simulacao: config.demo, anexos: anexos.map((a) => ANEXOS[a]) });
  }

  // Tudo o que a tela precisa para montar o e-mail (rápido: sem IA). O texto vem em seguida, de texto().
  async function preparar(usuarioId, p, notaId) {
    const { n, xml, consultaPublica } = await notaEmitida(p, notaId);
    const f = fatos(p, n, xml, consultaPublica);
    const r = n.rascunho || {};
    const cliente = r.clienteId ? await repo.cliente(p.id, r.clienteId) : null;
    const cfg = await configPublica(usuarioId);
    const nomes = nomesAnexos(n);
    return {
      para: emailsDoCliente(cliente?.email, r.tomador?.email, xmlEmailTomador(xml)),
      clienteNome: f.cliente.nome, clienteId: cliente?.id || null, clienteSemEmail: !!cliente && !cliente.email,
      config: cfg, iaConfigurada: !!(await appCtx.ia.configPublica(usuarioId)).configurado,
      // Pelo Microsoft Graph, o nome que aparece é o da própria conta Microsoft.
      remetente: cfg.configurado ? { email: cfg.remetenteEmail, nome: cfg.tipo === 'microsoft' ? (cfg.nomeConta || cfg.remetenteEmail) : (cfg.remetenteNome || f.empresa.nomeNatural), via: cfg.provedorNome || null } : null,
      anexos: [{ id: 'pdf', nome: nomes.pdf, descricao: ANEXOS.pdf }, { id: 'xml', nome: nomes.xml, descricao: ANEXOS.xml }],
      resumo: { numero: f.nota.numero, competencia: f.nota.competencia, valor: f.nota.valorServico, retencao: f.retencao, teste: f.teste },
      envios: await repo.enviosEmail(p.id, n.id),
    };
  }

  // Assunto e mensagem: o modelo da conta preenchido com os dados do XML oficial. A IA da conta (se houver) só escreve
  // o tipo do serviço ({servicos}) e, quando a pessoa pede, ajusta o texto atual (ex.: "mencione o boleto").
  async function texto(usuarioId, p, notaId, { instrucao = '', atual = null, anexos = ['pdf', 'xml'] } = {}) {
    const { n, xml, consultaPublica } = await notaEmitida(p, notaId);
    const lista = ['pdf', 'xml'].filter((a) => (Array.isArray(anexos) ? anexos : ['pdf', 'xml']).includes(a));
    const f = fatos(p, n, xml, consultaPublica, lista);
    const modelo = modeloDe(await configBruta(usuarioId));
    const iaCfg = await appCtx.ia.configPublica(usuarioId);
    const pedido = umaLinha(instrucao, 500);
    const atualValido = atual && typeof atual === 'object' && String(atual.corpo || '').trim() ? { assunto: String(atual.assunto || ''), corpo: String(atual.corpo) } : null;
    const avisos = [];
    let ia = null;

    let servicos = 'serviços';
    const precisaServicos = /\{servicos\}/.test(modelo.modeloAssunto + modelo.modeloCorpo) && !(pedido && atualValido);
    if (precisaServicos && iaCfg.configurado) {
      try {
        const r = await appCtx.ia.gerarTexto(usuarioId, { sistema: SISTEMA_SERVICOS, texto: pedidoServicos(f) });
        const lido = lerServicos(r.texto);
        if (lido) { servicos = lido; ia = r; }
      } catch { /* sem a IA, fica "serviços" */ }
    }
    let resultado = { ...preencherModelo({ assunto: modelo.modeloAssunto, corpo: modelo.modeloCorpo }, valoresDoModelo(f, { servicos, anexos: lista }), { teste: f.teste }),
      origem: 'modelo', modeloProprio: modelo.modeloProprio, servicos: ia ? servicos : null };

    if (pedido) {
      if (!iaCfg.configurado) avisos.push('Para ajustar o texto com um pedido, configure o assistente de IA (Assistente › Configurar). Você também pode editar o texto à mão.');
      else {
        try {
          const r = await appCtx.ia.gerarTexto(usuarioId, { sistema: SISTEMA_AJUSTE, texto: pedidoAjuste(f, atualValido || resultado, pedido) });
          const lido = lerRedacao(r.texto);
          if (lido) { resultado = { ...resultado, ...lido, origem: 'ia' }; ia = r; } else avisos.push('A IA respondeu fora do formato esperado; o texto ficou como estava. Tente pedir de outro jeito.');
        } catch (e) {
          avisos.push(`A IA não conseguiu ajustar agora (${e instanceof ErroApp ? e.message : 'falha no provedor'}). O texto ficou como estava.`);
        }
        if (resultado.origem !== 'ia' && atualValido) resultado = { ...resultado, ...atualValido };
      }
    }
    await auditar(db, { usuarioId, prestadorId: p.id, acao: 'nota.email_redigido', entidade: 'nota', entidadeId: n.id, detalhes: { origem: resultado.origem, ajuste: !!pedido } });
    return { ...resultado, ...(ia ? { modelo: ia.modelo, provedorNome: ia.provedorNome } : {}), ...(avisos.length ? { aviso: avisos.join(' ') } : {}), faltas: faltasNoTexto(f, resultado.corpo) };
  }

  async function enviarNota(usuarioId, p, notaId, b = {}, ip = null) {
    const c = await exigirConfig(usuarioId);
    const erros = {};
    const lista = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,;]+/) : []).map(minusculo).filter(Boolean);
    const para = [...new Set(lista(b.para))];
    if (!para.length) erros.para = 'Informe o e-mail do cliente.';
    else if (!para.every(enderecoValido)) erros.para = `E-mail inválido: ${para.filter((e) => !enderecoValido(e)).join(', ')}`;
    const copia = b.copiaParaMim === true ? [c.remetenteEmail].filter((e) => !para.includes(e)) : [];
    if (para.length + copia.length > MAX_DESTINATARIOS) erros.para = `No máximo ${MAX_DESTINATARIOS} destinatários por envio.`;
    const assunto = umaLinha(b.assunto, 200);
    if (!assunto) erros.assunto = 'Escreva o assunto.';
    const corpo = String(b.corpo ?? '').replace(/\r\n/g, '\n').trim().slice(0, 10_000);
    if (!corpo) erros.corpo = 'Escreva a mensagem.';
    const anexos = ['pdf', 'xml'].filter((a) => (Array.isArray(b.anexos) ? b.anexos : ['pdf', 'xml']).includes(a));
    if (Object.keys(erros).length) throw invalido('Confira o e-mail antes de enviar.', erros);

    const { n, xml, consultaPublica } = await notaEmitida(p, notaId);
    const nomes = nomesAnexos(n);
    const arquivos = [];
    if (anexos.includes('pdf')) arquivos.push({ nome: nomes.pdf, tipo: 'application/pdf', conteudo: await gerarDanfse(xml, { marcaDagua: marcaDaguaDanfse(n) }) });
    if (anexos.includes('xml')) arquivos.push({ nome: nomes.xml, tipo: 'application/xml', conteudo: Buffer.from(xml, 'utf8') });
    const f = fatos(p, n, xml, consultaPublica, anexos);
    await mandar(usuarioId, c, { nomeRemetente: c.remetenteNome || f.empresa.nomeNatural, para, cco: copia, assunto, texto: corpo, anexos: arquivos });
    const envio = await repo.registrarEnvioEmail(p.id, n.id, { para, cco: copia, assunto, anexos });
    // Cliente sem e-mail no cadastro: guarda o primeiro destinatário (se a pessoa pediu), para os próximos envios.
    let clienteAtualizado = false;
    const cliente = b.salvarNoCliente === true && n.rascunho?.clienteId ? await repo.cliente(p.id, n.rascunho.clienteId) : null;
    if (cliente && !cliente.email && para[0].length <= 80) {
      const { id, atualizadoEm, usadoEm, ...dados } = cliente;
      await repo.salvarCliente(p.id, id, { ...dados, email: para[0] });
      await auditar(db, { usuarioId, prestadorId: p.id, acao: 'cliente.editado', entidade: 'cliente', entidadeId: id, detalhes: { campo: 'email', via: 'envio_nota' }, ip });
      clienteAtualizado = true;
    }
    // Auditoria sem dados pessoais: só quantidades e anexos.
    await auditar(db, { usuarioId, prestadorId: p.id, acao: 'nota.email_enviado', entidade: 'nota', entidadeId: n.id, detalhes: { destinatarios: para.length, copia: copia.length, anexos }, ip });
    return { ok: true, enviadoEm: envio.enviadoEm, para, copia, clienteAtualizado, envios: await repo.enviosEmail(p.id, n.id) };
  }

  return { configPublica, salvarConfig, conectarOAuth, salvarPreferencias, salvarModelo, removerConfig, testar, preparar, texto, enviarNota, camposModelo: CAMPOS_MODELO, modeloPadrao: MODELO_PADRAO };
}

// E-mail do tomador que veio na própria NFS-e (quando a nota foi emitida fora do app ou sem cliente salvo).
function xmlEmailTomador(xml) {
  try { return lerXmlNfse(xml).DPS?.infDPS?.toma?.email || null; } catch { return null; }
}
