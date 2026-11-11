// Lista de empresas da conta (escritórios cuidam de dezenas) e cadastro de nova empresa.
import { h, campo, aviso, data, icone, ICONES, plural } from '../ui.js';
import { api } from '../api.js';
import { comCache } from '../store.js';
import { estado, entrarNaEmpresa, sair } from '../app.js';
import { formularioEmpresa } from './perfil.js';

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const FILTROS = [['', 'Todas'], ['atencao', 'Precisam de atenção'], ['mei', 'MEI'], ['simples', 'Simples'], ['lucro', 'Presumido/Real']];

// Um marcador decisivo por empresa (o mais urgente) + contexto neutro: menos ruído numa lista de 50.
function marcadores(e) {
  const m = [];
  const mk = (texto, tipo = '') => m.push(h('span', { class: `marcador ${tipo}` }, texto));
  if (e.id === estado.conta?.prestadorId) mk('Aberta agora', 'marcador-ok');
  const venceEmBreve = e.certificadoValidoAte && !e.certificadoVencido && new Date(e.certificadoValidoAte) - Date.now() < 30 * 86400_000;
  if (e.pendentes) mk(plural(e.pendentes, 'nota pendente', 'notas pendentes'), 'marcador-alerta');
  else if (e.certificadoVencido) mk('Certificado vencido', 'marcador-erro');
  else if (venceEmBreve) mk(`Certificado vence ${data(e.certificadoValidoAte)}`, 'marcador-alerta');
  else if (e.rascunhos) mk(plural(e.rascunhos, 'rascunho', 'rascunhos'));
  // Sem certificado (da empresa ou do escritório, por procuração) a empresa não emite pelo app.
  if (!e.certificadoValidoAte) mk(e.porProcuracao ? 'Sem certificado do escritório' : 'Sem certificado', 'marcador-alerta');
  else if (e.porProcuracao) mk('Por procuração');
  // Ambiente só quando foge do comum: produção é o normal.
  if (e.ambiente === 'producao_restrita' && !todasEmTestes) mk('Testes');
  return m;
}

const precisaAtencao = (e) => e.pendentes > 0 || e.certificadoVencido || !e.certificadoValidoAte
  || new Date(e.certificadoValidoAte) - Date.now() < 30 * 86400_000;
let todasEmTestes = false;

export async function lista(_, query) {
  const { empresas } = await comCache('empresas', () => api('GET', '/api/empresas'));
  todasEmTestes = empresas.length > 1 && empresas.every((e) => e.ambiente === 'producao_restrita');
  const filtro = FILTROS.some(([v]) => v === query.filtro) ? query.filtro : '';
  const ul = h('ul', { class: 'lista', 'aria-live': 'polite' });
  // Primeiro o que precisa de atenção, depois por nome.
  const ordenadas = [...empresas].sort((a, b) => (precisaAtencao(b) - precisaAtencao(a)) || String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
  const contador = h('p', { class: 'suave', role: 'status' });
  let termo = '';

  async function abrir(e) {
    try { await entrarNaEmpresa(e.id); } catch (err) { aviso(err.message); }
  }
  const item = (e) => h('li', {}, h('button', { class: 'item empresa-item item-seta', type: 'button', onclick: () => abrir(e), 'aria-current': e.id === estado.conta?.prestadorId ? 'true' : null },
    h('div', { class: 'item-corpo' },
      h('div', { class: 'item-titulo' }, e.nome || 'Empresa sem nome'),
      h('div', { class: 'item-sub' }, [e.documentoFormatado, e.regime, e.municipio ? `${e.municipio.nome} - ${e.municipio.uf}` : null].filter(Boolean).join(' · ')),
      h('div', { class: 'marcadores' }, marcadores(e)))));

  function mostrar() {
    const t = semAcento(termo).trim();
    const dig = t.replace(/[^0-9a-z]/g, '');
    const visiveis = ordenadas.filter((e) => {
      if (filtro === 'atencao' && !precisaAtencao(e)) return false;
      if (filtro === 'mei' && e.opSimpNac !== '2') return false;
      if (filtro === 'simples' && e.opSimpNac !== '3') return false;
      if (filtro === 'lucro' && e.opSimpNac !== '1') return false;
      return !t || semAcento(e.nome).includes(t) || semAcento(e.municipio?.nome).includes(t)
        || (dig.length >= 3 && semAcento(e.documentoFormatado).replace(/[^0-9a-z]/g, '').includes(dig));
    });
    contador.textContent = `${visiveis.length} de ${plural(empresas.length, 'empresa', 'empresas')}`;
    ul.replaceChildren(...visiveis.map(item));
    // Sem nenhuma empresa, o cartão "Cadastre sua primeira empresa" já explica o que fazer.
    if (!visiveis.length && empresas.length) ul.append(h('li', { class: 'suave' }, 'Nenhuma empresa encontrada.'));
  }
  mostrar();

  const atencao = empresas.filter(precisaAtencao).length;
  const busca = empresas.length > 3 ? campo({ rotulo: 'Pesquisar empresa', rotuloOculto: true,
    atributos: { type: 'search', autocomplete: 'off', placeholder: 'Buscar por nome, CNPJ ou cidade' }, oninput: (e) => { termo = e.target.value; mostrar(); } }) : null;
  busca?.classList.add('busca-icone');
  const node = h('div', {},
    empresas.length ? null
      : h('section', { class: 'cartao' }, h('h2', { style: 'margin-top:0' }, 'Cadastre sua primeira empresa'),
        h('p', {}, 'Digite o CNPJ: buscamos razão social, município e enquadramento (MEI, Simples, Presumido ou Real) na Receita para você.')),
    h('div', { class: 'barra-lista' }, busca, empresas.length ? contador : null,
      h('a', { class: `btn ${empresas.length ? 'btn-pequeno' : 'btn-primario'}`, href: '#/empresas/nova' }, icone(ICONES.mais), 'Adicionar empresa')),
    empresas.length > 1 ? h('div', { class: 'chips', role: 'group', 'aria-label': 'Filtrar empresas' }, FILTROS.map(([v, t]) => h('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(v === filtro),
      onclick: () => { location.replace(`#/empresas${v ? `?filtro=${v}` : ''}`); },
    }, v === 'atencao' ? `${t} (${atencao})` : t))) : null,
    ul,
    h('h3', {}, 'Certificado do escritório'),
    h('p', { class: 'suave' }, 'Com procuração eletrônica NFS-e, um único certificado (do escritório ou do contador) emite por todas as empresas que autorizaram.'),
    h('a', { class: 'btn', href: '#/procurador' }, 'Certificado do escritório (procuração)'),
    h('h3', {}, 'Conta'),
    h('a', { class: 'item item-seta', href: '#/conta' }, h('div', { class: 'item-corpo' }, h('div', { class: 'item-titulo' }, 'Minha conta'),
      h('div', { class: 'item-sub' }, estado.conta?.documentoFormatado || estado.conta?.email || ''))),
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
