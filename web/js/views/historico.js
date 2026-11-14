import { h, anexar, moeda, data, dataHora, situacaoSelo, campo, nomeMes, vazio, icone, ICONES, plural, aviso, baixarCsv, valorCsv } from '../ui.js';
import { periodoDaRota, paramsDaRota, paramsDaApi, dentroDoPeriodo, temPeriodo, rotuloPeriodo, periodoNoArquivo, filtroPeriodo } from '../periodo.js';
import { baixarEmLote } from '../lote.js';
import { api } from '../api.js';
import { comCache, rascunhosLocais } from '../store.js';
import { ir, estado } from '../app.js';
import { botaoImportarXml } from './assistida.js';
import { rascunhoEmBranco } from '../rascunho.js';

const FILTROS = [['', 'Todas'], ['emitida', 'Emitidas'], ['pendente', 'Pendentes'], ['rejeitada', 'Rejeitadas'], ['rascunho', 'Rascunhos']];
const empresaEmTestes = () => estado.conta?.empresaAmbiente === 'producao_restrita';

// Uma nota numa linha: cliente e valor em destaque; número, competência e situação como apoio.
// No computador as mesmas partes viram colunas alinhadas (ver .linha-nota no CSS).
export function linhaNota(n, { compacta = false } = {}) {
  // Só nota já enviada tem ambiente; avisa quando ele não é o ambiente atual da empresa.
  const outroAmbiente = n.ambiente && !!n.homologacao !== empresaEmTestes() ? (n.homologacao ? 'testes' : 'produção') : null;
  return h('a', { class: `linha-nota${compacta ? ' compacta' : ''}${n.situacao === 'cancelada' ? ' cancelada' : ''}`, href: n.situacao === 'rascunho' && !n.erros?.length ? `#/nota/${n.id}` : `#/notas/${n.id}` },
    partesDaLinha({ cliente: n.clienteNome || 'Sem cliente', numero: n.nNfse ? `NFS-e nº ${n.nNfse}` : '',
      competencia: [data(n.competencia), outroAmbiente].filter(Boolean).join(' · '), situacao: situacaoSelo(n), valor: moeda(n.valor) }));
}

// Duas linhas no celular (cliente + valor; número · competência + situação); no computador, uma coluna para cada parte.
// `documento` (CNPJ/CPF do fornecedor, nas notas tomadas) acrescenta uma coluna: a linha leva a classe "com-doc".
export const partesDaLinha = ({ cliente, documento, numero, competencia, situacao, valor }) => [
  h('span', { class: 'ln-l1' }, h('span', { class: 'ln-cliente' }, cliente), h('span', { class: 'ln-valor' }, valor)),
  h('span', { class: 'ln-l2' },
    h('span', { class: 'ln-meta' }, documento === undefined ? null : h('span', { class: 'ln-doc' }, documento),
      h('span', { class: 'ln-num' }, numero), h('span', { class: 'ln-comp' }, competencia)),
    h('span', { class: 'ln-sit' }, situacao))];

// O que a busca na Receita (ADN) trouxe, numa frase. Serve a Notas e a Notas tomadas: é a mesma busca.
export function resumoDaBusca(r) {
  const cancelamentos = (r.canceladas || 0) + (r.emitidasCanceladas || 0);
  const partes = [
    r.emitidas ? `${plural(r.emitidas, 'nota emitida fora do app entrou', 'notas emitidas fora do app entraram')} em Notas` : null,
    r.novas ? plural(r.novas, 'nota tomada nova', 'notas tomadas novas') : null,
    cancelamentos ? plural(cancelamentos, 'cancelamento', 'cancelamentos') : null,
  ].filter(Boolean);
  return partes.length ? `${partes.join(' · ')}.` : 'Nada de novo na Receita desde a última busca.';
}

// Cabeçalho das colunas (só no computador; cada linha já se lê sozinha, por isso fica fora da leitura de tela).
export const cabecalhoNotas = () => h('div', { class: 'cab-notas', 'aria-hidden': 'true' },
  h('span', {}, 'Cliente'), h('span', { class: 'ln-num' }, 'Número'), h('span', {}, 'Competência'), h('span', {}, 'Situação'), h('span', {}, 'Valor'));

// Lista em CSV para o contador (também vai dentro do ZIP do download em lote).
const CSV_NOTAS = ['Competência', 'Número da NFS-e', 'Cliente', 'Situação', 'Valor (R$)', 'Chave de acesso', 'Ambiente'];
const linhasCsv = (lista) => lista.map((n) => [data(n.competencia), n.nNfse || '', n.clienteNome || '', n.rotulo || n.situacao, valorCsv(n.valor), n.chaveAcesso || '', n.ambiente ? (n.homologacao ? 'Testes' : 'Produção') : '']);
function exportarCsv(lista, nomeArquivo) {
  baixarCsv(nomeArquivo, CSV_NOTAS, linhasCsv(lista));
}
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

export async function tela(_, query) {
  const filtro = query.situacao || '';
  const periodo = periodoDaRota(query);
  const { mes } = periodo;
  const comPeriodo = temPeriodo(periodo);
  // Competência (mês ou período de/até) filtrada no servidor: com centenas de notas, o período escolhido vem completo.
  const qs = new URLSearchParams({ ...(filtro ? { situacao: filtro } : {}), ...paramsDaApi(periodo) }).toString();
  const { notas, limitado, meses: mesesServidor, sincronizacao, temCertificado, canceladas, porProcuracao } = await comCache(`notas:${qs}`, () => api('GET', `/api/notas${qs ? `?${qs}` : ''}`));
  const rota = (situacao, per) => { const p = new URLSearchParams({ ...(situacao ? { situacao } : {}), ...paramsDaRota(per) }).toString(); return `/notas${p ? `?${p}` : ''}`; };
  // Rascunhos que ainda não chegaram à conta (feitos sem internet): entram em "Todas" e "Rascunhos" e seguem a competência escolhida.
  const soAparelho = !filtro || filtro === 'rascunho'
    ? (await rascunhosLocais()).filter((r) => !r.noServidor && !rascunhoEmBranco(r) && (!comPeriodo || dentroDoPeriodo(periodo, r.rascunho.competencia)))
    : [];

  // Competência (mês) e busca: o contador fecha o mês olhando a lista e o total.
  const meses = mesesServidor || [...new Set(notas.map((n) => String(n.competencia || '').slice(0, 7)).filter(Boolean))].sort().reverse();
  if (mes && !meses.includes(mes)) meses.unshift(mes);
  let termo = '';
  let visiveis = notas;
  const resumo = h('p', { class: 'resumo-lista', role: 'status' });
  const corpo = h('div', {});
  const blocoLocais = h('div', {});
  // Total só do ambiente atual da empresa: notas de testes não somam com as de produção.
  const totalEmitido = (lista) => {
    const emitidas = lista.filter((n) => n.situacao === 'emitida' && !!n.homologacao === empresaEmTestes());
    return { qtd: emitidas.length, total: emitidas.reduce((soma, n) => soma + Math.round(Number(n.valor || 0) * 100), 0) / 100 };
  };
  const mostrar = () => {
    const t = termo.toLowerCase().trim();
    visiveis = notas.filter((n) => (!t || (n.clienteNome || '').toLowerCase().includes(t) || (n.nNfse || '').includes(t) || (n.chaveAcesso || '').includes(t.replace(/\s/g, ''))));
    // A busca vale também para os rascunhos só do aparelho.
    const locais = soAparelho.filter((r) => !t || (r.meta?.cliente?.nome || '').toLowerCase().includes(t));
    blocoLocais.replaceChildren(...(locais.length ? [h('section', { class: 'grupo-mes' }, h('div', { class: 'secao-titulo' }, h('h3', {}, 'Só neste aparelho (sem internet)')),
      h('ul', { class: 'lista' }, locais.map((r) => h('li', {}, h('a', { class: 'linha-nota', href: `#/nota/${r.id}` },
        partesDaLinha({ cliente: r.meta?.cliente?.nome || 'Rascunho sem cliente', numero: '', competencia: r.rascunho.competencia ? data(r.rascunho.competencia) : '',
          situacao: h('span', { class: 'situacao s-rascunho' }, 'Rascunho · não emitida'), valor: moeda(r.rascunho.valor) }))))))] : []));
    // Um bloco por competência, da mais recente para a mais antiga; dentro do mês, a ordem do servidor (última alteração).
    const porMes = new Map();
    for (const n of visiveis) { const m = String(n.competencia || '').slice(0, 7); if (!porMes.has(m)) porMes.set(m, []); porMes.get(m).push(n); }
    const grupos = [...porMes.entries()].sort(([a], [b]) => (a === b ? 0 : !a ? -1 : !b ? 1 : b.localeCompare(a)));
    corpo.replaceChildren();
    if (grupos.length) corpo.append(cabecalhoNotas());
    for (const [m, lista] of grupos) {
      const e = totalEmitido(lista);
      corpo.append(h('section', { class: 'grupo-mes' },
        h('div', { class: 'secao-titulo' }, h('h3', {}, m ? nomeMes(m) : 'Sem competência'),
          // Com a lista cortada (mais de 200), o total do mês poderia sair incompleto: fica só a contagem.
          h('span', { class: 'secao-extra' }, e.qtd && !limitado ? `${moeda(e.total)} em ${plural(e.qtd, 'emitida', 'emitidas')}` : plural(lista.length, 'nota', 'notas'))),
        h('ul', { class: 'lista' }, lista.map((n) => h('li', {}, linhaNota(n))))));
    }
    if (!visiveis.length && !locais.length) {
      corpo.append(notas.length || comPeriodo || filtro || t
        ? vazio({ icone: ICONES.busca, titulo: 'Nenhuma nota com estes filtros', texto: 'Mude a situação, o período ou o texto da busca.',
          acoes: [h('a', { class: 'btn', href: '#/notas' }, 'Limpar filtros')] })
        : vazio({ titulo: 'Suas notas aparecem aqui', texto: 'Emitidas, pendentes, rejeitadas e rascunhos desta empresa ficam nesta lista, separados por mês.',
          acoes: [h('a', { class: 'btn btn-primario', href: '#/nova' }, icone(ICONES.mais), 'Nova nota')] }));
    }
    const e = totalEmitido(visiveis);
    resumo.replaceChildren(); anexar(resumo, h('span', {}, h('strong', {}, String(visiveis.length)), visiveis.length === 1 ? ' nota' : ' notas'),
      e.qtd ? h('span', {}, mes ? 'Emitidas no mês: ' : comPeriodo ? 'Emitidas no período: ' : 'Emitidas: ', h('strong', {}, moeda(e.total))) : null,
      limitado ? h('span', {}, `Mostrando as ${notas.length} mais recentes: escolha o mês ou o período para ver as demais.`) : null);
    exportar.hidden = !visiveis.length;
    lote?.atualizar();
  };
  const exportar = h('button', { class: 'btn btn-pequeno', type: 'button', title: 'Baixa a lista mostrada em planilha (CSV), para você ou para o contador',
    onclick: () => {
      exportarCsv(visiveis, `notas-${periodoNoArquivo(periodo)}${filtro ? `-${filtro}` : ''}.csv`);
      aviso(`${plural(visiveis.length, 'nota exportada', 'notas exportadas')}.${limitado ? ' A lista traz só as mais recentes: escolha o mês ou o período para exportar tudo.' : ''}`, limitado ? 8000 : 4000);
    } }, icone(ICONES.baixar), 'Exportar CSV');
  // XML e PDF de todas as notas da lista num ZIP. Só emitidas e canceladas têm XML oficial.
  const comXml = () => visiveis.filter((n) => ['emitida', 'cancelada'].includes(n.situacao) && n.chaveAcesso);
  const lote = !filtro || ['emitida', 'cancelada'].includes(filtro) ? baixarEmLote({
    notas: comXml,
    url: (n, tipo) => `/api/notas/${encodeURIComponent(n.id)}/${tipo === 'xml' ? 'xml' : 'danfse?baixar=1'}`,
    nomePadrao: (n, tipo) => (tipo === 'xml' ? `NFSe-${n.chaveAcesso}.xml` : `DANFSe-${n.chaveAcesso}.pdf`),
    rotulo: (n) => `NFS-e nº ${n.nNfse || '?'} — ${n.clienteNome || 'sem cliente'} — chave ${n.chaveAcesso}`,
    nomeZip: () => `notas-emitidas_${soDigitos(estado.conta?.empresaDocumentoFormatado) || 'empresa'}_${periodoNoArquivo(periodo)}${limitado ? '_mais-recentes' : ''}.zip`,
    planilha: () => ({ cabecalho: CSV_NOTAS, linhas: linhasCsv(comXml()) }),
    observacao: `Só emitidas e canceladas têm XML: rascunhos, pendentes e rejeitadas ficam de fora.${limitado ? ' A lista traz só as mais recentes: escolha o mês ou o período para baixar tudo.' : ''}`,
  }) : null;
  mostrar();
  // Mês, atalho (últimos 3 meses, este ano, ano passado) ou datas digitadas.
  const { seletor: seletorMes, datas: datasPeriodo } = filtroPeriodo({ meses, periodo, todas: 'Todos os meses', aoMudar: (p) => ir(rota(filtro, p), { substituir: true }) });
  // Com certificado (da empresa ou do escritório), as notas emitidas fora do app vêm da Receita.
  const buscarNaReceita = h('button', { class: 'link', type: 'button', onclick: async () => {
    buscarNaReceita.disabled = true;
    buscarNaReceita.textContent = 'Consultando a Receita…';
    try {
      aviso(resumoDaBusca(await api('POST', '/api/notas/sincronizar', {})), 6000);
      window.dispatchEvent(new HashChangeEvent('hashchange')); // recarrega a lista
    } catch (e) {
      aviso(e.status === 0 ? 'Sem internet: a busca na Receita precisa de conexão.' : e.message, 7000);
      buscarNaReceita.disabled = false;
      buscarNaReceita.textContent = 'Buscar na Receita agora';
    }
  } }, 'Buscar na Receita agora');
  // Recusa da Receita (por procuração: procuração não vigente) fica à vista até uma consulta dar certo.
  const linhaReceita = temCertificado ? h('p', { class: 'resumo-lista' },
    sincronizacao?.recusadaEm
      ? h('span', { class: 'erro-campo', role: 'alert' }, `A Receita recusou a consulta de ${dataHora(sincronizacao.recusadaEm)}${sincronizacao.recusaMotivo ? `: ${sincronizacao.recusaMotivo}` : '.'}${porProcuracao ? ' Confira a procuração desta empresa.' : ''}`)
      : h('span', {}, sincronizacao?.sincronizadoEm ? `Receita consultada em ${dataHora(sincronizacao.sincronizadoEm)}${porProcuracao ? ', por procuração' : ''}.` : 'A Receita ainda não foi consultada para esta empresa.'),
    buscarNaReceita) : null;
  const busca = campo({ rotulo: 'Pesquisar notas', rotuloOculto: true,
    atributos: { type: 'search', autocomplete: 'off', placeholder: 'Buscar cliente, número ou chave' }, oninput: (e) => { termo = e.target.value; mostrar(); } });
  busca.classList.add('busca-icone');

  // "Canceladas" só aparece para quem tem nota cancelada (vinda da Receita).
  const abas = h('div', { class: 'filtro-abas', role: 'group', 'aria-label': 'Filtrar por situação' },
    [...FILTROS, ...(canceladas || filtro === 'cancelada' ? [['cancelada', 'Canceladas']] : [])].map(([v, t]) => h('button', {
      type: 'button', 'aria-pressed': String(v === filtro), onclick: () => ir(rota(v, periodo), { substituir: true }),
    }, t)));
  // No celular as abas rolam de lado: a escolhida fica à vista.
  requestAnimationFrame(() => {
    const ativa = abas.querySelector('[aria-pressed="true"]');
    if (ativa && abas.scrollWidth > abas.clientWidth) abas.scrollLeft = ativa.offsetLeft - (abas.clientWidth - ativa.offsetWidth) / 2;
  });

  return {
    titulo: 'Notas', aba: 'notas',
    node: h('div', {},
      abas,
      h('div', { class: 'barra-lista' }, busca, seletorMes, h('div', { class: 'barra-acoes' }, exportar, lote?.botao)),
      datasPeriodo,
      lote?.painel,
      comPeriodo && !mes ? h('h3', { class: 'titulo-mes' }, rotuloPeriodo(periodo)) : null,
      resumo,
      linhaReceita,
      blocoLocais,
      corpo,
      // Notas emitidas direto no Emissor Nacional também entram no histórico pelo XML.
      h('div', { class: 'cartao' }, h('p', { class: 'suave' }, temCertificado
        ? 'Notas emitidas fora do app (no Emissor Nacional, por exemplo) entram aqui sozinhas: o app consulta a Receita sozinho, de hora em hora, e também quando você toca em "Buscar na Receita agora". Se preferir, traga o XML.'
        : 'Emitiu uma nota direto no Emissor Nacional? Traga o XML para ter o histórico, o PDF e poder clonar. Com o certificado enviado, essas notas passam a entrar sozinhas.'),
        botaoImportarXml({ texto: 'Importar XML', classe: 'btn' }))),
  };
}
