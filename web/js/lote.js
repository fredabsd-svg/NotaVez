// Baixar em lote: XML, PDF (DANFSe) ou os dois, de todas as notas da lista, num único ZIP.
// O ZIP é montado no aparelho, nota a nota (poucas por vez), com barra de progresso e opção de
// cancelar. Assim não há limite de tamanho no servidor e uma nota com problema não derruba as outras.
import { h, plural, icone, ICONES, baixarArquivo, textoCsv } from './ui.js';
import { cabecalhosIdentidade } from './api.js';
import { criarZip } from './zip.js';

const SIMULTANEOS = 4;
let seq = 0;

function nomeDoServidor(r) {
  const cd = r.headers.get('content-disposition') || '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
  try { return m ? decodeURIComponent(m[1]).replace(/[\\/]/g, '_') : null; } catch { return null; }
}

// notas(): itens que têm XML (a tela já filtra); url(n, 'xml'|'pdf'); nomePadrao(n, tipo); rotulo(n) para a lista de erros;
// nomeZip(); planilha() → { cabecalho, linhas } da relação; observacao: o que fica de fora, quando for o caso.
export function baixarEmLote({ notas, url, nomePadrao, rotulo, nomeZip, planilha, observacao = '' }) {
  const grupo = `lote-formato-${++seq}`;
  const radio = (valor, texto, marcado = false) => h('label', { class: 'lote-opcao' },
    h('input', { type: 'radio', name: grupo, value: valor, checked: marcado }), h('span', {}, texto));
  const formatos = h('fieldset', { class: 'lote-formatos' }, h('legend', {}, 'Arquivos'),
    h('div', {}, radio('xml', 'XML'), radio('pdf', 'PDF (DANFSe)'), radio('ambos', 'XML e PDF', true)));
  const comPlanilha = h('input', { type: 'checkbox', checked: true });
  const resumo = h('p', { class: 'suave' });
  const barra = h('progress', { max: 1, value: 0 });
  const estado = h('p', { class: 'lote-estado', role: 'status', 'aria-live': 'polite' });
  const progresso = h('div', { class: 'lote-progresso', hidden: true }, barra, estado);
  const iniciar = h('button', { class: 'btn btn-primario', type: 'button' }, icone(ICONES.baixar), 'Baixar ZIP');
  const cancelar = h('button', { class: 'btn', type: 'button', hidden: true }, 'Cancelar');
  const fechar = h('button', { class: 'lote-fechar', type: 'button', 'aria-label': 'Fechar' }, '×');
  const painel = h('section', { class: 'cartao lote', hidden: true, 'aria-label': 'Baixar em lote' },
    h('div', { class: 'lote-topo' }, h('strong', {}, 'Baixar em lote (ZIP)'), fechar),
    resumo, formatos,
    h('label', { class: 'lote-opcao' }, comPlanilha, h('span', {}, 'Incluir a relação das notas em planilha (CSV)')),
    h('div', { class: 'lote-acoes' }, iniciar, cancelar), progresso);
  const botao = h('button', { class: 'btn btn-pequeno', type: 'button', 'aria-expanded': 'false', title: 'Baixa XML e/ou PDF de todas as notas da lista num arquivo ZIP' },
    icone(ICONES.baixar), 'Baixar em lote');

  let rodando = null;
  const abrir = (sim) => {
    painel.hidden = !sim;
    botao.setAttribute('aria-expanded', String(sim));
    if (sim) { atualizar(); painel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  };
  botao.addEventListener('click', () => abrir(painel.hidden));
  fechar.addEventListener('click', () => { rodando?.cancelar(); abrir(false); });
  cancelar.addEventListener('click', () => rodando?.cancelar());

  function atualizar() {
    const n = notas().length;
    botao.hidden = !n;
    if (!n && !rodando) painel.hidden = true;
    if (!rodando) resumo.textContent = `${plural(n, 'nota', 'notas')} da lista atual.${observacao ? ` ${observacao}` : ''}`;
  }

  iniciar.addEventListener('click', async () => {
    const lista = notas();
    if (!lista.length) return;
    if (!navigator.onLine) { estado.textContent = 'Sem internet: o download em lote precisa de conexão.'; progresso.hidden = false; return; }
    const formato = formatos.querySelector('input:checked')?.value || 'ambos';
    const tipos = formato === 'ambos' ? ['xml', 'pdf'] : [formato];
    const tarefas = lista.flatMap((n) => tipos.map((tipo) => [n, tipo]));
    const zip = criarZip();
    const falhas = [];
    const ctrl = new AbortController();
    let feitos = 0;
    let proxima = 0;
    let cancelado = false;
    rodando = { cancelar: () => { cancelado = true; ctrl.abort(); } };
    const aoSair = () => rodando?.cancelar();
    window.addEventListener('hashchange', aoSair, { once: true });
    iniciar.disabled = true;
    cancelar.hidden = false;
    progresso.hidden = false;
    barra.max = tarefas.length;
    barra.value = 0;
    const mostrar = () => { barra.value = feitos; estado.textContent = `Baixando ${feitos} de ${tarefas.length} arquivos…`; };
    mostrar();

    async function trabalhar() {
      while (!cancelado && proxima < tarefas.length) {
        const [n, tipo] = tarefas[proxima++];
        try {
          const r = await fetch(url(n, tipo), { credentials: 'same-origin', headers: cabecalhosIdentidade(), signal: ctrl.signal });
          if (!r.ok) throw new Error((await r.json().catch(() => null))?.erro || `erro ${r.status}`);
          const nome = nomeDoServidor(r) || nomePadrao(n, tipo);
          const pasta = tipos.length > 1 ? `${tipo.toUpperCase()}/` : '';
          await zip.adicionar(`${pasta}${nome}`, new Uint8Array(await r.arrayBuffer()), { comprimir: tipo === 'xml' });
        } catch (e) {
          if (cancelado) return;
          falhas.push(`${rotulo(n)} — ${tipo === 'xml' ? 'XML' : 'PDF'}: ${e.message}`);
        }
        feitos += 1;
        mostrar();
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(SIMULTANEOS, tarefas.length) }, trabalhar));
      if (cancelado) { estado.textContent = 'Download cancelado. Nenhum arquivo foi salvo.'; return; }
      if (comPlanilha.checked) {
        const p = planilha();
        await zip.adicionar('relacao-das-notas.csv', textoCsv(p.cabecalho, p.linhas));
      }
      if (falhas.length) await zip.adicionar('ERROS.txt', `Arquivos que não puderam ser baixados agora (tente de novo mais tarde):\r\n\r\n${falhas.join('\r\n')}\r\n`);
      const ok = tarefas.length - falhas.length;
      if (!ok) { estado.textContent = `Nenhum arquivo pôde ser baixado agora. ${falhas[0] || ''}`; return; }
      const nome = nomeZip();
      baixarArquivo(nome, zip.gerar(), 'application/zip');
      estado.textContent = falhas.length
        ? `ZIP salvo (${nome}) com ${plural(ok, 'arquivo', 'arquivos')}. ${plural(falhas.length, 'arquivo não veio', 'arquivos não vieram')}: veja ERROS.txt dentro do ZIP.`
        : `Pronto: ${plural(ok, 'arquivo', 'arquivos')} em ${nome}.`;
    } finally {
      window.removeEventListener('hashchange', aoSair);
      rodando = null;
      iniciar.disabled = false;
      cancelar.hidden = true;
    }
  });

  atualizar();
  return { botao, painel, atualizar };
}
