// Assistente de IA: chat que lê os parâmetros do emissor, prepara e emite notas.
// Configuração do provedor (Anthropic, OpenAI, Grok, OpenRouter, provedores chineses…) por conta.
import { h, anexar, campo, aviso, moeda, data, carregando, icone, ICONES, mostrarErros } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { estado, ir, entrarNaEmpresa } from '../app.js';

const ICONE_IA = 'M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8zM19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9zM5 15l.7 1.5L7 17l-1.3.6L5 19l-.7-1.4L3 17l1.3-.5z';
const ICONE_CLIPE = 'M21 11l-8.5 8.5a5 5 0 01-7-7L14 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 7';
const ICONE_MICROFONE = 'M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3M8 21h8';
// Arquivos aceitos no chat (o servidor confere de novo).
const ACEITOS = '.xlsx,.xlsm,.csv,.tsv,.pdf,.docx,.txt,.md,.xml,.json';
const LIMITE_TOTAL = 3 * 1024 * 1024;
const MAX_ARQUIVOS = 5;
const tamanho = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const paraBase64 = (arquivo) => new Promise((ok, falha) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(',')[1] || '');
  r.onerror = () => falha(new Error(`Não foi possível ler ${arquivo.name}.`));
  r.readAsDataURL(arquivo);
});
const SUGESTOES = [
  'Emita uma nota de R$ 1.500,00 para o cliente … pelo serviço …',
  'Quanto a empresa faturou este mês e no ano?',
  'Qual código de serviço uso para consultoria em TI?',
  'Clone a última nota emitida para este mês',
  'O cliente vai reter ISS? Como fica a nota no meu regime?',
  'Estou perto do limite do MEI?',
  'Quem é você e o que consegue fazer?',
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
// Tabela em Markdown (| a | b |): vira <table> rolável na horizontal no celular.
function tabela(linhas) {
  const celulas = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const [cab, ...resto] = linhas;
  const corpo = resto.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l));
  return h('div', { class: 'ia-tabela' }, h('table', {},
    h('thead', {}, h('tr', {}, celulas(cab).map((c) => h('th', { scope: 'col' }, trechoFormatado(c))))),
    h('tbody', {}, corpo.map((l) => h('tr', {}, celulas(l).map((c) => h('td', c.length <= 28 ? { class: 'curta' } : {}, trechoFormatado(c))))))));
}

function formatado(texto) {
  const blocos = [];
  let lista = null;
  const linhas = String(texto || '').split('\n');
  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    if (/^\s*\|.*\|\s*$/.test(linha)) {
      const grupo = [];
      while (i < linhas.length && /^\s*\|.*\|\s*$/.test(linhas[i])) grupo.push(linhas[i++]);
      i--;
      lista = null;
      blocos.push(grupo.length > 1 ? tabela(grupo) : h('p', {}, trechoFormatado(linha)));
      continue;
    }
    const item = linha.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    const titulo = linha.match(/^#{1,4}\s+(.*)$/);
    if (item) {
      if (!lista) { lista = h(/^\s*\d/.test(linha) ? 'ol' : 'ul', {}); blocos.push(lista); }
      lista.append(h('li', {}, trechoFormatado(item[1])));
    } else {
      lista = null;
      if (titulo) blocos.push(h('p', { class: 'ia-titulo-bloco' }, h('strong', {}, trechoFormatado(titulo[1]))));
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
  if (item.tipo === 'usuario') {
    return h('div', { class: 'ia-msg ia-usuario' }, h('div', { class: 'ia-usuario-corpo' },
      item.anexos?.length ? h('ul', { class: 'ia-anexos', 'aria-label': 'Arquivos enviados' }, item.anexos.map((a) => h('li', {}, icone(ICONE_CLIPE), h('span', {}, a.nome), a.detalhe ? h('span', { class: 'ia-anexo-detalhe' }, a.detalhe) : null))) : null,
      h('div', { class: 'ia-bolha' }, formatado(item.texto))));
  }
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

  // ---------------- anexos: clipe, arrastar e soltar, colar
  let anexos = [];
  const chips = h('ul', { class: 'ia-anexos ia-anexos-novos', 'aria-label': 'Arquivos para enviar', hidden: true });
  function desenharChips() {
    chips.hidden = !anexos.length;
    chips.replaceChildren(...anexos.map((a, i) => h('li', {}, icone(ICONE_CLIPE), h('span', {}, a.name), h('span', { class: 'ia-anexo-detalhe' }, tamanho(a.size)),
      h('button', { type: 'button', class: 'ia-anexo-remover', 'aria-label': `Remover ${a.name}`, onclick: () => { anexos.splice(i, 1); desenharChips(); } }, '×'))));
  }
  function adicionar(lista) {
    for (const f of Array.from(lista || [])) {
      const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
      if (ext === 'xls' || ext === 'doc') { aviso(`${f.name}: salve como .${ext}x no ${ext === 'xls' ? 'Excel' : 'Word'} e envie de novo.`, 6000); continue; }
      if (!ACEITOS.split(',').includes(`.${ext}`)) { aviso(`${f.name}: envie Excel (.xlsx), CSV, PDF, Word (.docx), XML ou texto.`, 6000); continue; }
      if (anexos.length >= MAX_ARQUIVOS) { aviso(`Até ${MAX_ARQUIVOS} arquivos por mensagem.`); break; }
      if (anexos.reduce((t, a) => t + a.size, 0) + f.size > LIMITE_TOTAL) { aviso('Os arquivos de uma mensagem podem somar até 3 MB.', 6000); continue; }
      anexos.push(f);
    }
    desenharChips();
    entrada.focus();
  }
  const seletor = h('input', { type: 'file', multiple: true, accept: ACEITOS, hidden: true, onchange: (e) => { adicionar(e.target.files); e.target.value = ''; } });
  const clipe = h('button', { class: 'ia-botao-icone', type: 'button', title: 'Anexar arquivo (Excel, PDF, Word…)', 'aria-label': 'Anexar arquivo', onclick: () => seletor.click() }, icone(ICONE_CLIPE));

  // ---------------- microfone: ditado em português pelo próprio navegador
  const Reconhecimento = window.SpeechRecognition || window.webkitSpeechRecognition;
  let ditado = null;
  const microfone = h('button', { class: 'ia-botao-icone', type: 'button', title: 'Falar em vez de digitar', 'aria-label': 'Ditar mensagem pelo microfone', 'aria-pressed': 'false', hidden: !Reconhecimento,
    onclick: () => {
      if (ditado) { ditado.stop(); return; }
      ditado = new Reconhecimento();
      ditado.lang = 'pt-BR'; ditado.interimResults = true; ditado.continuous = true;
      const antes = entrada.value ? `${entrada.value.replace(/\s+$/, '')} ` : '';
      let final = '';
      ditado.onresult = (ev) => {
        let parcial = '';
        for (let k = ev.resultIndex; k < ev.results.length; k++) {
          if (ev.results[k].isFinal) final += ev.results[k][0].transcript; else parcial += ev.results[k][0].transcript;
        }
        entrada.value = `${antes}${final}${parcial}`.replace(/\s{2,}/g, ' ');
      };
      ditado.onerror = (ev) => {
        if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') aviso('Permita o uso do microfone para este site nas configurações do navegador.', 6000);
        else if (ev.error !== 'aborted' && ev.error !== 'no-speech') aviso('O ditado parou. Toque no microfone para falar de novo.');
      };
      ditado.onend = () => { ditado = null; microfone.classList.remove('gravando'); microfone.setAttribute('aria-pressed', 'false'); entrada.focus(); };
      try { ditado.start(); microfone.classList.add('gravando'); microfone.setAttribute('aria-pressed', 'true'); } catch { ditado = null; }
    } }, icone(ICONE_MICROFONE));

  const entrada = h('textarea', { class: 'ia-entrada', rows: 2, maxlength: 8000, placeholder: 'Escreva, fale ou solte um arquivo aqui…', 'aria-label': 'Mensagem para o assistente',
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } },
    onpaste: (e) => { if (e.clipboardData?.files?.length) { e.preventDefault(); adicionar(e.clipboardData.files); } } });
  const enviar = h('button', { class: 'btn btn-primario ia-enviar', type: 'submit', 'aria-label': 'Enviar' }, icone('M5 12h14M13 6l6 6-6 6'));
  const pensando = h('div', { class: 'ia-msg ia-assistente ia-pensando', role: 'status' }, h('div', { class: 'ia-avatar', 'aria-hidden': 'true' }, icone(ICONE_IA)), carregando('Pensando e consultando o emissor…'));
  const form = h('form', { class: 'ia-compor', onsubmit: async (e) => {
    e.preventDefault();
    ditado?.stop();
    const texto = entrada.value.trim();
    if ((!texto && !anexos.length) || enviar.disabled) return;
    erro.hidden = true;
    enviar.disabled = true; entrada.disabled = true;
    const enviando = anexos;
    lista.querySelector('.ia-vazio')?.remove();
    lista.append(bolha({ tipo: 'usuario', texto: texto || (enviando.length === 1 ? `Analise o arquivo ${enviando[0].name}.` : 'Analise os arquivos anexados.'),
      anexos: enviando.map((a) => ({ nome: a.name, detalhe: tamanho(a.size) })) }), pensando);
    pensando.scrollIntoView({ block: 'end', behavior: 'smooth' });
    entrada.value = '';
    anexos = []; desenharChips();
    try {
      const arquivos = await Promise.all(enviando.map(async (a) => ({ nome: a.name, tipo: a.type, base64: await paraBase64(a) })));
      const r = await api('POST', `/api/ia/conversas/${conversa.id}/mensagens`, { texto, ...(arquivos.length ? { anexos: arquivos } : {}) });
      desenhar(r.conversa);
      if (r.erro) { erro.textContent = r.erro; erro.hidden = false; }
      estado.inicio = null; // o resumo do Início pode ter mudado (nota emitida)
    } catch (err) {
      pensando.remove();
      lista.lastElementChild?.remove();
      if (err instanceof ErroApi && err.dados?.codigo === 'IA_NAO_CONFIGURADA') { ir('/assistente/configurar'); return; }
      entrada.value = texto;
      anexos = enviando; desenharChips();
      erro.textContent = err.status === 0 ? 'Sem internet: o assistente precisa de conexão.' : err.status === 413 ? 'Arquivos grandes demais para enviar de uma vez.' : err.message;
      erro.hidden = false;
    } finally { enviar.disabled = false; entrada.disabled = false; entrada.focus(); }
  } }, clipe, seletor, entrada, microfone, enviar);

  // ---------------- troca rápida de modelo (lista vinda do provedor, com a chave guardada)
  const modeloRapido = h('select', { class: 'ia-modelo-rapido', 'aria-label': 'Modelo de IA', title: 'Trocar o modelo de IA' }, h('option', { value: config.modelo }, config.modelo));
  let modelosCarregados = false;
  async function carregarModelosRapido() {
    if (modelosCarregados || config.origem !== 'conta') return;
    modelosCarregados = true;
    try {
      const r = await api('POST', '/api/ia/modelos', { provedor: config.provedor, baseUrl: config.baseUrl || '' });
      const ids = r.modelos.length ? r.modelos : r.sugeridos.map((id) => ({ id, nome: id }));
      if (!ids.some((m) => m.id === config.modelo)) ids.unshift({ id: config.modelo, nome: config.modelo });
      modeloRapido.replaceChildren(...ids.map((m) => h('option', { value: m.id, selected: m.id === config.modelo }, m.nome && m.nome !== m.id ? `${m.nome} (${m.id})` : m.id)));
    } catch (e) { modelosCarregados = false; aviso(e.message, 6000); }
  }
  modeloRapido.addEventListener('focus', carregarModelosRapido);
  modeloRapido.addEventListener('pointerdown', carregarModelosRapido);
  modeloRapido.addEventListener('change', async () => {
    try {
      const r = await api('PUT', '/api/ia/config/modelo', { modelo: modeloRapido.value });
      config.modelo = r.config.modelo;
      aviso(`Modelo trocado para ${config.modelo}.`);
    } catch (e) { aviso(e.message, 6000); modeloRapido.value = config.modelo; }
  });

  const historico = h('details', { class: 'ia-historico' }, h('summary', {}, `Conversas (${conversas.length})`),
    h('ul', { class: 'lista' }, conversas.map((c) => h('li', {}, h('a', { class: 'item', href: `#/assistente/${encodeURIComponent(c.id)}`, 'aria-current': c.id === conversa.id ? 'true' : null },
      h('div', { class: 'item-corpo' }, h('div', { class: 'item-titulo' }, c.titulo), h('div', { class: 'item-sub' }, new Date(c.atualizadoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))))))));

  desenhar(conversa, { rolar: false });
  requestAnimationFrame(() => { (confirmacoes.lastElementChild || lista.lastElementChild)?.scrollIntoView({ block: 'end' }); entrada.focus({ preventScroll: true }); });
  const zonaSoltar = h('div', { class: 'ia-soltar', 'aria-hidden': 'true' }, icone(ICONE_CLIPE), h('strong', {}, 'Solte os arquivos para enviar ao assistente'), h('span', {}, 'Excel, CSV, PDF, Word, XML ou texto — até 3 MB'));
  let arrastando = 0;
  const temArquivos = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const telaNode = h('div', { class: 'ia-tela',
    ondragenter: (e) => { if (!temArquivos(e)) return; e.preventDefault(); arrastando++; telaNode.classList.add('arrastando'); },
    ondragover: (e) => { if (temArquivos(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } },
    ondragleave: () => { arrastando = Math.max(0, arrastando - 1); if (!arrastando) telaNode.classList.remove('arrastando'); },
    ondrop: (e) => { if (!temArquivos(e)) return; e.preventDefault(); arrastando = 0; telaNode.classList.remove('arrastando'); adicionar(e.dataTransfer.files); } });
  return {
    titulo: 'Assistente', aba: 'assistente',
    node: anexar(telaNode, zonaSoltar,
      h('div', { class: 'ia-cabecalho' }, titulo,
        h('div', { class: 'ia-cabecalho-acoes' },
          h('button', { class: 'btn btn-pequeno', type: 'button', onclick: async () => { const c = (await api('POST', '/api/ia/conversas', {})).conversa; lembrar(c.id); ir(`/assistente/${c.id}`); } }, icone(ICONES.mais), 'Nova conversa'),
          h('a', { class: 'btn btn-pequeno', href: '#/assistente/configurar' }, icone(ICONES.ajustes), 'Configurar'))),
      h('div', { class: 'suave ia-modo' }, h('span', {}, config.provedorNome), config.origem === 'conta' ? modeloRapido : h('span', {}, config.modelo),
        h('span', {}, config.emissaoAutonoma ? 'emite sozinho' : 'pede sua confirmação para emitir')),
      historico, lista, confirmacoes, erro, chips, form,
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

  const cProvedor = campo({ rotulo: 'Provedor de IA', valor: provedor, opcoes: provedores.map((p) => [p.id, p.nome]),
    onchange: (e) => { provedor = e.target.value; atualizar(true); } });
  // Modelo: lista vinda do provedor com a sua chave (ou as sugestões, até a lista chegar). "Outro" deixa digitar.
  const OUTRO = '__outro';
  const cModelo = campo({ rotulo: 'Modelo', ajuda: 'A lista vem da sua conta no provedor assim que a chave é informada.', valor: atual.modelo || '', opcoes: [[atual.modelo || '', atual.modelo || 'Escolha o modelo']],
    onchange: () => { cModeloLivre.hidden = cModelo.entrada.value !== OUTRO; if (!cModeloLivre.hidden) cModeloLivre.entrada.focus(); } });
  const cModeloLivre = campo({ rotulo: 'Nome exato do modelo', valor: '', atributos: { autocomplete: 'off', spellcheck: 'false', placeholder: 'ex.: claude-opus-5-5' } });
  cModeloLivre.hidden = true;
  const estadoModelos = h('p', { class: 'suave ia-estado-modelos', 'aria-live': 'polite' });
  const botaoModelos = h('button', { class: 'btn btn-pequeno', type: 'button', onclick: () => carregarModelos(true) }, icone(ICONES.atualizar), 'Carregar modelos da minha conta');
  function preencherModelos(lista, escolhido) {
    const vistos = new Set();
    const opcoes = [];
    for (const m of lista) {
      if (!m?.id || vistos.has(m.id)) continue;
      vistos.add(m.id);
      opcoes.push(h('option', { value: m.id }, m.nome && m.nome !== m.id ? `${m.nome} — ${m.id}${m.obsoleto ? ' (antigo)' : ''}` : m.id));
    }
    if (escolhido && !vistos.has(escolhido)) opcoes.unshift(h('option', { value: escolhido }, `${escolhido} (atual)`));
    opcoes.push(h('option', { value: OUTRO }, 'Outro modelo (digitar o nome)…'));
    cModelo.entrada.replaceChildren(...opcoes);
    cModelo.entrada.value = escolhido && (vistos.has(escolhido) || opcoes.length) ? escolhido : (lista[0]?.id || OUTRO);
    cModeloLivre.hidden = cModelo.entrada.value !== OUTRO;
  }
  let pedidoModelos = 0;
  async function carregarModelos(manual = false) {
    const chave = cChave.entrada.value.trim();
    const guardada = atual.chaveFinal && atual.provedor === provedor;
    if (!chave && !guardada) { if (manual) estadoModelos.textContent = 'Cole a chave de API para carregar os modelos da sua conta.'; return; }
    const meu = ++pedidoModelos;
    const escolhido = cModelo.entrada.value !== OUTRO ? cModelo.entrada.value : cModeloLivre.entrada.value.trim();
    estadoModelos.textContent = 'Carregando os modelos da sua conta…';
    botaoModelos.disabled = true;
    try {
      const r = await api('POST', '/api/ia/modelos', { provedor, chave, baseUrl: cBase.entrada.value.trim() });
      if (meu !== pedidoModelos) return;
      const lista = r.modelos.length ? r.modelos : r.sugeridos.map((id) => ({ id, nome: id }));
      preencherModelos(lista, escolhido || r.modeloPadrao);
      estadoModelos.textContent = r.modelos.length
        ? `${r.modelos.length} modelo(s) disponível(is) na sua conta. Escolha qual o assistente vai usar.`
        : 'O provedor não informou a lista: mostrando as sugestões. Você pode digitar outro em "Outro modelo".';
    } catch (e) {
      if (meu !== pedidoModelos) return;
      estadoModelos.textContent = `Não foi possível carregar os modelos: ${e.message}`;
    } finally { if (meu === pedidoModelos) botaoModelos.disabled = false; }
  }
  const cChave = campo({ rotulo: 'Chave de API', tipo: 'password', ajuda: '', valor: '',
    onchange: () => { if (cChave.entrada.value.trim().length >= 8) carregarModelos(); },
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
    if (trocou || !atual.modelo) {
      preencherModelos((p?.modelos || []).map((id) => ({ id, nome: id })), trocou ? p?.modeloPadrao : (atual.modelo || p?.modeloPadrao));
      estadoModelos.textContent = '';
    }
    if (trocou) carregarModelos();
    onde.textContent = p ? `Onde obter a chave: ${p.ondeObterChave}` : '';
    if (p?.exigeBaseUrl) { maisOpcoes.open = true; }
    cChave.entrada.placeholder = atual.chaveFinal && provedor === atual.provedor ? `Guardada (${atual.chaveFinal}). Deixe em branco para manter.` : 'Cole a chave aqui';
  }
  atualizar(false);
  if (atual.modelo) preencherModelos((porId[provedor]?.modelos || []).map((id) => ({ id, nome: id })), atual.modelo);
  carregarModelos(); // com a chave guardada, a lista da conta já aparece

  const erroGeral = h('p', { class: 'erro-campo', role: 'alert', hidden: true });
  const okTeste = h('p', { class: 'cartao cartao-ok', role: 'status', hidden: true });
  const salvar = h('button', { class: 'btn btn-primario', type: 'submit' }, 'Salvar');
  const corpo = () => ({ provedor, modelo: cModelo.entrada.value === OUTRO ? cModeloLivre.entrada.value.trim() : cModelo.entrada.value.trim(), chave: cChave.entrada.value.trim(), baseUrl: cBase.entrada.value.trim(), esforco: cEsforco.entrada.value,
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
      if (err instanceof ErroApi && err.dados?.campos) { if (err.dados.campos.baseUrl) maisOpcoes.open = true; mostrarErros({ provedor: cProvedor, modelo: cModelo.entrada.value === OUTRO ? cModeloLivre : cModelo, chave: cChave, baseUrl: cBase }, err.dados.campos); } else { erroGeral.textContent = err.message; erroGeral.hidden = false; }
      return false;
    }
  }
  const form = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    salvar.disabled = true;
    try { if (await gravar()) { aviso('Assistente configurado.'); ir('/assistente'); } } finally { salvar.disabled = false; }
  } }, cProvedor, onde, cChave, cModelo, cModeloLivre, h('div', { class: 'ia-carregar-modelos' }, botaoModelos, estadoModelos), cEsforco, modo, maisOpcoes, erroGeral, okTeste,
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

