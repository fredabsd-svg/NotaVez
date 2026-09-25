// Roteador e inicialização do PWA.
import { api, ErroApi } from './api.js';
import { h, aviso, carregando } from './ui.js';
import { kvLer, kvGravar, limparTudo, sincronizarTodos } from './store.js';
import * as entrar from './views/entrar.js';
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
  document.getElementById('titulo').textContent = tela.titulo || 'NotaVez';
  document.title = `${tela.titulo ? `${tela.titulo} · ` : ''}NotaVez`;
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

export async function carregarConta() {
  try {
    estado.conta = await api('GET', '/api/conta');
    await kvGravar('conta', estado.conta);
  } catch (e) {
    estado.conta = e instanceof ErroApi && e.status === 0 ? await kvLer('conta') : null;
  }
  return estado.conta;
}

export async function sair() {
  try { await api('POST', '/api/conta/sair', {}); } catch { /* segue */ }
  await limparTudo();
  estado.conta = null;
  estado.inicio = null;
  ir('/entrar');
}

function atualizarOnline() {
  document.getElementById('faixa-offline').hidden = navigator.onLine;
  if (navigator.onLine) sincronizarTodos().catch(() => {});
}

document.getElementById('voltar').addEventListener('click', () => {
  if (history.length > 1) history.back(); else ir('/');
});
window.addEventListener('hashchange', renderizar);
window.addEventListener('online', atualizarOnline);
window.addEventListener('offline', atualizarOnline);
window.addEventListener('notavez:sessao-expirada', async () => {
  estado.conta = null;
  await limparTudo();
  aviso('Sua sessão terminou. Entre novamente.');
  ir('/entrar');
});

let pedidoInstalacao = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); pedidoInstalacao = e; });
export const pedirInstalacao = () => pedidoInstalacao;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

atualizarOnline();
try {
  const saude = await (await fetch('/api/saude')).json();
  estado.demo = !!saude.demo;
} catch { /* sem internet */ }
document.getElementById('faixa-demo').hidden = !estado.demo;
await carregarConta();
renderizar();
