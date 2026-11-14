// Lista de empresas da conta (escritórios cuidam de dezenas) e cadastro de nova empresa.
import { h, campo, aviso, data, dataHora, icone, ICONES, plural } from '../ui.js';
import { api } from '../api.js';
import { comCache } from '../store.js';
import { estado, entrarNaEmpresa, sair, carregarConta, AREAS_DA_EMPRESA, empresasRecentes } from '../app.js';
import { formularioEmpresa } from './perfil.js';
import { resumoDaBusca } from './historico.js';

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
  // A Receita recusou a última consulta: por procuração, é o sinal de que ela não está vigente.
  else if (e.consultaRecusadaEm) mk(e.porProcuracao ? 'Procuração recusada pela Receita' : 'Consulta recusada pela Receita', 'marcador-erro');
  else if (venceEmBreve) mk(`Certificado vence ${data(e.certificadoValidoAte)}`, 'marcador-alerta');
  else if (e.rascunhos) mk(plural(e.rascunhos, 'rascunho', 'rascunhos'));
  // Sem certificado (da empresa ou do escritório, por procuração) a empresa não emite pelo app.
  if (!e.certificadoValidoAte) mk(e.porProcuracao ? 'Sem certificado do escritório' : 'Sem certificado', 'marcador-alerta');
  else if (e.porProcuracao) mk('Por procuração');
  // Ambiente só quando foge do comum: produção é o normal.
  if (e.ambiente === 'producao_restrita' && !todasEmTestes) mk('Testes');
  return m;
}

const precisaAtencao = (e) => e.pendentes > 0 || e.certificadoVencido || !e.certificadoValidoAte || !!e.consultaRecusadaEm
  || new Date(e.certificadoValidoAte) - Date.now() < 30 * 86400_000;
let todasEmTestes = false;

export async function lista(_, query) {
  const { empresas, producaoLiberada, procurador } = await comCache('empresas', () => api('GET', '/api/empresas'));
  // Com a produção liberada, ambiente de testes é a exceção e leva marcador; num servidor só de testes, não.
  todasEmTestes = !producaoLiberada && empresas.every((e) => e.ambiente === 'producao_restrita');
  const filtro = FILTROS.some(([v]) => v === query.filtro) ? query.filtro : '';
  const ul = h('ul', { class: 'lista', 'aria-live': 'polite' });
  // Primeiro o que precisa de atenção, depois por nome.
  const ordenadas = [...empresas].sort((a, b) => (precisaAtencao(b) - precisaAtencao(a)) || String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
  const contador = h('p', { class: 'suave', role: 'status' });
  let termo = '';
  let visiveisAgora = [];
  // Veio da barra da empresa: depois de escolher, volta para a mesma área (notas tomadas → notas tomadas).
  const destino = AREAS_DA_EMPRESA.includes(query.voltar) ? query.voltar : '/';
  const endereco = (f) => { const p = new URLSearchParams({ ...(f ? { filtro: f } : {}), ...(destino !== '/' ? { voltar: destino } : {}) }).toString(); return `#/empresas${p ? `?${p}` : ''}`; };

  async function abrir(e) {
    try { await entrarNaEmpresa(e.id, destino); } catch (err) { aviso(err.message); }
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
    visiveisAgora = visiveis;
    contador.textContent = `${visiveis.length} de ${plural(empresas.length, 'empresa', 'empresas')}`;
    ul.replaceChildren(...visiveis.map(item));
    // Sem nenhuma empresa, o cartão "Cadastre sua primeira empresa" já explica o que fazer.
    if (!visiveis.length && empresas.length) ul.append(h('li', { class: 'suave' }, 'Nenhuma empresa encontrada.'));
  }
  mostrar();

  const atencao = empresas.filter(precisaAtencao).length;
  const busca = empresas.length > 3 ? campo({ rotulo: 'Pesquisar empresa', rotuloOculto: true,
    atributos: { type: 'search', autocomplete: 'off', placeholder: 'Buscar por nome, CNPJ ou cidade', enterkeyhint: 'go' }, oninput: (e) => { termo = e.target.value; mostrar(); } }) : null;
  busca?.classList.add('busca-icone');
  // Enter abre a primeira empresa encontrada: digitar parte do nome e confirmar basta para trocar.
  busca?.entrada.addEventListener('keydown', (e) => { if (e.key === 'Enter' && termo.trim() && visiveisAgora.length) { e.preventDefault(); abrir(visiveisAgora[0]); } });
  // No computador o cursor já fica na busca (no celular isso abriria o teclado sem ninguém pedir).
  if (busca && matchMedia('(hover: hover) and (pointer: fine)').matches) setTimeout(() => { if (document.body.contains(busca)) busca.entrada.focus({ preventScroll: true }); }, 60);

  // Empresas abertas há pouco neste aparelho: um toque para voltar a elas.
  const recentes = empresas.length > 4
    ? empresasRecentes().map((id) => empresas.find((e) => e.id === id)).filter((e) => e && e.id !== estado.conta?.prestadorId).slice(0, 4) : [];
  const nomeCurto = (n) => (String(n || 'Empresa').length > 26 ? `${String(n).slice(0, 25).trimEnd()}…` : String(n || 'Empresa'));

  // Busca na Receita (ADN) de todas as empresas com certificado válido: roda no servidor, a tela só acompanha.
  const comCertificado = empresas.filter((e) => e.certificadoValidoAte && !e.certificadoVencido).length;
  const andamento = h('p', { class: 'suave', role: 'status' });
  const falhas = h('div', {});
  const botaoLote = h('button', { class: 'btn btn-pequeno', type: 'button' }, icone(ICONES.atualizar), 'Buscar notas de todas na Receita');
  function mostrarResultado(s) {
    if (!s.terminadaEm) return;
    andamento.textContent = `Última busca em todas as empresas (${dataHora(s.terminadaEm)}): ${resumoDaBusca({ novas: s.tomadas, emitidas: s.emitidas, canceladas: s.canceladas })}`;
    falhas.replaceChildren(...(s.falhas.length ? [h('div', { class: 'cartao cartao-alerta' },
      h('strong', {}, `${plural(s.falhas.length, 'empresa não pôde ser consultada', 'empresas não puderam ser consultadas')}:`),
      h('ul', {}, s.falhas.map((f) => h('li', {}, h('strong', {}, f.empresa), ': ', f.motivo))))] : []));
  }
  let acompanhando = false;
  async function acompanhar(s) {
    if (acompanhando) return;
    acompanhando = true;
    botaoLote.disabled = true;
    try {
      while (s.emAndamento && document.body.contains(andamento)) {
        andamento.textContent = `Consultando a Receita: ${s.feitas} de ${plural(s.total, 'empresa', 'empresas')}…`;
        await new Promise((r) => { setTimeout(r, 1500); });
        s = await api('GET', '/api/empresas/sincronizacao');
      }
      // Terminou com a tela aberta: recarrega a lista (pendências e contagens podem ter mudado).
      // Com a pessoa no meio de uma busca por nome, só o resultado aparece: o que ela digitou não se perde.
      if (!s.emAndamento && document.body.contains(andamento)) {
        if (termo.trim()) mostrarResultado(s); else window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
    } catch (e) { andamento.textContent = e.status === 0 ? 'Sem internet: não foi possível acompanhar a busca.' : e.message; } finally { acompanhando = false; botaoLote.disabled = false; }
  }
  botaoLote.addEventListener('click', async () => {
    botaoLote.disabled = true;
    try {
      const s = await api('POST', '/api/empresas/sincronizar', {});
      if (!s.total) { aviso('Nenhuma empresa com certificado válido para consultar a Receita.'); botaoLote.disabled = false; return; }
      acompanhar(s);
    } catch (e) { aviso(e.status === 0 ? 'Sem internet: a busca na Receita precisa de conexão.' : e.message, 7000); botaoLote.disabled = false; }
  });
  // O escritório trabalha por procuração: o certificado dele abre a tela, com quantas empresas o usam.
  const porProcuracao = empresas.filter((e) => e.porProcuracao).length;
  const vencimento = procurador ? new Date(procurador.validoAte) - Date.now() : null;
  const cartaoEscritorio = procurador
    ? h('a', { class: `item item-seta cartao-escritorio${vencimento < 30 * 86400_000 ? ' atencao' : ''}`, href: '#/procurador' },
      h('div', { class: 'item-corpo' },
        h('div', { class: 'item-titulo' }, 'Certificado do escritório (procuração)'),
        h('div', { class: 'item-sub' }, [
          vencimento <= 0 ? `Venceu em ${data(procurador.validoAte)}: envie o novo` : `Válido até ${data(procurador.validoAte)}`,
          empresas.length ? `${porProcuracao} de ${plural(empresas.length, 'empresa', 'empresas')} por procuração` : null,
        ].filter(Boolean).join(' · '))))
    : h('section', { class: 'cartao' },
      h('strong', {}, 'Atende as empresas por procuração?'),
      h('p', { class: 'suave' }, 'Envie uma única vez o certificado do escritório (ou do contador): ele emite e busca as notas de todas as empresas que concederam a procuração eletrônica NFS-e na Receita.'),
      h('a', { class: 'btn btn-pequeno', href: '#/procurador' }, 'Enviar certificado do escritório'));

  // Empresas ainda no ambiente de testes da Receita, com a produção liberada: as notas delas não valem.
  const emTestes = producaoLiberada ? empresas.filter((e) => e.ambiente === 'producao_restrita') : [];
  const passarParaProducao = h('button', { class: 'btn btn-pequeno', type: 'button', onclick: async () => {
    if (!confirm(`Passar ${plural(emTestes.length, 'empresa', 'empresas')} para a produção? A partir daí, as notas emitidas por ${emTestes.length === 1 ? 'ela' : 'elas'} são notas fiscais de verdade. As notas de teste já emitidas continuam marcadas como teste.`)) return;
    passarParaProducao.disabled = true;
    try {
      const r = await api('PUT', '/api/empresas/ambiente', { empresas: emTestes.map((e) => e.id), ambiente: 'producao' });
      aviso(`${plural(r.alteradas, 'empresa passou', 'empresas passaram')} para a produção.`, 6000);
      // A empresa aberta pode ser uma delas: a barra do topo acompanha.
      await carregarConta({ permitirOffline: false }).catch(() => {});
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (e) { aviso(e.status === 0 ? 'Sem internet: tente de novo quando a conexão voltar.' : e.message, 7000); passarParaProducao.disabled = false; }
  } }, 'Passar para produção');
  const cartaoTestes = emTestes.length ? h('div', { class: 'cartao cartao-alerta' },
    h('p', {}, h('strong', {}, `${plural(emTestes.length, 'empresa está', 'empresas estão')} no ambiente de testes. `), 'As notas emitidas ali não têm validade jurídica.'),
    passarParaProducao) : null;

  // Ao abrir a tela: retoma uma busca em andamento ou mostra o resultado da última.
  if (comCertificado > 1 && navigator.onLine) api('GET', '/api/empresas/sincronizacao').then((s) => (s.emAndamento ? acompanhar(s) : mostrarResultado(s))).catch(() => {});
  const node = h('div', {},
    // Conta sem empresas: o escritório começa pelo certificado dele e depois cadastra as empresas.
    empresas.length ? cartaoEscritorio
      : h('section', { class: 'cartao' }, h('h2', { style: 'margin-top:0' }, 'Comece por aqui'),
        h('ol', { class: 'passos' },
          h('li', {}, h('strong', {}, 'Certificado do escritório. '), procurador
            ? `Enviado: válido até ${data(procurador.validoAte)}.`
            : 'Envie uma única vez o certificado do escritório (ou do contador): ele emite e busca as notas de todas as empresas que concederam a procuração eletrônica NFS-e na Receita. ',
          procurador ? null : h('a', { class: 'btn btn-pequeno', href: '#/procurador' }, 'Enviar certificado do escritório')),
          h('li', {}, h('strong', {}, 'Empresas. '), 'Digite o CNPJ de cada empresa (ou cole a lista toda em "Cadastrar em lote"): buscamos razão social, município e enquadramento (MEI, Simples, Presumido ou Real) na Receita para você. ',
            procurador ? 'Elas já nascem por procuração.' : 'Sem o certificado do escritório, cada empresa precisa do próprio certificado A1.'))),
    cartaoTestes,
    h('div', { class: 'barra-lista' }, busca, empresas.length ? contador : null,
      h('div', { class: 'barra-acoes' },
        h('a', { class: `btn ${empresas.length ? 'btn-pequeno' : 'btn-primario'}`, href: '#/empresas/nova' }, icone(ICONES.mais), 'Adicionar empresa'),
        h('a', { class: 'btn btn-pequeno', href: '#/empresas/lote' }, icone(ICONES.empresa), 'Cadastrar em lote'))),
    recentes.length ? h('div', { class: 'chips chips-recentes', role: 'group', 'aria-label': 'Empresas abertas há pouco' },
      h('span', { class: 'suave' }, 'Abertas há pouco:'),
      recentes.map((e) => h('button', { class: 'chip', type: 'button', title: `${e.nome || ''} · ${e.documentoFormatado || ''}`, onclick: () => abrir(e) }, nomeCurto(e.nome)))) : null,
    empresas.length > 1 ? h('div', { class: 'chips', role: 'group', 'aria-label': 'Filtrar empresas' }, FILTROS.map(([v, t]) => h('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(v === filtro),
      onclick: () => { location.replace(endereco(v)); },
    }, v === 'atencao' ? `${t} (${atencao})` : t))) : null,
    comCertificado > 1 ? h('div', { class: 'cabecalho-acoes' }, andamento, botaoLote) : null,
    falhas,
    ul,
    h('h3', {}, 'Conta'),
    h('a', { class: 'item item-seta', href: '#/conta' }, h('div', { class: 'item-corpo' }, h('div', { class: 'item-titulo' }, 'Minha conta'),
      h('div', { class: 'item-sub' }, estado.conta?.documentoFormatado || estado.conta?.email || ''))),
    h('button', { class: 'btn btn-texto', type: 'button', onclick: sair }, 'Sair da conta'));
  return { titulo: 'Empresas', aba: 'empresas', node };
}

export async function nova() {
  const [{ producaoLiberada, ambientePadrao }, procurador] = await Promise.all([
    api('GET', '/api/perfil').catch(() => ({ producaoLiberada: false })),
    api('GET', '/api/procurador').catch(() => null),
  ]);
  // Escritório com certificado: a empresa nova já nasce por procuração (é como o escritório trabalha);
  // quem tiver o certificado A1 da própria empresa desmarca.
  const porProcuracao = procurador?.certificado ? h('input', { type: 'checkbox', id: 'nova-por-procuracao', checked: true }) : null;
  const form = formularioEmpresa({
    producaoLiberada, ambientePadrao, textoBotao: 'Cadastrar empresa',
    salvarDados: async (corpo) => {
      const usaProcuracao = !!porProcuracao?.checked;
      const { empresaId } = await api('POST', '/api/empresas', { ...corpo, ...(usaProcuracao ? { usaProcuracao: true } : {}) });
      aviso(usaProcuracao
        ? 'Empresa cadastrada por procuração: ela usa o certificado do escritório para emitir e buscar notas.'
        : 'Empresa cadastrada. Envie o certificado A1 dela para emitir notas e baixar as tomadas.', 6000);
      // Por procuração não há certificado a enviar: a empresa abre pronta para a primeira nota.
      await entrarNaEmpresa(empresaId, usaProcuracao ? '/' : '/perfil');
    },
  });
  return {
    titulo: 'Nova empresa', aba: 'empresas', voltar: true,
    node: h('div', {},
      h('p', {}, 'Comece pelo CNPJ: o restante é preenchido com os dados públicos da Receita. Confira antes de salvar.'),
      porProcuracao ? h('label', { class: 'caixa cartao', for: 'nova-por-procuracao' }, porProcuracao,
        h('span', {}, h('strong', {}, 'Usar o certificado do escritório (procuração eletrônica)'),
          h('span', { class: 'ajuda' }, 'Para empresas que concederam a procuração NFS-e ao escritório no Portal de Serviços da Receita. Sem marcar, a empresa precisa do próprio certificado A1.')))
        // Sem o certificado do escritório, a procuração começa por ele.
        : procurador ? h('div', { class: 'cartao' },
          h('strong', {}, 'Vai atender esta empresa por procuração?'),
          h('p', { class: 'suave' }, 'Envie antes o certificado do escritório (ou do contador): as empresas já nascem prontas para emitir e buscar notas, sem o certificado de cada uma.'),
          h('a', { class: 'btn btn-pequeno', href: '#/procurador' }, 'Enviar certificado do escritório')) : null,
      form),
  };
}
