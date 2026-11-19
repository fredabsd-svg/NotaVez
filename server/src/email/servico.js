// Envio das notas ao cliente por e-mail: configuração SMTP da conta (cifrada), texto escrito pela IA da conta
// (ou modelo simples, sem IA), envio com o PDF (DANFSe) e o XML oficiais em anexo e histórico por nota.
import { agora } from '../db/banco.js';
import { cifrar, decifrarJson } from '../security/cripto.js';
import { ErroApp, invalido, naoEncontrado } from '../util/erros.js';
import { auditar } from '../security/auditoria.js';
import { config, ambientesSefin } from '../config.js';
import { enviarEmail, enderecoValido, ErroSmtp, PORTAS_SMTP } from '../security/smtp.js';
import { gerarDanfse, lerXmlNfse } from '../fiscal/danfse/index.js';
import { xmlOficial, marcaDaguaDanfse } from '../routes/notas.js';
import { fatosDaNota, emailsDoCliente, textoModelo, SISTEMA_EMAIL, pedidoRedacao, lerRedacao, faltasNoTexto } from './nota.js';

export const MAX_DESTINATARIOS = 10;
const SEGURANCAS = ['ssl', 'starttls'];
const nomeHost = (h) => /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h);
const umaLinha = (s, max) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const minusculo = (s) => String(s ?? '').trim().toLowerCase();

export function criarServicoEmail(appCtx, { enviar = enviarEmail, permitirRedeLocal = false } = {}) {
  const { db, repo } = appCtx;

  // ---------------------------------------------------------- configuração (por conta)
  async function configBruta(usuarioId) {
    const r = await db.get('SELECT dados_cifrados, atualizado_em FROM email_config WHERE usuario_id = ?', usuarioId);
    return r ? { ...decifrarJson(r.dados_cifrados), atualizadoEm: r.atualizado_em } : null;
  }

  async function configPublica(usuarioId) {
    const c = await configBruta(usuarioId);
    if (!c) return { configurado: false };
    return { configurado: true, host: c.host, porta: c.porta, seguranca: c.seguranca, usuario: c.usuario || '', temSenha: !!c.senha,
      remetenteEmail: c.remetenteEmail, remetenteNome: c.remetenteNome || '', responderPara: c.responderPara || '', copiaParaMim: c.copiaParaMim !== false, atualizadoEm: c.atualizadoEm };
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
    const dados = { host, porta, seguranca, usuario, senha, remetenteEmail, remetenteNome, responderPara, copiaParaMim: b.copiaParaMim !== false };
    await db.run(`INSERT INTO email_config (usuario_id, dados_cifrados, atualizado_em) VALUES (?,?,?)
      ON CONFLICT (usuario_id) DO UPDATE SET dados_cifrados = excluded.dados_cifrados, atualizado_em = excluded.atualizado_em`, usuarioId, cifrar(dados), agora());
    await auditar(db, { usuarioId, acao: 'email.config_salva', detalhes: { porta, seguranca }, ip });
    return await configPublica(usuarioId);
  }

  async function removerConfig(usuarioId, ip = null) {
    await db.run('DELETE FROM email_config WHERE usuario_id = ?', usuarioId);
    await auditar(db, { usuarioId, acao: 'email.config_removida', ip });
    return { configurado: false };
  }

  async function exigirConfig(usuarioId) {
    const c = await configBruta(usuarioId);
    if (!c) throw new ErroApp(409, 'Configure o e-mail de envio antes: Conta › E-mail para enviar notas.', { codigo: 'EMAIL_NAO_CONFIGURADO' });
    return c;
  }

  async function mandar(c, mensagem) {
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
    await mandar(c, { nomeRemetente: c.remetenteNome || 'Nota Sem Stress', para: [c.remetenteEmail], assunto: 'Teste de envio do Nota Sem Stress',
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
      remetente: cfg.configurado ? { email: cfg.remetenteEmail, nome: cfg.remetenteNome || f.empresa.nomeNatural } : null,
      anexos: [{ id: 'pdf', nome: nomes.pdf, descricao: ANEXOS.pdf }, { id: 'xml', nome: nomes.xml, descricao: ANEXOS.xml }],
      resumo: { numero: f.nota.numero, competencia: f.nota.competencia, valor: f.nota.valorServico, retencao: f.retencao, teste: f.teste },
      envios: await repo.enviosEmail(p.id, n.id),
    };
  }

  // Assunto e mensagem: escritos pela IA da conta; sem IA (ou se ela falhar), pelo modelo simples.
  async function texto(usuarioId, p, notaId, { instrucao = '', anterior = null, anexos = ['pdf', 'xml'] } = {}) {
    const { n, xml, consultaPublica } = await notaEmitida(p, notaId);
    const lista = ['pdf', 'xml'].filter((a) => (Array.isArray(anexos) ? anexos : ['pdf', 'xml']).includes(a));
    const f = fatos(p, n, xml, consultaPublica, lista);
    const modelo = textoModelo(f);
    let resultado = { ...modelo, origem: 'modelo' };
    if ((await appCtx.ia.configPublica(usuarioId)).configurado) {
      try {
        const hoje = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'full', timeStyle: 'short' });
        const r = await appCtx.ia.gerarTexto(usuarioId, { sistema: SISTEMA_EMAIL, contexto: `Agora (Brasília): ${hoje}.`,
          texto: pedidoRedacao(f, { instrucao: umaLinha(instrucao, 500), anterior: anterior && typeof anterior === 'object' ? { corpo: String(anterior.corpo || '') } : null }) });
        const lido = lerRedacao(r.texto);
        resultado = lido ? { ...lido, origem: 'ia', modelo: r.modelo, provedorNome: r.provedorNome }
          : { ...modelo, origem: 'modelo', aviso: 'A IA respondeu fora do formato esperado; usei o modelo padrão. Você pode editar ou pedir de novo.' };
      } catch (e) {
        resultado = { ...modelo, origem: 'modelo', aviso: `A IA não conseguiu escrever agora (${e instanceof ErroApp ? e.message : 'falha no provedor'}). Usei o modelo padrão; você pode editar.` };
      }
    }
    await auditar(db, { usuarioId, prestadorId: p.id, acao: 'nota.email_redigido', entidade: 'nota', entidadeId: n.id, detalhes: { origem: resultado.origem } });
    return { ...resultado, faltas: faltasNoTexto(f, resultado.corpo) };
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
    await mandar(c, { nomeRemetente: c.remetenteNome || f.empresa.nomeNatural, para, cco: copia, assunto, texto: corpo, anexos: arquivos });
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

  return { configPublica, salvarConfig, removerConfig, testar, preparar, texto, enviarNota };
}

// E-mail do tomador que veio na própria NFS-e (quando a nota foi emitida fora do app ou sem cliente salvo).
function xmlEmailTomador(xml) {
  try { return lerXmlNfse(xml).DPS?.infDPS?.toma?.email || null; } catch { return null; }
}
