// Roteador e inicialização do PWA.
import { api, ErroApi } from './api.js';
import { h, aviso, carregando } from './ui.js';
import { definirConta, recuperarContaOffline, sessaoEncerrada, temLegadoEmQuarentena, excluirDadosDaConta, sincronizarTodos } from './store.js';
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

const rotas = [
  ['/entrar', entrar.tela],
  ['/conta', conta.tela],
  ['/', inicio.tela],
  ['/nova', nota.nova],
  ['/clonar', nota.clonarUltima],
  ['/nota/:id', nota.tela],
  ['/nota/:id/revisao', revisao.tela],
  ['/nota/:id/resultado', resultado.tela],
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
];

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

let renderizando = 0;
async function renderizar() {
  const meu = ++renderizando;
  const [caminho, qs] = (location.hash.slice(1) || '/').split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  const main = document.getElementById('conteudo');
  if (!estado.conta && caminho !== '/entrar' && caminho !== '/instalar') return ir('/entrar', { substituir: true });

  const rota = casar(caminho) || casar('/');
  main.replaceChildren(carregando());
  let tela;
  try {
    tela = await rota.fn(rota.params, query);
  } catch (e) {
    tela = {
      titulo: 'Ops',
      node: h('div', { class: 'cartao cartao-erro', role: 'alert' },
        h('p', {}, e instanceof ErroApi ? e.message : 'Não foi possível abrir esta tela.'),
        h('a', { class: 'btn', href: '#/' }, 'Voltar ao início')),
    };
    if (!(e instanceof ErroApi)) console.error(e);
  }
  if (meu !== renderizando || !tela) return; // navegação mais nova em andamento
  document.getElementById('titulo').textContent = tela.titulo || 'Nota Sem Stress';
  document.title = `${tela.titulo ? `${tela.titulo} · ` : ''}Nota Sem Stress`;
  document.getElementById('voltar').hidden = !tela.voltar;
  document.getElementById('abas').hidden = !estado.conta || tela.semAbas;
  for (const a of document.querySelectorAll('.abas a')) {
    if (a.dataset.aba === tela.aba) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  main.replaceChildren(tela.node);
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

export async function atualizarSelo() {
  const ambiente = estado.inicio?.perfil?.ambiente;
  document.getElementById('selo-ambiente').hidden = !(ambiente === 'producao_restrita' || !estado.inicio?.perfil);
}

export async function carregarConta({ permitirOffline = true, substituirTitular = false, usuarioEsperado } = {}) {
  try {
    const conta = await api('GET', '/api/conta');
    if (!conta?.usuarioId) throw new ErroApi(401, { erro: 'Não foi possível confirmar o titular da conta.' });
    if (usuarioEsperado && usuarioEsperado !== conta.usuarioId) throw new ErroApi(401, { erro: 'A conta mudou em outra aba. Entre novamente.' });
    if (!substituirTitular && estado.conta && estado.conta.usuarioId !== conta.usuarioId) {
      window.dispatchEvent(new CustomEvent('notavez:sessao-expirada'));
      throw new ErroApi(401, { erro: 'A conta mudou em outra aba. Entre novamente.' });
    }
    estado.inicio = null;
    estado.conta = await definirConta(conta);
  } catch (e) {
    estado.conta = permitirOffline && e instanceof ErroApi && e.status === 0 ? await recuperarContaOffline() : await definirConta(null);
    if (!permitirOffline) throw e;
  }
  return estado.conta;
}

export async function sair() {
  // Sem resposta do servidor, o cookie pode continuar válido. Não reativar a
  // conta localmente; uma nova entrada confirmará o titular antes de sincronizar.
  try { await api('POST', '/api/conta/sair', {}); } catch { /* sessão local encerra */ }
  try { await definirConta(null); } catch { aviso('Não foi possível limpar a sessão local. Apague o armazenamento do site antes de emprestar este aparelho.'); }
  estado.conta = null;
  estado.inicio = null;
  estado.ultimoResultado = null;
  aviso('Você saiu. Seus rascunhos ficam neste aparelho e só aparecem ao entrar na mesma conta.');
  ir('/entrar');
}

function atualizarOnline() {
  document.getElementById('faixa-offline').hidden = navigator.onLine;
  if (navigator.onLine && estado.conta) carregarConta({ permitirOffline: false }).then(() => { renderizar(); return sincronizarTodos(); }).catch(() => ir('/entrar'));
}

document.getElementById('voltar').addEventListener('click', () => {
  if (history.length > 1) history.back(); else ir('/');
});
window.addEventListener('hashchange', renderizar);
window.addEventListener('online', atualizarOnline);
window.addEventListener('offline', atualizarOnline);
window.addEventListener('notavez:sessao-expirada', async () => {
  estado.conta = null;
  estado.inicio = null;
  estado.ultimoResultado = null;
  renderizando++;
  try { await definirConta(null); } catch { /* identidade em memória já encerrada */ }
  aviso('Sua sessão terminou. Seus rascunhos continuam guardados para a mesma conta. Entre novamente.');
  ir('/entrar');
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
try {
  const saude = await (await fetch('/api/saude')).json();
  estado.demo = !!saude.demo;
} catch { /* sem internet */ }
document.getElementById('faixa-demo').hidden = !estado.demo;
if (!(await sessaoEncerrada())) await carregarConta();
if (estado.conta && navigator.onLine) sincronizarTodos().catch(() => {});
if (await temLegadoEmQuarentena()) aviso('Há rascunhos antigos sem titular identificado. Eles foram preservados separadamente e não serão exibidos nem enviados por outra conta.');
renderizar();
