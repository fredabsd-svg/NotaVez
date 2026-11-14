// Roteador e inicialização do PWA.
import { api, ErroApi, urlConta } from './api.js';
import { h, aviso, esqueleto } from './ui.js';
import { definirConta, recuperarContaOffline, sessaoEncerrada, temLegadoEmQuarentena, excluirDadosDaConta, sincronizarTodos, contaGuardada, esquecerContaNestaAba } from './store.js';
import * as entrar from './views/entrar.js';
import * as conta from './views/conta.js';
import * as inicio from './views/inicio.js';
import * as clientes from './views/clientes.js';
import * as servicos from './views/servicos.js';
import * as nota from './views/nota.js';
import * as revisao from './views/revisao.js';
import * as resultado from './views/resultado.js';
import * as historico from './views/historico.js';
import * as perfil from './views/perfil.js';
import * as instalar from './views/instalar.js';
import * as empresas from './views/empresas.js';
import * as tomadas from './views/tomadas.js';
import * as assistida from './views/assistida.js';
import * as procurador from './views/procurador.js';
import * as assistente from './views/assistente.js';

const rotas = [
  ['/entrar', entrar.tela],
  ['/conta', conta.tela],
  ['/', inicio.tela],
  ['/nova', nota.nova],
  ['/clonar', nota.clonarUltima],
  ['/nota/:id', nota.tela],
  ['/nota/:id/revisao', revisao.tela],
  ['/nota/:id/resultado', resultado.tela],
  ['/nota/:id/assistida', assistida.tela],
  ['/notas', historico.tela],
  ['/notas/:id', resultado.detalhe],
  ['/clientes', clientes.lista],
  ['/clientes/novo', clientes.formulario],
  ['/clientes/:id', clientes.formulario],
  ['/servicos', servicos.lista],
  ['/servicos/novo', servicos.formulario],
  ['/servicos/:id', servicos.formulario],
  ['/perfil', perfil.tela],
  ['/instalar', instalar.tela],
  ['/empresas', empresas.lista],
  ['/empresas/nova', empresas.nova],
  ['/procurador', procurador.tela],
  ['/tomadas', tomadas.lista],
  ['/tomadas/:id', tomadas.detalhe],
  ['/assistente', assistente.tela],
  ['/assistente/configurar', assistente.configurar],
  ['/assistente/:id', assistente.tela],
];
// Áreas que existem em qualquer empresa: ao trocar de empresa, a pessoa continua na mesma área
// (das notas tomadas de uma para as notas tomadas da outra), em vez de voltar ao Início.
export const AREAS_DA_EMPRESA = ['/', '/notas', '/tomadas', '/clientes', '/servicos', '/perfil'];
export const areaDe = (caminho) => { const a = `/${String(caminho || '').split('/')[1] || ''}`; return AREAS_DA_EMPRESA.includes(a) ? a : '/'; };

// Empresas abertas há pouco neste aparelho (só os identificadores), para a troca rápida do escritório.
const chaveRecentes = () => `nss-empresas-recentes:${estado.conta?.usuarioId || ''}`;
export function empresasRecentes() {
  try { const v = JSON.parse(localStorage.getItem(chaveRecentes()) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}
function lembrarEmpresa(id) {
  try { localStorage.setItem(chaveRecentes(), JSON.stringify([id, ...empresasRecentes().filter((x) => x !== id)].slice(0, 6))); } catch { /* armazenamento indisponível: segue sem a lista */ }
}

// Telas que funcionam sem uma empresa escolhida.
const SEM_EMPRESA = new Set(['/entrar', '/conta', '/instalar', '/empresas', '/empresas/nova', '/procurador', '/assistente', '/assistente/configurar']);

export const estado = { conta: null, inicio: null };

function casar(caminho) {
  for (const [padrao, fn] of rotas) {
    const nomes = [];
    const re = new RegExp(`^${padrao.replace(/:(\w+)/g, (_, n) => { nomes.push(n); return '([^/]+)'; })}$`);
    const m = caminho.match(re);
    if (m) return { fn, params: Object.fromEntries(nomes.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

export const ir = (hash, { substituir = false } = {}) => {
  if (substituir) location.replace(`#${hash}`); else location.hash = hash;
};

// Voltar para uma lista devolve a pessoa ao ponto em que estava (ex.: histórico longo de notas).
// Só vale para "voltar/avançar" de verdade: abrir uma tela por um link começa sempre do alto.
const rolagens = new Map();
let enderecoNaTela = null;
// Momento do último "voltar/avançar". Vale por instantes: se a volta sair do app (outra página) e não houver
// troca de tela aqui, a marca não pode sobrar para o próximo toque num link.
let voltouEm = -Infinity;
const marcarVolta = () => { voltouEm = performance.now(); };
window.navigation?.addEventListener('navigate', (e) => { if (e.navigationType === 'traverse') marcarVolta(); });
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; // a posição é devolvida aqui, depois que a tela chega

let renderizando = 0;
async function renderizar() {
  const meu = ++renderizando;
  if (enderecoNaTela !== null) {
    rolagens.delete(enderecoNaTela); // reinsere no fim: o Map guarda as 50 telas mais recentes
    rolagens.set(enderecoNaTela, window.scrollY);
    if (rolagens.size > 50) rolagens.delete(rolagens.keys().next().value);
    enderecoNaTela = null;
  }
  const rolagem = performance.now() - voltouEm < 1000 ? rolagens.get(location.hash) || 0 : 0;
  voltouEm = -Infinity;
  const [caminho, qs] = (location.hash.slice(1) || '/').split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  const main = document.getElementById('conteudo');
  if (!estado.conta && caminho !== '/entrar' && caminho !== '/instalar') return ir('/entrar', { substituir: true });
  if (estado.conta && !estado.conta.prestadorId && !SEM_EMPRESA.has(caminho)) return ir(estado.conta.empresas ? '/empresas' : '/empresas/nova', { substituir: true });

  const rota = casar(caminho) || casar('/');
  // O esqueleto entra escondido e só aparece se a tela demorar: telas rápidas não piscam.
  // (Por tempo, não por animação: vale também para quem pediu "reduzir movimento".)
  const espera = esqueleto();
  espera.hidden = true;
  main.replaceChildren(espera);
  setTimeout(() => { espera.hidden = false; }, 250);
  let tela;
  try {
    tela = await rota.fn(rota.params, query);
  } catch (e) {
    // Sem internet não é erro: tela neutra, com o que dá para fazer agora e "Tentar de novo".
    const semRede = e instanceof ErroApi && e.status === 0;
    tela = {
      titulo: semRede ? 'Sem internet' : 'Não foi possível abrir', erro: true,
      node: h('div', { class: `cartao ${semRede ? 'cartao-alerta' : 'cartao-erro'}`, role: 'alert' },
        h('p', {}, semRede ? 'Esta tela precisa de conexão. Você pode continuar preparando notas: elas ficam salvas como rascunho neste aparelho.'
          : e instanceof ErroApi ? e.message : 'Não foi possível abrir esta tela.'),
        // Veio de um rascunho (escolher cliente/serviço): o caminho principal é voltar a ele, não abrir outro.
        semRede && query.para ? h('a', { class: 'btn btn-primario', href: `#/nota/${encodeURIComponent(query.para)}` }, 'Voltar ao rascunho') : null,
        h('button', { class: `btn ${semRede ? '' : 'btn-primario'}`, type: 'button', onclick: () => renderizar() }, 'Tentar de novo'),
        semRede && !query.para && estado.conta?.prestadorId ? h('a', { class: 'btn btn-primario', href: '#/nova' }, 'Preparar uma nota') : null,
        h('a', { class: 'btn btn-texto', href: '#/' }, 'Voltar ao início')),
    };
    if (!(e instanceof ErroApi)) console.error(e);
  }
  if (meu !== renderizando || !tela) return; // navegação mais nova em andamento
  estado.telaComErro = !!tela.erro;
  document.getElementById('titulo').textContent = tela.titulo || 'Nota Sem Stress';
  document.title = `${tela.titulo ? `${tela.titulo} · ` : ''}Nota Sem Stress`;
  document.getElementById('voltar').hidden = !tela.voltar;
  // Telas de conta/escritório não são de uma empresa; telas de tarefa (nova nota, revisão…) escondem as abas no celular.
  const naEmpresa = !!estado.conta?.prestadorId && !SEM_EMPRESA.has(caminho) && !tela.semAbas;
  document.getElementById('abas').hidden = !estado.conta || !estado.conta.prestadorId || tela.semAbas;
  document.body.classList.toggle('sem-abas', !!tela.tarefa || !!tela.semAbas);
  document.body.dataset.tela = caminho.split('/')[1] || 'inicio';
  document.body.classList.toggle('sem-empresa', !estado.conta?.prestadorId || !!tela.semAbas);
  const empresa = document.getElementById('empresa-ativa');
  empresa.hidden = !naEmpresa;
  empresa.querySelector('.ctx-nome').textContent = estado.conta?.empresaNome || 'Empresa';
  empresa.querySelector('.ctx-cnpj').textContent = estado.conta?.empresaDocumentoFormatado || '';
  // Empresa atendida por procuração: quem assina e consulta é o certificado do escritório.
  const porProcuracao = !!estado.conta?.empresaPorProcuracao;
  empresa.querySelector('.ctx-proc').hidden = !porProcuracao;
  const amb = empresa.querySelector('.ctx-ambiente');
  const ambiente = estado.conta?.empresaAmbiente;
  mostrarAmbiente(amb, ambiente);
  empresa.setAttribute('aria-label', `Empresa aberta: ${estado.conta?.empresaNome || ''}${porProcuracao ? ', por procuração' : ''}${ambiente === 'producao_restrita' ? ' (ambiente de testes)' : ''}. Trocar de empresa`);
  // A troca devolve a pessoa à mesma área em que ela estava.
  const area = areaDe(caminho);
  empresa.setAttribute('href', area === '/' ? '#/empresas' : `#/empresas?voltar=${encodeURIComponent(area)}`);
  for (const a of document.querySelectorAll('.abas a')) {
    // Só destinos com data-aba (a marca da barra lateral não é um): tela sem aba não marca nada.
    if (a.dataset.aba && a.dataset.aba === tela.aba) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  main.replaceChildren(tela.node);
  main.focus({ preventScroll: true });
  window.scrollTo(0, rolagem);
  enderecoNaTela = location.hash;
}

// Produção é o normal e não leva selo; o que foge do normal (ambiente de testes, notas sem validade) aparece.
function mostrarAmbiente(amb, ambiente) {
  amb.hidden = ambiente !== 'producao_restrita';
  amb.textContent = 'Testes';
  amb.className = 'selo ctx-ambiente selo-teste';
}

// O ambiente aparece na barra da empresa; o selo do topo fica só para quando não há empresa aberta.
export async function atualizarSelo() {
  const ambiente = estado.inicio?.perfil?.ambiente;
  document.getElementById('selo-ambiente').hidden = true;
  if (ambiente && estado.conta && estado.conta.empresaAmbiente !== ambiente) {
    estado.conta = { ...estado.conta, empresaAmbiente: ambiente };
    const amb = document.querySelector('#empresa-ativa .ctx-ambiente');
    if (amb) mostrarAmbiente(amb, ambiente);
  }
}

// `empresa`: a empresa que esta aba quer abrir (padrão: a que já estava aberta).
export async function carregarConta({ permitirOffline = true, substituirTitular = false, usuarioEsperado, empresa } = {}) {
  try {
    const desejada = empresa !== undefined ? empresa : estado.conta?.prestadorId ?? (await contaGuardada())?.prestadorId ?? null;
    const conta = await api('GET', urlConta(desejada));
    if (!conta?.usuarioId) throw new ErroApi(401, { erro: 'Não foi possível confirmar o titular da conta.' });
    if (usuarioEsperado && usuarioEsperado !== conta.usuarioId) throw new ErroApi(401, { erro: 'A conta mudou em outra aba. Entre novamente.' });
    if (!substituirTitular && estado.conta && estado.conta.usuarioId !== conta.usuarioId) {
      window.dispatchEvent(new CustomEvent('notavez:sessao-expirada'));
      // Outra conta entrou noutra aba: o tratador do evento cuida desta aba sem apagar a conta guardada da outra.
      throw new ErroApi(401, { erro: 'A conta mudou em outra aba. Entre novamente.', trocaTitular: true });
    }
    estado.inicio = null;
    estado.conta = await definirConta(conta);
  } catch (e) {
    // Sem rede, servidor fora (5xx), limite (429) ou resposta estranha não encerram a sessão:
    // só a resposta "sessão inválida" (401/403) encerra; conta trocada é tratada pelo evento.
    const semRede = e instanceof ErroApi && (e.status === 0 || e.status === 429 || e.status >= 500);
    const encerra = e instanceof ErroApi && [401, 403].includes(e.status) && !e.dados?.trocaTitular;
    if (semRede || !(e instanceof ErroApi)) { if (permitirOffline || !estado.conta) estado.conta = await recuperarContaOffline(); }
    else if (encerra) estado.conta = await definirConta(null);
    if (!permitirOffline) throw e;
  }
  return estado.conta;
}

// Entra no ambiente de uma empresa: rascunhos e cópias locais são separados por empresa.
export async function entrarNaEmpresa(id, destino = '/') {
  const conta = await carregarConta({ permitirOffline: false, empresa: id });
  if (conta?.prestadorId !== id) throw new ErroApi(409, { erro: 'Esta empresa não está mais disponível na sua conta.' });
  lembrarEmpresa(id);
  atualizarSelo();
  sincronizarTodos().catch(() => {});
  ir(destino);
}

export async function sair() {
  // Sem resposta do servidor, o cookie pode continuar válido. Não reativar a
  // conta localmente; uma nova entrada confirmará o titular antes de sincronizar.
  try { await api('POST', '/api/conta/sair', {}); } catch { /* sessão local encerra */ }
  try { await definirConta(null); } catch { aviso('Não foi possível limpar a sessão local. Apague o armazenamento do site antes de emprestar este aparelho.'); }
  // A lista de empresas abertas há pouco não fica no aparelho depois da saída.
  try { localStorage.removeItem(chaveRecentes()); } catch { /* armazenamento indisponível */ }
  estado.conta = null;
  estado.inicio = null;
  estado.ultimoResultado = null;
  aviso('Você saiu. Seus rascunhos ficam neste aparelho e só aparecem ao entrar na mesma conta.');
  ir('/entrar');
}

function atualizarOnline() {
  document.getElementById('faixa-offline').hidden = navigator.onLine;
  if (!navigator.onLine || !estado.conta) return;
  const antes = `${estado.conta.usuarioId}:${estado.conta.prestadorId}`;
  // Re-desenha só se a conta ou a empresa mudaram: não apaga o que a pessoa está digitando.
  carregarConta({ permitirOffline: false })
    .then(() => { if (estado.telaComErro || `${estado.conta?.usuarioId}:${estado.conta?.prestadorId}` !== antes) renderizar(); return sincronizarTodos(); })
    // Servidor em 5xx/429 não encerra a sessão: só volta a "Entrar" quem de fato ficou sem conta.
    .catch((e) => { if (!(e instanceof ErroApi && e.status === 0) && !estado.conta) ir('/entrar'); });
}

document.getElementById('voltar').addEventListener('click', () => {
  // Navegadores sem a API de navegação: o botão Voltar do app também devolve a posição da lista.
  if (history.length > 1) { marcarVolta(); history.back(); } else ir('/');
});
window.addEventListener('hashchange', renderizar);
window.addEventListener('online', atualizarOnline);
window.addEventListener('offline', atualizarOnline);
window.addEventListener('notavez:sessao-expirada', async () => {
  // Abrir o app sem sessão (primeiro acesso) não é "sessão terminou".
  const tinhaSessao = !!estado.conta;
  const usuario = estado.conta?.usuarioId;
  estado.conta = null;
  estado.inicio = null;
  estado.ultimoResultado = null;
  renderizando++;
  // O IndexedDB é de todas as abas: uma aba antiga não pode encerrar a conta que outra abriu.
  try {
    const guardada = await contaGuardada();
    if (!guardada || !usuario || guardada.usuarioId === usuario) await definirConta(null); else esquecerContaNestaAba();
  } catch { /* identidade em memória já encerrada */ }
  if (tinhaSessao) aviso('Sua sessão terminou. Seus rascunhos continuam guardados para a mesma conta. Entre novamente.');
  // Já na tela de entrada (ex.: retorno do gov.br com mensagem): não perde o que veio no endereço.
  if (!location.hash.startsWith('#/entrar')) ir('/entrar');
});

window.addEventListener('notavez:empresa-indisponivel', async () => {
  if (!estado.conta?.prestadorId) return;
  renderizando++;
  try { await carregarConta({ permitirOffline: false, empresa: null }); } catch {
    // Sem resposta do servidor: a empresa sai da sessão desta aba mesmo assim (evita repetir o pedido em laço).
    if (estado.conta?.prestadorId) estado.conta = await definirConta({ ...estado.conta, prestadorId: null, empresaNome: null });
  }
  aviso('Esta empresa não está mais disponível na sua conta. Escolha outra.');
  // Já em #/empresas o hash não muda: desenha direto.
  if (location.hash === '#/empresas') renderizar(); else ir('/empresas', { substituir: true });
});

window.addEventListener('notavez:conta-excluida', async (e) => {
  const titular = e.detail?.usuarioId || estado.conta?.usuarioId;
  if (estado.conta?.usuarioId === titular) renderizando++;
  let falhouLimpeza = false;
  try { await excluirDadosDaConta(titular); } catch { falhouLimpeza = true; }
  if (estado.conta?.usuarioId === titular) {
    estado.conta = null;
    estado.inicio = null;
    estado.ultimoResultado = null;
    try { await definirConta(null); } catch { falhouLimpeza = true; }
    ir('/entrar');
  }
  if (falhouLimpeza) aviso('Conta excluída. Não foi possível limpar os dados locais: apague o armazenamento deste site nas configurações do navegador.');
});

let pedidoInstalacao = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); pedidoInstalacao = e; });
export const pedirInstalacao = () => pedidoInstalacao;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

document.getElementById('faixa-offline').hidden = navigator.onLine;
// Situação do servidor e conta são pedidas ao mesmo tempo: a primeira tela chega uma ida e volta antes.
const saude = fetch('/api/saude').then((r) => r.json()).catch(() => null); // sem internet: segue sem a faixa
if (!(await sessaoEncerrada())) await carregarConta();
estado.demo = !!(await saude)?.demo;
document.getElementById('faixa-demo').hidden = !estado.demo;
if (estado.conta && navigator.onLine) sincronizarTodos().catch(() => {});
if (await temLegadoEmQuarentena()) aviso('Há rascunhos antigos sem titular identificado. Eles foram preservados separadamente e não serão exibidos nem enviados por outra conta.');
renderizar();
