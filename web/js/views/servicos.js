import { h, campo, mostrarErros, aviso, moeda, icone, ICONES, buscaComSugestoes } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { comCache, buscarServicoNacional, servicoNacionalPorCodigo } from '../store.js';
import { aplicar } from '../rascunho.js';
import { ir } from '../app.js';

export async function usarNaNota(notaId, s, { manterDescricao = false, descricaoAtual = '' } = {}) {
  const nac = await servicoNacionalPorCodigo(s.cTribNac);
  await aplicar(notaId, {
    servicoId: s.id || null, cTribNac: s.cTribNac, cTribMun: s.cTribMun || null, cNBS: s.cNBS || null, cIndOp: null, cClassTrib: null,
    ...(manterDescricao && descricaoAtual ? {} : { descricao: s.descricao || '' }),
    ...(s.valorPadrao ? { valor: s.valorPadrao } : {}),
  }, { servicoNacional: nac, servicoApelido: s.apelido || null });
}

export async function lista(_, query) {
  const para = query.para;
  const { servicos } = await comCache('servicos', () => api('GET', '/api/servicos'));
  const itens = servicos.map((s) => h('li', {}, h('button', {
    class: 'item', type: 'button',
    onclick: async () => {
      if (para) { await usarNaNota(para, s); ir(`/nota/${para}`, { substituir: true }); } else ir(`/servicos/${s.id}`);
    },
  },
  h('div', { class: 'item-corpo' },
    h('div', { class: 'item-titulo' }, s.apelido),
    h('div', { class: 'item-sub' }, `${s.cTribNac} · ${s.descricao}`)),
  s.valorPadrao ? h('div', { class: 'item-valor' }, moeda(s.valorPadrao)) : null)));
  return {
    titulo: para ? 'Escolher serviço' : 'Serviços salvos', aba: 'inicio', voltar: true,
    node: h('div', {},
      h('p', { class: 'suave' }, 'Guarde os serviços que você presta com frequência. Na nota, é só escolher.'),
      itens.length ? h('ul', { class: 'lista' }, itens) : h('p', {}, 'Nenhum serviço salvo ainda.'),
      h('div', { class: 'rodape-fixo' }, h('a', { class: 'btn btn-primario', href: `#/servicos/novo${para ? `?para=${para}` : ''}` }, icone(ICONES.mais), 'Novo serviço'))),
  };
}

export async function formulario({ id }, query) {
  const para = query.para;
  let s = { apelido: '', cTribNac: '', descricao: '', valorPadrao: '', cTribMun: '', cNBS: '' };
  if (id) s = (await api('GET', `/api/servicos/${id}`)).servico;
  let nacional = s.cTribNac ? await servicoNacionalPorCodigo(s.cTribNac) : null;

  const apelido = campo({ rotulo: 'Nome curto', ajuda: 'Só para você reconhecer. Ex.: "Manutenção mensal"', valor: s.apelido, atributos: { maxlength: 80, required: true } });
  const escolhido = h('p', { class: 'suave', 'aria-live': 'polite' });
  const mostrarEscolhido = () => {
    escolhido.replaceChildren(nacional ? h('span', {}, 'Escolhido: ', h('strong', {}, `${nacional.codigo} — ${nacional.descricao}`)) : 'Nenhum código escolhido.');
    if (nacional?.grupoExigido) escolhido.append(h('span', { class: 'erro-campo', style: 'display:block' }, 'Atenção: este código exige dados de obra/evento, ainda não suportados. Use o Emissor Nacional para ele.'));
  };
  mostrarEscolhido();
  const codigo = buscaComSugestoes({
    rotulo: 'Tipo de serviço (lista nacional)',
    ajuda: 'Digite uma palavra (ex.: "manutenção", "design") ou o código',
    placeholder: 'Buscar na lista nacional',
    buscar: buscarServicoNacional,
    formatar: (x) => `${x.codigo} — ${x.descricao}`,
    aoEscolher: (x, c) => {
      nacional = x;
      c.entrada.value = '';
      mostrarEscolhido();
      if (!descricao.entrada.value.trim()) descricao.entrada.value = x.descricao;
    },
  });
  codigo.append(escolhido);
  const descricao = campo({ rotulo: 'Descrição que vai na nota', valor: s.descricao, area: true, atributos: { maxlength: 1000, required: true } });
  const valor = campo({ rotulo: 'Valor de costume', ajuda: 'Opcional. Você pode mudar em cada nota.', valor: s.valorPadrao ? Number(s.valorPadrao).toFixed(2).replace('.', ',') : '', atributos: { inputmode: 'decimal', placeholder: '0,00' } });
  const cTribMun = campo({ rotulo: 'Código de tributação municipal', ajuda: 'Só se a sua prefeitura exigir (3 dígitos).', valor: s.cTribMun || '', atributos: { inputmode: 'numeric', maxlength: 3 } });
  const cNBS = campo({ rotulo: 'Código NBS', ajuda: 'Opcional (9 dígitos).', valor: s.cNBS || '', atributos: { inputmode: 'numeric', maxlength: 9 } });

  const erroGeral = h('p', { class: 'erro-campo', role: 'alert', hidden: true });
  const salvar = h('button', { class: 'btn btn-primario', type: 'submit' }, para ? 'Salvar e usar na nota' : 'Salvar serviço');
  const form = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      salvar.disabled = true;
      erroGeral.hidden = true;
      try {
        const r = await api(id ? 'PUT' : 'POST', id ? `/api/servicos/${id}` : '/api/servicos', {
          apelido: apelido.entrada.value, cTribNac: nacional?.codigo || '', descricao: descricao.entrada.value,
          valorPadrao: valor.entrada.value, cTribMun: cTribMun.entrada.value, cNBS: cNBS.entrada.value,
        });
        aviso('Serviço salvo.');
        if (para) { await usarNaNota(para, r.servico); ir(`/nota/${para}`, { substituir: true }); } else history.back();
      } catch (err) {
        if (err instanceof ErroApi && err.dados?.campos) mostrarErros({ apelido, cTribNac: codigo, descricao, cNBS, cTribMun }, err.dados.campos);
        else { erroGeral.textContent = err.status === 0 ? 'Sem internet: salvar serviços precisa de conexão.' : err.message; erroGeral.hidden = false; }
      } finally { salvar.disabled = false; }
    },
  }, apelido, codigo, descricao, valor, h('details', {}, h('summary', {}, 'Mais opções'), cTribMun, cNBS), erroGeral, h('div', { class: 'rodape-fixo' }, salvar));

  const excluir = id ? h('button', {
    class: 'btn btn-texto btn-perigo', type: 'button',
    onclick: async () => {
      if (!confirm(`Excluir o serviço "${s.apelido}"?`)) return;
      await api('DELETE', `/api/servicos/${id}`);
      history.back();
    },
  }, 'Excluir serviço') : null;
  return { titulo: id ? 'Editar serviço' : 'Novo serviço', aba: 'inicio', voltar: true, node: h('div', {}, form, excluir) };
}
