import { h, anexar, moeda, data, situacaoSelo, campo } from '../ui.js';
import { api } from '../api.js';
import { comCache, rascunhosLocais } from '../store.js';
import { ir, estado } from '../app.js';
import { botaoImportarXml } from './assistida.js';
import { rascunhoEmBranco } from '../rascunho.js';

const FILTROS = [['', 'Todas'], ['emitida', 'Emitidas'], ['pendente', 'Pendentes'], ['rejeitada', 'Rejeitadas'], ['rascunho', 'Rascunhos']];

export async function tela(_, query) {
  const filtro = query.situacao || '';
  const mes = /^\d{4}-\d{2}$/.test(query.mes || '') ? query.mes : '';
  // Competência filtrada no servidor: com centenas de notas, o mês escolhido vem completo.
  const qs = new URLSearchParams({ ...(filtro ? { situacao: filtro } : {}), ...(mes ? { competencia: mes } : {}) }).toString();
  const { notas, limitado, meses: mesesServidor } = await comCache(`notas:${qs}`, () => api('GET', `/api/notas${qs ? `?${qs}` : ''}`));
  const rota = (situacao, m) => { const p = new URLSearchParams({ ...(situacao ? { situacao } : {}), ...(m ? { mes: m } : {}) }).toString(); return `/notas${p ? `?${p}` : ''}`; };
  const soAparelho = (await rascunhosLocais()).filter((r) => !r.noServidor && !rascunhoEmBranco(r));
  const ul = h('ul', { class: 'lista duas-colunas' });
  const item = (n) => h('li', {}, h('a', { class: 'item', href: n.situacao === 'rascunho' && !n.erros?.length ? `#/nota/${n.id}` : `#/notas/${n.id}` },
    h('div', { class: 'item-corpo' },
      h('div', { class: 'item-titulo' }, n.clienteNome || 'Sem cliente'),
      h('div', { class: 'item-sub item-sub-quebra' }, [n.nNfse ? `NFS-e nº ${n.nNfse}` : null, data(n.competencia), n.homologacao !== (estado.conta?.empresaAmbiente === 'producao_restrita') ? (n.homologacao ? 'Testes' : 'Produção') : null].filter(Boolean).join(' · ')),
      h('div', { style: 'margin-top:6px' }, situacaoSelo(n))),
    h('div', { class: 'item-valor' }, moeda(n.valor))));

  // Competência (mês) e busca: o contador fecha o mês olhando a lista e o total.
  const meses = mesesServidor || [...new Set(notas.map((n) => String(n.competencia || '').slice(0, 7)).filter(Boolean))].sort().reverse();
  if (mes && !meses.includes(mes)) meses.unshift(mes);
  let termo = '';
  const resumo = h('p', { class: 'resumo-lista', role: 'status' });
  const mostrar = () => {
    const t = termo.toLowerCase().trim();
    const lista = notas.filter((n) => (!t || (n.clienteNome || '').toLowerCase().includes(t) || (n.nNfse || '').includes(t) || (n.chaveAcesso || '').includes(t.replace(/\s/g, ''))));
    ul.replaceChildren(...lista.map(item));
    if (!lista.length) {
      ul.append(h('li', { class: 'suave' }, notas.length || mes || filtro ? 'Nenhuma nota com estes filtros.' : 'Nenhuma nota aqui ainda.'));
      if (mes || t || filtro) ul.append(h('li', {}, h('a', { class: 'btn btn-pequeno', href: '#/notas' }, 'Limpar filtros')));
    }
    // Total só do ambiente atual da empresa: notas de testes não somam com as de produção.
    const testes = estado.conta?.empresaAmbiente === 'producao_restrita';
    const emitidas = lista.filter((n) => n.situacao === 'emitida' && !!n.homologacao === testes);
    const total = emitidas.reduce((soma, n) => soma + Number(n.valor || 0), 0);
    resumo.replaceChildren(); anexar(resumo, h('span', {}, h('strong', {}, String(lista.length)), lista.length === 1 ? ' nota' : ' notas'),
      emitidas.length ? h('span', {}, mes ? 'Emitidas no mês: ' : 'Emitidas: ', h('strong', {}, moeda(total))) : null,
      limitado ? h('span', {}, `Mostrando as ${notas.length} mais recentes: escolha a competência para ver as demais.`) : null);
  };
  mostrar();
  const nomeMes = (m) => { const [a, mm] = m.split('-'); return new Date(Number(a), Number(mm) - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); };
  const seletorMes = meses.length > 1 || mes ? campo({
    rotulo: 'Competência', tipo: 'select', valor: mes,
    opcoes: [['', 'Todos os meses'], ...meses.map((m) => [m, nomeMes(m)])],
    onchange: (e) => ir(rota(filtro, e.target.value), { substituir: true }),
  }) : null;

  return {
    titulo: 'Notas', aba: 'notas',
    node: h('div', {},
      h('p', { class: 'suave' }, 'Emitidas, pendentes, rejeitadas e rascunhos desta empresa.'),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Filtrar por situação' }, FILTROS.map(([v, t]) => h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(v === filtro), onclick: () => ir(rota(v, mes), { substituir: true }),
      }, t))),
      h('div', { class: 'filtros-linha' }, seletorMes,
        campo({ rotulo: 'Pesquisar', ajuda: 'Cliente, número ou chave de acesso', atributos: { type: 'search', autocomplete: 'off' }, oninput: (e) => { termo = e.target.value; mostrar(); } })),
      resumo,
      soAparelho.length && (!filtro || filtro === 'rascunho')
        ? h('section', {}, h('h3', {}, 'Só neste aparelho (sem internet)'),
          h('ul', { class: 'lista' }, soAparelho.map((r) => h('li', {}, h('a', { class: 'item', href: `#/nota/${r.id}` },
            h('div', { class: 'item-corpo' }, h('div', { class: 'item-titulo' }, r.meta?.cliente?.nome || 'Rascunho sem cliente'),
              h('div', { style: 'margin-top:6px' }, h('span', { class: 'situacao s-rascunho' }, 'Rascunho · não emitida'))),
            h('div', { class: 'item-valor' }, moeda(r.rascunho.valor)))))))
        : null,
      ul,
      // Notas emitidas direto no Emissor Nacional também entram no histórico pelo XML.
      h('div', { class: 'cartao' }, h('p', { class: 'suave', style: 'margin-top:0' }, 'Emitiu uma nota direto no Emissor Nacional? Traga o XML para ter o histórico, o PDF e poder clonar.'),
        botaoImportarXml({ texto: 'Importar XML', classe: 'btn' }))),
  };
}
