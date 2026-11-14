// Assistente de IA: chat que lê os parâmetros do emissor, prepara e emite notas.
// Configuração do provedor (Anthropic, OpenAI, Grok, OpenRouter, provedores chineses…) por conta.
import { h, campo, aviso, moeda, data, carregando, icone, ICONES, mostrarErros } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { estado, ir, entrarNaEmpresa } from '../app.js';

const ICONE_IA = 'M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8zM19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9zM5 15l.7 1.5L7 17l-1.3.6L5 19l-.7-1.4L3 17l1.3-.5z';
const SUGESTOES = [
  'Emita uma nota de R$ 1.500,00 para o cliente … pelo serviço …',
  'Quanto a empresa faturou este mês e no ano?',
  'Qual código de serviço uso para consultoria em TI?',
  'Clone a última nota emitida para este mês',
  'O cliente vai reter ISS? Como fica a nota no meu regime?',
  'Estou perto do limite do MEI?',
];

const chaveUltima = () => `nss-ia-conversa:${estado.conta?.usuarioId || ''}`;
const lembrar = (id) => { try { localStorage.setItem(chaveUltima(), id); } catch { /* sem armazenamento */ } };
const ultimaLembrada = () => { try { return localStorage.getItem(chaveUltima()); } catch { return null; } };

// Markdown mínimo e seguro (sem innerHTML): parágrafos, listas, **negrito**, `código` e links http(s).
function trechoFormatado(texto) {
  const partes = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)]+)/g;
  let i = 0; let m;
  while ((m = re.exec(texto))) {
    if (m.index > i) partes.push(texto.slice(i, m.index));
    const t = m[0];
    if (t.startsWith('**')) partes.push(h('strong', {}, t.slice(2, -2)));
    else if (t.startsWith('`')) partes.push(h('code', {}, t.slice(1, -1)));
    else partes.push(h('a', { href: t, target: '_blank', rel: 'noopener noreferrer' }, t));
    i = m.index + t.length;
  }
  if (i < texto.length) partes.push(texto.slice(i));
  return partes;
}
function formatado(texto) {
  const blocos = [];
  let lista = null;
  for (const linha of String(texto || '').split('\n')) {
    const item = linha.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    const titulo = linha.match(/^#{1,4}\s+(.*)$/);
    if (item) {
      if (!lista) { lista = h(/^\s*\d/.test(linha) ? 'ol' : 'ul', {}); blocos.push(lista); }
      lista.append(h('li', {}, trechoFormatado(item[1])));
    } else {
      lista = null;
      if (titulo) blocos.push(h('p', {}, h('strong', {}, trechoFormatado(titulo[1]))));
      else if (linha.trim()) blocos.push(h('p', {}, trechoFormatado(linha)));
    }
  }
  return blocos;
}

function linkNota(n) {
  if (n.empresaId === estado.conta?.prestadorId) return h('a', { class: 'btn btn-pequeno', href: `#/notas/${encodeURIComponent(n.id)}` }, 'Abrir a nota');
  return h('button', { class: 'btn btn-pequeno', type: 'button', onclick: () => entrarNaEmpresa(n.empresaId, `/notas/${encodeURIComponent(n.id)}`).catch((e) => aviso(e.message)) }, `Abrir em ${n.empresaNome || 'outra empresa'}`);
}

function cartaoNota(n) {
  return h('div', { class: `ia-nota s-borda-${n.situacao}` },
    h('div', { class: 'ia-nota-topo' }, h('span', { class: `situacao s-${n.situacao}` }, n.rotulo), h('strong', {}, moeda(n.valor))),
    h('div', { class: 'item-sub' }, `${n.cliente} · competência ${data(n.competencia)}`),
    n.nNfse ? h('div', { class: 'item-sub' }, `NFS-e nº ${n.nNfse}`) : null,
    linkNota(n));
}

function cartaoConfirmacao(n, aoDecidir) {
  const emitir = h('button', { class: 'btn btn-primario', type: 'button' }, 'Emitir agora');
  const naoEmitir = h('button', { class: 'btn btn-texto', type: 'button' }, 'Agora não');
  const decidir = async (sim) => { emitir.disabled = true; naoEmitir.disabled = true; emitir.textContent = sim ? 'Emitindo…' : emitir.textContent; try { await aoDecidir(n, sim); } finally { emitir.disabled = false; naoEmitir.disabled = false; emitir.textContent = 'Emitir agora'; } };
  emitir.addEventListener('click', () => decidir(true));
  naoEmitir.addEventListener('click', () => decidir(false));
  return h('section', { class: 'cartao ia-confirmar', 'aria-label': 'Nota pronta para emitir' },
    h('h3', { style: 'margin-top:0' }, 'Nota pronta para emitir'),
    h('dl', { class: 'ia-resumo' },
      h('dt', {}, 'Empresa'), h('dd', {}, n.empresaNome || '—'),
      h('dt', {}, 'Cliente'), h('dd', {}, n.cliente),
      h('dt', {}, 'Serviço'), h('dd', {}, n.servico || '—'),
      h('dt', {}, 'Descrição'), h('dd', {}, n.descricao || '—'),
      h('dt', {}, 'Competência'), h('dd', {}, data(n.competencia)),
      h('dt', {}, 'Valor'), h('dd', {}, h('strong', {}, moeda(n.valor))),
      h('dt', {}, 'ISS'), h('dd', {}, n.issRetido ? 'Retido pelo cliente' : 'Não retido')),
    h('p', { class: n.homologacao || estado.demo ? 'suave' : 'ia-real' }, estado.demo ? 'Demonstração: a Receita é simulada e nenhuma nota é real.' : n.homologacao
      ? 'Ambiente de testes: a nota não terá validade jurídica.'
      : 'Produção: ao tocar em "Emitir agora", a NFS-e é enviada à Receita e vale como nota fiscal.'),
    h('div', { class: 'ia-confirmar-acoes' }, emitir, naoEmitir));
}

function bolha(item) {
  if (item.tipo === 'usuario') return h('div', { class: 'ia-msg ia-usuario' }, h('div', { class: 'ia-bolha' }, formatado(item.texto)));
  if (item.tipo === 'aviso') return h('div', { class: 'ia-msg ia-aviso', role: 'note' }, formatado(item.texto));
  return h('div', { class: 'ia-msg ia-assistente' },
    h('div', { class: 'ia-avatar', 'aria-hidden': 'true' }, icone(ICONE_IA)),
    h('div', { class: 'ia-corpo' },
      item.acoes?.length ? h('ul', { class: 'ia-acoes', 'aria-label': 'O que o assistente fez' },
        item.acoes.map((a) => h('li', { class: a.erro ? 'erro' : '' }, `${a.erro ? '✕' : '✓'} ${a.rotulo}`))) : null,
      item.texto ? h('div', { class: 'ia-bolha' }, formatado(item.texto)) : null,
      item.notas?.length ? h('div', { class: 'ia-notas' }, item.notas.map(cartaoNota)) : null));
}

function telaSemConfig(cfgErro) {
  return {
    titulo: 'Assistente', aba: 'assistente',
    node: h('div', {},
      h('section', { class: 'cartao ia-boas-vindas' },
        h('div', { class: 'ia-avatar grande', 'aria-hidden': 'true' }, icone(ICONE_IA)),
        h('h2', {}, 'Assistente fiscal com IA'),
        h('p', {}, 'Converse em português para emitir notas, tirar dúvidas de tributação (ISS, Simples, MEI, Presumido, retenções, IBS/CBS) e consultar o faturamento. O assistente lê os dados da empresa e usa as mesmas regras do app.'),
        h('p', { class: 'suave' }, 'Funciona com Anthropic (Claude), OpenAI, xAI (Grok), OpenRouter, DeepSeek, Qwen, Kimi, GLM, MiniMax, Doubao, ERNIE e outros compatíveis. Você usa a sua própria chave de API.'),
        cfgErro ? h('p', { class: 'erro-campo' }, cfgErro) : null,
        h('a', { class: 'btn btn-primario', href: '#/assistente/configurar' }, 'Configurar o assistente'))),
  };
}

export async function tela({ id } = {}) {
  const [{ config }, { conversas }] = await Promise.all([api('GET', '/api/ia/config'), api('GET', '/api/ia/conversas')]);
  if (!config.configurado) return telaSemConfig();
  let conversa;
  const alvo = id || ultimaLembrada();
  if (alvo) { try { conversa = (await api('GET', `/api/ia/conversas/${encodeURIComponent(alvo)}`)).conversa; } catch (e) { if (!(e instanceof ErroApi) || e.status !== 404) throw e; } }
  if (!conversa) { conversa = (await api('POST', '/api/ia/conversas', {})).conversa; conversas.unshift({ id: conversa.id, titulo: conversa.titulo, atualizadoEm: conversa.atualizadoEm }); }
  lembrar(conversa.id);

  const lista = h('div', { class: 'ia-chat', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversa com o assistente' });
  const confirmacoes = h('div', { class: 'ia-pendentes' });
  const erro = h('p', { class: 'erro-campo', role: 'alert', hidden: true });
  const titulo = h('h2', { class: 'ia-titulo' }, conversa.titulo);

  function desenhar(c, { rolar = true } = {}) {
    conversa = c;
    titulo.textContent = c.titulo;
    if (!c.itens.length) {
      lista.replaceChildren(h('div', { class: 'ia-vazio' },
        h('p', {}, 'Peça em linguagem comum. Exemplos:'),
        h('div', { class: 'ia-sugestoes' }, SUGESTOES.map((s) => h('button', { class: 'ia-sugestao', type: 'button', onclick: () => { entrada.value = s.replace(/ …/g, ' '); entrada.focus(); } }, s)))));
    } else lista.replaceChildren(...c.itens.map(bolha));
    confirmacoes.replaceChildren(...c.pendentes.map((n) => cartaoConfirmacao(n, decidirEmissao)));
    if (rolar) requestAnimationFrame(() => (confirmacoes.lastElementChild || lista.lastElementChild)?.scrollIntoView({ block: 'end', behavior: 'smooth' }));
  }

  async function decidirEmissao(n, emitir) {
    erro.hidden = true;
    try {
      const r = await api('POST', `/api/ia/conversas/${conversa.id}/emissao`, { notaId: n.id, emitir });
      desenhar(r.conversa);
      if (r.resultado?.situacao === 'emitida') aviso('NFS-e emitida.');
      else if (r.resultado) aviso(r.resultado.mensagem || `Situação: ${r.resultado.situacao}`, 7000);
      estado.inicio = null;
    } catch (e) { erro.textContent = e.message; erro.hidden = false; }
  }

  const entrada = h('textarea', { class: 'ia-entrada', rows: 2, maxlength: 8000, placeholder: 'Escreva para o assistente…', 'aria-label': 'Mensagem para o assistente',
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } } });
  const enviar = h('button', { class: 'btn btn-primario ia-enviar', type: 'submit', 'aria-label': 'Enviar' }, icone('M5 12h14M13 6l6 6-6 6'));
  const pensando = h('div', { class: 'ia-msg ia-assistente ia-pensando', role: 'status' }, h('div', { class: 'ia-avatar', 'aria-hidden': 'true' }, icone(ICONE_IA)), carregando('Pensando e consultando o emissor…'));
  const form = h('form', { class: 'ia-compor', onsubmit: async (e) => {
    e.preventDefault();
    const texto = entrada.value.trim();
    if (!texto || enviar.disabled) return;
    erro.hidden = true;
    enviar.disabled = true; entrada.disabled = true;
    lista.querySelector('.ia-vazio')?.remove();
    lista.append(bolha({ tipo: 'usuario', texto }), pensando);
    pensando.scrollIntoView({ block: 'end', behavior: 'smooth' });
    entrada.value = '';
    try {
      const r = await api('POST', `/api/ia/conversas/${conversa.id}/mensagens`, { texto });
      desenhar(r.conversa);
      if (r.erro) { erro.textContent = r.erro; erro.hidden = false; }
      estado.inicio = null; // o resumo do Início pode ter mudado (nota emitida)
    } catch (err) {
      pensando.remove();
      if (err instanceof ErroApi && err.dados?.codigo === 'IA_NAO_CONFIGURADA') { ir('/assistente/configurar'); return; }
      entrada.value = texto;
      erro.textContent = err.status === 0 ? 'Sem internet: o assistente precisa de conexão.' : err.message;
      erro.hidden = false;
    } finally { enviar.disabled = false; entrada.disabled = false; entrada.focus(); }
  } }, entrada, enviar);

  const historico = h('details', { class: 'ia-historico' }, h('summary', {}, `Conversas (${conversas.length})`),
    h('ul', { class: 'lista' }, conversas.map((c) => h('li', {}, h('a', { class: 'item', href: `#/assistente/${encodeURIComponent(c.id)}`, 'aria-current': c.id === conversa.id ? 'true' : null },
      h('div', { class: 'item-corpo' }, h('div', { class: 'item-titulo' }, c.titulo), h('div', { class: 'item-sub' }, new Date(c.atualizadoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))))))));

  desenhar(conversa, { rolar: false });
  requestAnimationFrame(() => { (confirmacoes.lastElementChild || lista.lastElementChild)?.scrollIntoView({ block: 'end' }); entrada.focus({ preventScroll: true }); });
  return {
    titulo: 'Assistente', aba: 'assistente',
    node: h('div', { class: 'ia-tela' },
      h('div', { class: 'ia-cabecalho' }, titulo,
        h('div', { class: 'ia-cabecalho-acoes' },
          h('button', { class: 'btn btn-pequeno', type: 'button', onclick: async () => { const c = (await api('POST', '/api/ia/conversas', {})).conversa; lembrar(c.id); ir(`/assistente/${c.id}`); } }, icone(ICONES.mais), 'Nova conversa'),
          h('a', { class: 'btn btn-pequeno', href: '#/assistente/configurar' }, icone(ICONES.ajustes), 'Configurar'))),
      h('p', { class: 'suave ia-modo' }, `${config.provedorNome} · ${config.modelo} · ${config.emissaoAutonoma ? 'emite sozinho' : 'pede sua confirmação para emitir'}`),
      historico, lista, confirmacoes, erro, form,
      h('p', { class: 'suave ia-rodape' }, 'A IA pode errar: confira o resumo antes de emitir. Os dados consultados são enviados ao provedor escolhido.'),
      conversa.itens.length ? h('button', { class: 'btn btn-texto btn-perigo', type: 'button', onclick: async () => {
        if (!confirm('Apagar esta conversa? As notas criadas ou emitidas continuam no app.')) return;
        await api('DELETE', `/api/ia/conversas/${conversa.id}`);
        lembrar('');
        ir('/assistente');
      } }, 'Apagar esta conversa') : null),
  };
}

export async function configurar() {
  const [{ config }, { provedores }] = await Promise.all([api('GET', '/api/ia/config'), api('GET', '/api/ia/provedores')]);
  const atual = config.origem === 'conta' ? config : {};
  const porId = Object.fromEntries(provedores.map((p) => [p.id, p]));
  let provedor = atual.provedor || 'anthropic';

  const sugestoes = h('datalist', { id: 'ia-modelos' });
  const cProvedor = campo({ rotulo: 'Provedor de IA', valor: provedor, opcoes: provedores.map((p) => [p.id, p.nome]),
    onchange: (e) => { provedor = e.target.value; atualizar(true); } });
  const cModelo = campo({ rotulo: 'Modelo', ajuda: 'Escolha uma sugestão ou digite o identificador exato do modelo no seu provedor.', valor: atual.modelo || porId[provedor]?.modeloPadrao || '',
    atributos: { list: 'ia-modelos', autocomplete: 'off', spellcheck: 'false', required: true } });
  cModelo.append(sugestoes);
  const cChave = campo({ rotulo: 'Chave de API', tipo: 'password', ajuda: '', valor: '',
    atributos: { autocomplete: 'off', spellcheck: 'false', placeholder: atual.chaveFinal ? `Guardada (${atual.chaveFinal}). Deixe em branco para manter.` : 'Cole a chave aqui' } });
  const cBase = campo({ rotulo: 'Endereço da API', ajuda: 'Só para provedor compatível com OpenAI que não está na lista, ou outro endereço (ex.: região da China). Use https://', valor: atual.baseUrl || '',
    atributos: { inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://…/v1' } });
  const cEsforco = campo({ rotulo: 'Profundidade do raciocínio', ajuda: 'Vale para Anthropic e OpenAI. Mais profundo = respostas mais cuidadosas, mais lentas e mais caras.', valor: atual.esforco || '',
    opcoes: [['', 'Padrão do modelo'], ['low', 'Baixa'], ['medium', 'Média'], ['high', 'Alta (recomendada para emitir)'], ['xhigh', 'Muito alta'], ['max', 'Máxima']] });
  const radio = (valor, texto, sub) => h('label', { class: 'ia-opcao' }, h('input', { type: 'radio', name: 'ia-modo', value: valor, checked: String(!!atual.emissaoAutonoma) === valor }),
    h('span', {}, h('strong', {}, texto), h('br'), h('span', { class: 'suave' }, sub)));
  const modo = h('fieldset', { class: 'ia-modos' }, h('legend', {}, 'Emissão de notas pelo assistente'),
    radio('false', 'Pedir minha confirmação (recomendado)', 'O assistente prepara e valida a nota; ela só é enviada quando você toca em "Emitir agora".'),
    radio('true', 'Emitir sozinho', 'Quando você pedir uma nota com os dados completos, o assistente envia direto à Receita. Em produção, é nota fiscal real.'));
  const onde = h('p', { class: 'suave' });
  const maisOpcoes = h('details', {}, h('summary', {}, 'Mais opções'), cBase);

  function atualizar(trocou) {
    const p = porId[provedor];
    sugestoes.replaceChildren(...(p?.modelos || []).map((m) => h('option', { value: m })));
    if (trocou) cModelo.entrada.value = p?.modeloPadrao || '';
    onde.textContent = p ? `Onde obter a chave: ${p.ondeObterChave}` : '';
    if (p?.exigeBaseUrl) { maisOpcoes.open = true; }
    cChave.entrada.placeholder = atual.chaveFinal && provedor === atual.provedor ? `Guardada (${atual.chaveFinal}). Deixe em branco para manter.` : 'Cole a chave aqui';
  }
  atualizar(false);

  const erroGeral = h('p', { class: 'erro-campo', role: 'alert', hidden: true });
  const okTeste = h('p', { class: 'cartao cartao-ok', role: 'status', hidden: true });
  const salvar = h('button', { class: 'btn btn-primario', type: 'submit' }, 'Salvar');
  const corpo = () => ({ provedor, modelo: cModelo.entrada.value.trim(), chave: cChave.entrada.value.trim(), baseUrl: cBase.entrada.value.trim(), esforco: cEsforco.entrada.value,
    emissaoAutonoma: modo.querySelector('input[name="ia-modo"]:checked')?.value === 'true' });
  async function gravar() {
    const b = corpo();
    if (b.emissaoAutonoma && !atual.emissaoAutonoma && !confirm('Com a emissão autônoma, o assistente envia notas fiscais à Receita sem pedir sua confirmação. Ativar?')) return false;
    erroGeral.hidden = true;
    try {
      const r = await api('PUT', '/api/ia/config', b);
      Object.assign(atual, r.config);
      cChave.entrada.value = '';
      mostrarErros({ provedor: cProvedor, modelo: cModelo, chave: cChave, baseUrl: cBase }, {});
      atualizar(false);
      return true;
    } catch (err) {
      if (err instanceof ErroApi && err.dados?.campos) { if (err.dados.campos.baseUrl) maisOpcoes.open = true; mostrarErros({ provedor: cProvedor, modelo: cModelo, chave: cChave, baseUrl: cBase }, err.dados.campos); } else { erroGeral.textContent = err.message; erroGeral.hidden = false; }
      return false;
    }
  }
  const form = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    salvar.disabled = true;
    try { if (await gravar()) { aviso('Assistente configurado.'); ir('/assistente'); } } finally { salvar.disabled = false; }
  } }, cProvedor, onde, cModelo, cChave, cEsforco, modo, maisOpcoes, erroGeral, okTeste,
  h('div', { class: 'rodape-fixo' }, salvar));

  const testar = h('button', { class: 'btn', type: 'button', onclick: async () => {
    testar.disabled = true; okTeste.hidden = true; erroGeral.hidden = true;
    try {
      if (!(await gravar())) return;
      const r = await api('POST', '/api/ia/config/testar', {});
      okTeste.textContent = `Conexão funcionando com ${r.modelo}. Resposta: "${r.resposta}"`;
      okTeste.hidden = false;
    } catch (err) { erroGeral.textContent = err.message; erroGeral.hidden = false; } finally { testar.disabled = false; }
  } }, 'Salvar e testar a conexão');

  const remover = atual.chaveFinal ? h('button', { class: 'btn btn-texto btn-perigo', type: 'button', onclick: async () => {
    if (!confirm('Remover a chave de API e a configuração do assistente?')) return;
    await api('DELETE', '/api/ia/config');
    aviso('Chave removida.');
    ir('/assistente');
  } }, 'Remover a chave de API') : null;

  return {
    titulo: 'Configurar assistente', aba: 'assistente', voltar: true, tarefa: true,
    node: h('div', {},
      config.origem === 'servidor' ? h('p', { class: 'cartao' }, `Esta instalação já oferece um provedor padrão (${config.provedorNome}, ${config.modelo}). Configure aqui só se quiser usar a sua própria chave.`) : null,
      h('p', { class: 'suave' }, 'A chave fica guardada cifrada no servidor e nunca volta para o aparelho. As mensagens e os dados que o assistente consulta (clientes, valores, notas) são enviados ao provedor escolhido, sob a política de privacidade dele.'),
      form, testar, remover),
  };
}

