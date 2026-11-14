// Conversas com o assistente: configuração do provedor, laço modelo ↔ ferramentas, persistência
// cifrada e a confirmação de emissão pelo usuário.
import { agora, novoId } from '../db/banco.js';
import { cifrar, decifrar, decifrarJson } from '../security/cripto.js';
import { ErroApp, invalido, naoEncontrado } from '../util/erros.js';
import { auditar } from '../security/auditoria.js';
import { config } from '../config.js';
import { PROVEDORES, validarBaseUrl } from './provedores.js';
import { chamarModelo } from './adaptadores.js';
import { DEFINICOES, criarFerramentas, emitirConfirmada } from './ferramentas.js';
import { SISTEMA_FIXO, montarContexto } from './prompt.js';
import { resumoNota } from '../routes/notas.js';

const MAX_ETAPAS = 16;               // chamadas ao modelo por mensagem do usuário
const MAX_RESULTADO = 24_000;        // caracteres de cada resultado de ferramenta
const MAX_HISTORICO_ENVIADO = 160;   // entradas do histórico mandadas ao modelo
const MAX_HISTORICO_GUARDADO = 400;
const ESFORCOS = ['low', 'medium', 'high', 'xhigh', 'max'];

const ROTULOS_FERRAMENTA = {
  listar_empresas: 'Consultou as empresas da conta', contexto_empresa: 'Leu os parâmetros fiscais da empresa', buscar_clientes: 'Procurou clientes',
  ver_cliente: 'Abriu o cadastro do cliente', consultar_cnpj: 'Consultou o CNPJ na base pública', cadastrar_cliente: 'Cadastrou um cliente',
  listar_servicos: 'Consultou os serviços salvos', cadastrar_servico: 'Salvou um serviço', buscar_codigo_servico: 'Pesquisou o código de serviço',
  detalhar_codigo_servico: 'Conferiu o código de serviço e o IBS/CBS', buscar_municipio: 'Procurou o município', listar_notas: 'Consultou as notas',
  ver_nota: 'Abriu a nota', criar_rascunho: 'Criou um rascunho', alterar_rascunho: 'Ajustou o rascunho', validar_nota: 'Validou com as regras oficiais',
  emitir_nota: 'Emissão da NFS-e', verificar_nota: 'Verificou a situação na Receita', clonar_nota: 'Clonou uma nota', descartar_rascunho: 'Descartou um rascunho',
  resumo_faturamento: 'Calculou o faturamento', listar_notas_tomadas: 'Consultou as notas tomadas', sincronizar_receita: 'Buscou notas na Receita',
};

export function criarServicoIa(appCtx, { chamar = chamarModelo, log = null } = {}) {
  const { db, repo } = appCtx;
  const ocupadas = new Set();

  // ---------------------------------------------------------- configuração
  function configBruta(usuarioId) {
    const r = db.get('SELECT * FROM ia_config WHERE usuario_id = ?', usuarioId);
    if (r) return { origem: 'conta', provedor: r.provedor, modelo: r.modelo, chave: decifrar(r.chave_cifrada), baseUrl: r.base_url || '', esforco: r.esforco || '', emissaoAutonoma: !!r.emissao_autonoma };
    if (config.ia.chave && PROVEDORES[config.ia.provedor]) {
      return { origem: 'servidor', provedor: config.ia.provedor, modelo: config.ia.modelo || PROVEDORES[config.ia.provedor].modeloPadrao, chave: config.ia.chave, baseUrl: config.ia.baseUrl, esforco: '', emissaoAutonoma: false };
    }
    return null;
  }

  function configPublica(usuarioId) {
    const c = configBruta(usuarioId);
    if (!c) return { configurado: false };
    return { configurado: !!c.chave, origem: c.origem, provedor: c.provedor, provedorNome: PROVEDORES[c.provedor]?.nome || c.provedor, modelo: c.modelo,
      baseUrl: c.origem === 'conta' ? c.baseUrl : '', esforco: c.esforco || '', emissaoAutonoma: c.emissaoAutonoma,
      chaveFinal: c.origem === 'conta' && c.chave ? `••••${c.chave.slice(-4)}` : null };
  }

  function salvarConfig(usuarioId, b = {}, ip = null) {
    const erros = {};
    const provedor = String(b.provedor || '');
    const def = PROVEDORES[provedor];
    if (!def) erros.provedor = 'Escolha um provedor.';
    const modelo = String(b.modelo || '').trim().slice(0, 120);
    if (!/^[\w.:/@-]{2,120}$/.test(modelo)) erros.modelo = 'Informe o nome do modelo (ex.: claude-opus-5-5).';
    let baseUrl = '';
    if (String(b.baseUrl || '').trim()) {
      baseUrl = validarBaseUrl(b.baseUrl, { permitirLocal: config.dev || config.demo });
      if (!baseUrl) erros.baseUrl = 'Endereço inválido: use https:// e um servidor público.';
    } else if (def?.exigeBaseUrl) erros.baseUrl = 'Informe o endereço da API do provedor.';
    const esforco = ESFORCOS.includes(b.esforco) ? b.esforco : '';
    const atual = db.get('SELECT * FROM ia_config WHERE usuario_id = ?', usuarioId);
    const chaveNova = String(b.chave || '').trim();
    if (chaveNova && (chaveNova.length < 8 || chaveNova.length > 400 || /\s/.test(chaveNova))) erros.chave = 'Chave de API em formato inválido.';
    // A chave guardada só serve para o mesmo provedor (e o mesmo endereço): trocou, precisa de outra.
    const manterChave = !chaveNova && atual?.chave_cifrada && atual.provedor === provedor && (atual.base_url || '') === baseUrl;
    if (!chaveNova && !manterChave) erros.chave = 'Informe a chave de API do provedor.';
    if (Object.keys(erros).length) throw invalido('Confira a configuração do assistente.', erros);
    const chaveCifrada = manterChave ? atual.chave_cifrada : cifrar(chaveNova);
    db.run(`INSERT INTO ia_config (usuario_id, provedor, modelo, chave_cifrada, base_url, esforco, emissao_autonoma, atualizado_em) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(usuario_id) DO UPDATE SET provedor = excluded.provedor, modelo = excluded.modelo, chave_cifrada = excluded.chave_cifrada, base_url = excluded.base_url,
      esforco = excluded.esforco, emissao_autonoma = excluded.emissao_autonoma, atualizado_em = excluded.atualizado_em`,
    usuarioId, provedor, modelo, chaveCifrada, baseUrl || null, esforco || null, b.emissaoAutonoma === true ? 1 : 0, agora());
    auditar(db, { usuarioId, acao: 'ia.configurada', detalhes: { provedor, modelo, emissaoAutonoma: b.emissaoAutonoma === true, chaveNova: !!chaveNova }, ip });
    return configPublica(usuarioId);
  }

  function removerConfig(usuarioId, ip = null) {
    db.run('DELETE FROM ia_config WHERE usuario_id = ?', usuarioId);
    auditar(db, { usuarioId, acao: 'ia.config_removida', ip });
  }

  function exigirConfig(usuarioId) {
    const c = configBruta(usuarioId);
    if (!c?.chave) throw new ErroApp(409, 'Configure o assistente de IA: escolha o provedor e informe a chave de API.', { codigo: 'IA_NAO_CONFIGURADA' });
    return c;
  }

  async function testarConfig(usuarioId) {
    const c = exigirConfig(usuarioId);
    const r = await chamar({ ...c, sistemaFixo: 'Você testa a conexão de um aplicativo.', sistemaVariavel: 'Responda apenas: ok', historico: [{ papel: 'usuario', texto: 'Teste de conexão. Responda apenas "ok".' }], ferramentas: [], esforco: '' });
    return { ok: true, resposta: r.texto.slice(0, 200), modelo: r.modeloUsado };
  }

  // ---------------------------------------------------------- conversas
  function conversaBruta(usuarioId, id) {
    const r = db.get('SELECT * FROM ia_conversas WHERE usuario_id = ? AND id = ?', usuarioId, String(id || ''));
    if (!r) return null;
    return { id: r.id, prestadorId: r.prestador_id, titulo: decifrar(r.titulo_cifrado) || 'Nova conversa', historico: decifrarJson(r.mensagens_cifradas) || [],
      pendentes: decifrarJson(r.pendentes_cifrados) || [], versao: r.versao, criadoEm: r.criado_em, atualizadoEm: r.atualizado_em };
  }

  function guardar(usuarioId, c) {
    const historico = c.historico.length > MAX_HISTORICO_GUARDADO ? recortar(c.historico, MAX_HISTORICO_GUARDADO) : c.historico;
    db.run('UPDATE ia_conversas SET titulo_cifrado = ?, mensagens_cifradas = ?, pendentes_cifrados = ?, prestador_id = ?, versao = versao + 1, atualizado_em = ? WHERE usuario_id = ? AND id = ?',
      cifrar(c.titulo), cifrar(historico), cifrar(c.pendentes), c.prestadorId || null, agora(), usuarioId, c.id);
  }

  function criarConversa(usuarioId, prestadorId) {
    const id = novoId();
    db.run('INSERT INTO ia_conversas (id, usuario_id, prestador_id, titulo_cifrado, mensagens_cifradas, pendentes_cifrados, criado_em, atualizado_em) VALUES (?,?,?,?,?,?,?,?)',
      id, usuarioId, prestadorId || null, cifrar('Nova conversa'), cifrar([]), cifrar([]), agora(), agora());
    // Guarda só as 50 conversas mais recentes da conta.
    db.run(`DELETE FROM ia_conversas WHERE usuario_id = ? AND id NOT IN (SELECT id FROM ia_conversas WHERE usuario_id = ? ORDER BY atualizado_em DESC LIMIT 50)`, usuarioId, usuarioId);
    return id;
  }

  const listarConversas = (usuarioId) => db.all('SELECT id, prestador_id, titulo_cifrado, atualizado_em FROM ia_conversas WHERE usuario_id = ? ORDER BY atualizado_em DESC LIMIT 50', usuarioId)
    .map((r) => ({ id: r.id, titulo: decifrar(r.titulo_cifrado) || 'Nova conversa', empresaId: r.prestador_id, atualizadoEm: r.atualizado_em }));

  function removerConversa(usuarioId, id) {
    return db.run('DELETE FROM ia_conversas WHERE usuario_id = ? AND id = ?', usuarioId, String(id || '')).changes === 1;
  }

  // ---------------------------------------------------------- visão para a tela
  function notaParaTela(usuarioId, empresaId, notaId) {
    const p = repo.prestadorDoUsuarioPorId(usuarioId, empresaId);
    const n = p && repo.nota(p.id, notaId);
    if (!n) return null;
    const r = resumoNota(repo, p, n, true);
    return { id: r.id, empresaId: p.id, empresaNome: p.nome, situacao: r.situacao, rotulo: r.rotulo, valor: r.valor, competencia: r.competencia,
      cliente: r.tomadorExibicao ? `${r.tomadorExibicao.nome} (${r.tomadorExibicao.documentoExibicao})` : 'Sem tomador identificado',
      servico: r.servicoNacional ? `${r.servicoNacional.codigo.replace(/^(\d{2})(\d{2})(\d{2})$/, '$1.$2.$3')} — ${r.servicoNacional.descricao}` : null, descricao: r.descricao,
      issRetido: !!r.rascunho?.issRetido,
      // Rascunho ainda não tem ambiente gravado: vale o da empresa, que é para onde ele vai.
      ambiente: r.ambiente || p.ambiente, homologacao: (r.ambiente || p.ambiente) === 'producao_restrita', nNfse: r.nNfse, chaveAcesso: r.chaveAcesso };
  }

  function visao(usuarioId, c) {
    const itens = [];
    let ultimoAssistente = null;
    for (const m of c.historico) {
      if (m.papel === 'usuario') { itens.push({ tipo: 'usuario', texto: m.texto }); ultimoAssistente = null; } else if (m.papel === 'aviso') { itens.push({ tipo: 'aviso', texto: m.tela || m.texto }); ultimoAssistente = null; } else if (m.papel === 'assistente') {
        if (!ultimoAssistente) { ultimoAssistente = { tipo: 'assistente', texto: '', acoes: [], notas: [] }; itens.push(ultimoAssistente); }
        if (m.texto) ultimoAssistente.texto = ultimoAssistente.texto ? `${ultimoAssistente.texto}\n\n${m.texto}` : m.texto;
        for (const ch of m.chamadas || []) ultimoAssistente.acoes.push({ ferramenta: ch.nome, rotulo: ROTULOS_FERRAMENTA[ch.nome] || ch.nome, id: ch.id });
      } else if (m.papel === 'ferramentas' && ultimoAssistente) {
        for (const r of m.resultados) {
          const acao = ultimoAssistente.acoes.find((a) => a.id === r.id);
          if (acao) acao.erro = !!r.erro;
          // Notas tocadas pelo assistente viram atalhos na tela.
          if (['criar_rascunho', 'alterar_rascunho', 'emitir_nota', 'verificar_nota', 'clonar_nota'].includes(r.nome) && !r.erro) {
            try {
              const d = JSON.parse(r.conteudo);
              const id = d?.nota?.id || d?.id;
              if (id && !ultimoAssistente.notas.some((x) => x.id === id)) ultimoAssistente.notas.push({ id, empresaId: r.empresaId || c.prestadorId });
            } catch { /* resultado truncado: sem atalho */ }
          }
        }
      }
    }
    for (const it of itens) {
      if (it.tipo !== 'assistente') continue;
      it.acoes = it.acoes.map(({ id, ...resto }) => resto); // eslint-disable-line no-unused-vars
      it.notas = it.notas.map((x) => notaParaTela(usuarioId, x.empresaId, x.id)).filter(Boolean);
    }
    const pendentes = c.pendentes.map((x) => notaParaTela(usuarioId, x.empresaId, x.notaId)).filter((n) => n && ['rascunho', 'rejeitada'].includes(n.situacao));
    return { id: c.id, titulo: c.titulo, empresaId: c.prestadorId, atualizadoEm: c.atualizadoEm, itens, pendentes };
  }

  // ---------------------------------------------------------- laço principal
  async function enviarMensagem({ usuario, empresa, conversaId, texto, ip }) {
    const t = String(texto ?? '').trim();
    if (!t) throw invalido('Escreva uma mensagem.');
    if (t.length > 8000) throw invalido('Mensagem longa demais (até 8.000 caracteres).');
    const cfg = exigirConfig(usuario.id);
    const c = conversaBruta(usuario.id, conversaId);
    if (!c) throw naoEncontrado('Conversa');
    if (ocupadas.has(c.id)) throw new ErroApp(409, 'O assistente ainda está respondendo nesta conversa. Aguarde.');
    ocupadas.add(c.id);
    try {
      if (!c.historico.length) c.titulo = t.replace(/\s+/g, ' ').slice(0, 70);
      if (empresa) c.prestadorId = empresa.id;
      const empresaAtual = (c.prestadorId && repo.prestadorDoUsuarioPorId(usuario.id, c.prestadorId)) || empresa || null;
      c.historico.push({ papel: 'usuario', texto: t, em: agora() });
      const ctxFerramentas = { app: { ...appCtx, log }, usuario, empresaPadrao: empresaAtual, ip, emissaoAutonoma: cfg.emissaoAutonoma, pendentes: c.pendentes };
      const executar = criarFerramentas(ctxFerramentas);
      let erro = null;
      try {
        for (let etapa = 0; etapa < MAX_ETAPAS; etapa++) {
          const sistemaVariavel = await montarContexto({ ctx: appCtx, usuario, empresa: empresaAtual && repo.prestadorDoUsuarioPorId(usuario.id, empresaAtual.id), emissaoAutonoma: cfg.emissaoAutonoma, pendentes: c.pendentes });
          const r = await chamar({ ...cfg, sistemaFixo: SISTEMA_FIXO, sistemaVariavel, historico: recortar(c.historico, MAX_HISTORICO_ENVIADO), ferramentas: DEFINICOES });
          const entrada = { papel: 'assistente', texto: r.texto, chamadas: r.chamadas.map(({ argsInvalidos, ...x }) => x), nativo: r.nativo || undefined, modelo: r.modeloUsado }; // eslint-disable-line no-unused-vars
          if (r.fim === 'recusa' && !r.texto) entrada.texto = 'O provedor de IA recusou responder a este pedido. Reformule ou tente outro modelo.';
          if (r.fim === 'limite' && !r.chamadas.length) entrada.texto = `${r.texto}\n\n(A resposta foi cortada pelo limite de tamanho. Peça para continuar.)`.trim();
          c.historico.push(entrada);
          if (r.fim !== 'ferramentas') break;
          const resultados = [];
          for (const ch of r.chamadas) {
            const res = ch.argsInvalidos
              ? { erro: true, conteudo: JSON.stringify({ erro: 'Argumentos em JSON inválido. Envie de novo.' }) }
              : await executar(ch.nome, ch.args);
            const conteudo = res.conteudo.length > MAX_RESULTADO ? `${res.conteudo.slice(0, MAX_RESULTADO)}… [resultado cortado]` : res.conteudo;
            resultados.push({ id: ch.id, nome: ch.nome, conteudo, erro: res.erro, empresaId: ch.args?.empresaId || empresaAtual?.id || null });
          }
          c.historico.push({ papel: 'ferramentas', resultados });
          if (etapa === MAX_ETAPAS - 1) c.historico.push({ papel: 'aviso', texto: 'O assistente fez muitas etapas seguidas e parou aqui. Peça para continuar, se preciso.' });
        }
      } catch (e) {
        // Erro do provedor (ou limite): o que já aconteceu nesta mensagem fica guardado e a tela mostra o motivo.
        if (e instanceof ErroApp) erro = e.message; else { log?.error?.(e); erro = 'Falha inesperada ao falar com o provedor de IA.'; }
      }
      guardar(usuario.id, c);
      auditar(db, { usuarioId: usuario.id, prestadorId: empresaAtual?.id || null, acao: 'ia.mensagem', entidade: 'ia_conversa', entidadeId: c.id, detalhes: { provedor: cfg.provedor, modelo: cfg.modelo, erro: !!erro }, ip });
      return { conversa: visao(usuario.id, conversaBruta(usuario.id, c.id)), erro };
    } finally { ocupadas.delete(c.id); }
  }

  // O usuário tocou em "Emitir agora" (ou em "Não emitir") no cartão de uma nota preparada pelo assistente.
  async function decidirEmissao({ usuario, conversaId, notaId, emitir, ip, limites }) {
    const c = conversaBruta(usuario.id, conversaId);
    if (!c) throw naoEncontrado('Conversa');
    const pedido = c.pendentes.find((x) => x.notaId === String(notaId || ''));
    if (!pedido) throw new ErroApp(409, 'Esta nota não está aguardando confirmação nesta conversa.');
    if (ocupadas.has(c.id)) throw new ErroApp(409, 'O assistente ainda está respondendo nesta conversa. Aguarde.');
    ocupadas.add(c.id);
    try {
      const p = repo.prestadorDoUsuarioPorId(usuario.id, pedido.empresaId);
      if (!p) throw new ErroApp(409, 'A empresa desta nota não está mais disponível na sua conta.');
      c.pendentes = c.pendentes.filter((x) => x.notaId !== pedido.notaId);
      let resultado = null;
      if (!emitir) {
        c.historico.push({ papel: 'aviso', texto: `O usuário decidiu NÃO emitir a nota ${pedido.notaId} por enquanto. Ela continua como rascunho.`, tela: 'Você preferiu não emitir agora. A nota continua como rascunho.' });
      } else {
        limites?.consumir(`custo:${usuario.id}`, 30, 60_000);
        resultado = await emitirConfirmada({ app: appCtx, usuario, ip }, p, pedido.notaId, { versao: pedido.versao, revisao: pedido.revisao });
        const n = resultado.nota;
        const descricao = resultado.situacao === 'emitida'
          ? `EMITIDA: NFS-e nº ${n?.numeroNfse || '?'}, chave de acesso ${n?.chaveAcesso || '?'}${n?.consultaPublica ? `, consulta pública ${n.consultaPublica}` : ''}.`
          : resultado.situacao === 'rejeitada' ? `REJEITADA pela Receita: ${JSON.stringify(n?.errosDaReceita || [])}. Nenhuma nota foi emitida.`
            : resultado.situacao === 'pendente' ? 'PENDENTE: a Receita não confirmou ainda. Não reenvie; use verificar_nota.'
              : `NÃO ENVIADA: ${resultado.mensagem || ''}`;
        const tela = resultado.situacao === 'emitida' ? `Você confirmou e a NFS-e nº ${n?.numeroNfse || '?'} foi emitida.`
          : resultado.situacao === 'rejeitada' ? 'Você confirmou, mas a Receita rejeitou a nota. Nenhuma nota foi emitida; peça ao assistente para corrigir.'
            : resultado.situacao === 'pendente' ? 'Você confirmou; a Receita ainda não respondeu. Não emita de novo: peça ao assistente para verificar a situação.'
              : `Você confirmou, mas a nota não foi enviada: ${resultado.mensagem || ''}`;
        c.historico.push({ papel: 'aviso', texto: `O usuário tocou em "Emitir agora" para a nota ${pedido.notaId}. Resultado: ${descricao}`, tela });
      }
      guardar(usuario.id, c);
      return { conversa: visao(usuario.id, conversaBruta(usuario.id, c.id)), resultado: resultado && { situacao: resultado.situacao, mensagem: resultado.mensagem || null, notaId: pedido.notaId, empresaId: p.id } };
    } finally { ocupadas.delete(c.id); }
  }

  return {
    configPublica, salvarConfig, removerConfig, testarConfig, criarConversa, listarConversas, removerConversa, enviarMensagem, decidirEmissao,
    conversa: (usuarioId, id) => { const c = conversaBruta(usuarioId, id); if (!c) throw naoEncontrado('Conversa'); return visao(usuarioId, c); },
  };
}

// Corta o começo do histórico sem separar uma chamada de ferramenta do seu resultado:
// o corte sempre cai numa mensagem do usuário.
export function recortar(historico, maximo) {
  if (historico.length <= maximo) return historico;
  let inicio = historico.length - maximo;
  while (inicio < historico.length && historico[inicio].papel !== 'usuario') inicio++;
  return inicio < historico.length ? historico.slice(inicio) : historico.slice(-1);
}
