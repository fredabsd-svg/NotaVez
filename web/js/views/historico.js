import { h, moeda, data, situacaoSelo, campo } from '../ui.js';
import { api } from '../api.js';
import { comCache, rascunhosLocais } from '../store.js';
import { ir } from '../app.js';

const FILTROS = [['', 'Todas'], ['emitida', 'Emitidas'], ['pendente', 'Pendentes'], ['rejeitada', 'Rejeitadas'], ['rascunho', 'Rascunhos']];

export async function tela(_, query) {
  const filtro = query.situacao || '';
  const { notas } = await comCache(`notas:${filtro}`, () => api('GET', `/api/notas${filtro ? `?situacao=${filtro}` : ''}`));
  const soAparelho = (await rascunhosLocais()).filter((r) => !r.noServidor);
  const ul = h('ul', { class: 'lista' });
  const item = (n) => h('li', {}, h('a', { class: 'item', href: n.situacao === 'rascunho' && !n.erros?.length ? `#/nota/${n.id}` : `#/notas/${n.id}` },
    h('div', { class: 'item-corpo' },
      h('div', { class: 'item-titulo' }, n.clienteNome || 'Sem cliente'),
      h('div', { class: 'item-sub' }, [n.nNfse ? `NFS-e nº ${n.nNfse}` : null, data(n.competencia), n.homologacao ? 'teste' : null].filter(Boolean).join(' · ')),
      h('div', { style: 'margin-top:6px' }, situacaoSelo(n))),
    h('div', { class: 'item-valor' }, moeda(n.valor))));

  const mostrar = (q = '') => {
    const t = q.toLowerCase().trim();
    const lista = notas.filter((n) => !t || (n.clienteNome || '').toLowerCase().includes(t) || (n.nNfse || '').includes(t) || (n.chaveAcesso || '').includes(t.replace(/\s/g, '')));
    ul.replaceChildren(...lista.map(item));
    if (!lista.length) ul.append(h('li', { class: 'suave' }, 'Nenhuma nota aqui.'));
  };
  mostrar();

  return {
    titulo: 'Notas', aba: 'notas',
    node: h('div', {},
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Filtrar por situação' }, FILTROS.map(([v, t]) => h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(v === filtro), onclick: () => ir(v ? `/notas?situacao=${v}` : '/notas', { substituir: true }),
      }, t))),
      campo({ rotulo: 'Pesquisar', ajuda: 'Cliente, número ou chave de acesso', atributos: { type: 'search', autocomplete: 'off' }, oninput: (e) => mostrar(e.target.value) }),
      soAparelho.length && (!filtro || filtro === 'rascunho')
        ? h('section', {}, h('h3', {}, 'Só neste aparelho (sem internet)'),
          h('ul', { class: 'lista' }, soAparelho.map((r) => h('li', {}, h('a', { class: 'item', href: `#/nota/${r.id}` },
            h('div', { class: 'item-corpo' }, h('div', { class: 'item-titulo' }, r.meta?.cliente?.nome || 'Rascunho sem cliente'),
              h('div', { style: 'margin-top:6px' }, h('span', { class: 'situacao s-rascunho' }, 'Rascunho · não emitida'))),
            h('div', { class: 'item-valor' }, moeda(r.rascunho.valor)))))))
        : null,
      ul),
  };
}
