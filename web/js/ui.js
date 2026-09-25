// Utilitários de interface: criação de elementos sem innerHTML (evita XSS),
// formatação em pt-BR e componentes simples e acessíveis.
export function h(tag, attrs = {}, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // via CSSOM: permitido pela CSP
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat(Infinity)) {
    if (f === null || f === undefined || f === false) continue;
    el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return el;
}

// Element.append nativo converte null em texto "null": use este para filhos opcionais.
export const anexar = (el, ...filhos) => { el.append(...filhos.flat().filter((f) => f !== null && f !== undefined && f !== false)); return el; };

export const moeda = (v) => (v === null || v === undefined || v === '' ? '—'
  : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
export const data = (iso) => {
  if (!iso) return '—';
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
};
export const dataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const hoje = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
export const chaveFormatada = (c) => (c ? c.replace(/(\d{4})(?=\d)/g, '$1 ') : '');

export function mascaraDocumento(v) {
  const s = String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 14);
  if (s.length <= 11 && /^\d*$/.test(s)) {
    return s.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  }
  return s.replace(/^(\w{2})(\w)/, '$1.$2').replace(/^(\w{2})\.(\w{3})(\w)/, '$1.$2.$3')
    .replace(/\.(\w{3})(\w)/, '.$1/$2').replace(/(\w{4})(\d{1,2})$/, '$1-$2');
}

export function aviso(texto, ms = 4000) {
  const caixa = document.getElementById('aviso');
  const m = h('div', {}, texto);
  caixa.append(m);
  setTimeout(() => m.remove(), ms);
}

export const icone = (d) => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d);
  svg.append(p);
  return h('span', { class: 'icone' }, svg);
};
export const ICONES = {
  mais: 'M12 5v14M5 12h14',
  clonar: 'M8 8h12v12H8zM4 16V4h12',
  pessoas: 'M9 11a4 4 0 100-8 4 4 0 000 8zM2 21a7 7 0 0114 0M16 3a4 4 0 010 8M22 21a7 7 0 00-5-6.7',
  lista: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  compartilhar: 'M4 12v8h16v-8M12 3v13M7 8l5-5 5 5',
  baixar: 'M12 3v13M7 11l5 5 5-5M4 21h16',
  abrir: 'M14 3h7v7M10 14L21 3M21 14v7H3V3h7',
  copiar: 'M9 9h11v11H9zM5 15H4V4h11v1',
  atualizar: 'M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5',
};

// Campo de formulário com rótulo, ajuda e mensagem de erro associadas (acessível).
let seq = 0;
export function campo({ rotulo, ajuda, erro, tipo = 'text', valor = '', nome, oninput, onchange, atributos = {}, area = false, opcoes }) {
  const id = `c${++seq}`;
  const idAjuda = ajuda ? `${id}-a` : undefined;
  const idErro = `${id}-e`;
  const props = {
    id, name: nome, 'aria-describedby': [idAjuda, idErro].filter(Boolean).join(' '),
    'aria-invalid': erro ? 'true' : undefined, oninput, onchange, ...atributos,
  };
  let entrada;
  if (opcoes) {
    entrada = h('select', props, opcoes.map(([v, t]) => h('option', { value: v, selected: String(v) === String(valor) }, t)));
  } else if (area) {
    entrada = h('textarea', props);
    entrada.value = valor ?? '';
  } else {
    entrada = h('input', { type: tipo, ...props });
    entrada.value = valor ?? '';
  }
  const msgErro = h('p', { class: 'erro-campo', id: idErro, hidden: !erro }, erro || '');
  const wrap = h('div', { class: 'campo' },
    h('label', { for: id }, rotulo, ajuda ? h('span', { class: 'ajuda', id: idAjuda }, ajuda) : null),
    entrada, msgErro);
  wrap.entrada = entrada;
  wrap.erro = (m) => {
    msgErro.textContent = m || '';
    msgErro.hidden = !m;
    if (m) entrada.setAttribute('aria-invalid', 'true'); else entrada.removeAttribute('aria-invalid');
  };
  return wrap;
}

export function mostrarErros(campos, erros = {}) {
  let primeiro = null;
  for (const [k, c] of Object.entries(campos)) {
    c.erro(erros[k]);
    if (erros[k] && !primeiro) primeiro = c.entrada;
  }
  primeiro?.focus();
}

export const situacaoSelo = (n) => h('span', { class: `situacao s-${n.situacao}` }, n.rotulo || n.situacao);

export function carregando(texto = 'Carregando…') {
  return h('div', { class: 'carregando', role: 'status' }, h('div', { class: 'girando', 'aria-hidden': 'true' }), texto);
}

// Busca com sugestões (usada para município e serviço nacional).
export function buscaComSugestoes({ rotulo, ajuda, placeholder, buscar, formatar, aoEscolher, valorInicial = '' }) {
  const lista = h('ul', { class: 'sugestoes', role: 'listbox', hidden: true });
  const c = campo({
    rotulo, ajuda, valor: valorInicial,
    atributos: { placeholder, autocomplete: 'off', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list' },
    oninput: async (e) => {
      const itens = await buscar(e.target.value);
      lista.replaceChildren(...itens.map((it) => h('li', { role: 'option' }, h('button', {
        type: 'button', onclick: () => { lista.hidden = true; c.entrada.setAttribute('aria-expanded', 'false'); aoEscolher(it, c); },
      }, formatar(it)))));
      lista.hidden = itens.length === 0;
      c.entrada.setAttribute('aria-expanded', String(itens.length > 0));
    },
  });
  c.append(lista);
  return c;
}
