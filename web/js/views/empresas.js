// Lista de empresas da conta (escritórios cuidam de dezenas) e cadastro de nova empresa.
import { h, campo, aviso, data, icone, ICONES } from '../ui.js';
import { api } from '../api.js';
import { comCache } from '../store.js';
import { estado, entrarNaEmpresa, sair } from '../app.js';
import { formularioEmpresa } from './perfil.js';

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const FILTROS = [['', 'Todas'], ['atencao', 'Precisam de atenção'], ['mei', 'MEI'], ['simples', 'Simples'], ['lucro', 'Presumido/Real']];

function marcadores(e) {
  const m = [];
  const mk = (texto, tipo = '') => m.push(h('span', { class: `marcador ${tipo}` }, texto));
  if (e.id === estado.conta?.prestadorId) mk('Aberta agora', 'marcador-ok');
  if (!e.certificadoValidoAte) mk('Sem certificado', 'marcador-alerta');
  else if (e.certificadoVencido) mk('Certificado vencido', 'marcador-erro');
  else if (new Date(e.certificadoValidoAte) - Date.now() < 30 * 86400_000) mk(`Certificado vence ${data(e.certificadoValidoAte)}`, 'marcador-alerta');
  if (e.pendentes) mk(`${e.pendentes} pendente(s)`, 'marcador-erro');
  if (e.rascunhos) mk(`${e.rascunhos} rascunho(s)`);
  if (e.emitidasNoMes) mk(`${e.emitidasNoMes} emitida(s) no mês`);
  if (e.tomadas) mk(`${e.tomadas} tomada(s)`);
  if (e.ambiente === 'producao_restrita') mk('Testes');
  return m;
}

const precisaAtencao = (e) => !e.certificadoValidoAte || e.certificadoVencido || e.pendentes > 0;

export async function lista(_, query) {
  const { empresas } = await comCache('empresas', () => api('GET', '/api/empresas'));
  const filtro = FILTROS.some(([v]) => v === query.filtro) ? query.filtro : '';
  const ul = h('ul', { class: 'lista', 'aria-live': 'polite' });
  const contador = h('p', { class: 'suave', role: 'status' });
  let termo = '';

  async function abrir(e) {
    try { await entrarNaEmpresa(e.id); } catch (err) { aviso(err.message); }
  }
  const item = (e) => h('li', {}, h('button', { class: 'item empresa-item', type: 'button', onclick: () => abrir(e) },
    h('div', { class: 'item-corpo' },
      h('div', { class: 'item-titulo' }, e.nome || 'Empresa sem nome'),
      h('div', { class: 'item-sub' }, [e.documentoFormatado, e.regime, e.municipio ? `${e.municipio.nome} - ${e.municipio.uf}` : null].filter(Boolean).join(' · ')),
      h('div', { class: 'marcadores' }, marcadores(e))),
    h('span', { class: 'selo selo-teste' }, 'Entrar')));

  function mostrar() {
    const t = semAcento(termo).trim();
    const dig = t.replace(/[^0-9a-z]/g, '');
    const visiveis = empresas.filter((e) => {
      if (filtro === 'atencao' && !precisaAtencao(e)) return false;
      if (filtro === 'mei' && e.opSimpNac !== '2') return false;
      if (filtro === 'simples' && e.opSimpNac !== '3') return false;
      if (filtro === 'lucro' && e.opSimpNac !== '1') return false;
      return !t || semAcento(e.nome).includes(t) || semAcento(e.municipio?.nome).includes(t)
        || (dig.length >= 3 && semAcento(e.documentoFormatado).replace(/[^0-9a-z]/g, '').includes(dig));
    });
    contador.textContent = `${visiveis.length} de ${empresas.length} empresa(s)`;
    ul.replaceChildren(...visiveis.map(item));
    if (!visiveis.length) ul.append(h('li', { class: 'suave' }, empresas.length ? 'Nenhuma empresa encontrada.' : 'Nenhuma empresa cadastrada ainda.'));
  }
  mostrar();

  const atencao = empresas.filter(precisaAtencao).length;
  const node = h('div', {},
    empresas.length
      ? h('p', {}, 'Escolha a empresa para entrar no ambiente dela: emitir notas, ver as notas tomadas, clientes e serviços.')
      : h('section', { class: 'cartao' }, h('h2', { style: 'margin-top:0' }, 'Cadastre sua primeira empresa'),
        h('p', {}, 'Digite o CNPJ: buscamos razão social, município e enquadramento (MEI, Simples, Presumido ou Real) na Receita para você.')),
    h('a', { class: `btn ${empresas.length ? '' : 'btn-primario'}`, href: '#/empresas/nova' }, icone(ICONES.mais), 'Adicionar empresa'),
    empresas.length > 1 ? h('div', { class: 'chips', role: 'group', 'aria-label': 'Filtrar empresas' }, FILTROS.map(([v, t]) => h('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(v === filtro),
      onclick: () => { location.replace(`#/empresas${v ? `?filtro=${v}` : ''}`); },
    }, v === 'atencao' && atencao ? `${t} (${atencao})` : t))) : null,
    empresas.length > 3 ? campo({ rotulo: 'Pesquisar empresa', ajuda: 'Nome, CNPJ ou cidade', atributos: { type: 'search', autocomplete: 'off' }, oninput: (e) => { termo = e.target.value; mostrar(); } }) : null,
    empresas.length ? contador : null,
    ul,
    h('h3', {}, 'Conta'),
    h('p', { class: 'suave' }, estado.conta?.email || ''),
    h('a', { class: 'btn btn-texto', href: '#/conta' }, 'Gerenciar e excluir conta'),
    h('button', { class: 'btn btn-texto', type: 'button', onclick: sair }, 'Sair da conta'));
  return { titulo: 'Empresas', aba: 'empresas', node };
}

export async function nova() {
  const { producaoLiberada } = await api('GET', '/api/perfil').catch(() => ({ producaoLiberada: false }));
  const form = formularioEmpresa({
    producaoLiberada, textoBotao: 'Cadastrar empresa',
    salvarDados: async (corpo) => {
      const { empresaId } = await api('POST', '/api/empresas', corpo);
      aviso('Empresa cadastrada. Envie o certificado A1 dela para emitir notas e baixar as tomadas.', 6000);
      await entrarNaEmpresa(empresaId, '/perfil');
    },
  });
  return {
    titulo: 'Nova empresa', aba: 'empresas', voltar: true,
    node: h('div', {},
      h('p', {}, 'Comece pelo CNPJ: o restante é preenchido com os dados públicos da Receita. Confira antes de salvar.'),
      form),
  };
}
