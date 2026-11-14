// Filtro de competência das listas de notas (emitidas e tomadas): um mês, um atalho
// (últimos 3 meses, este ano, ano passado) ou um período digitado (de/até).
// Na rota: ?mes=AAAA-MM ou ?de=AAAA-MM-DD&ate=AAAA-MM-DD. Na API: ?competencia= ou ?de=&ate=.
import { h, campo, nomeMes, hoje, data } from './ui.js';

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const dois = (n) => String(n).padStart(2, '0');
const ultimoDia = (a, m) => new Date(Date.UTC(a, m, 0)).getUTCDate();

export function periodoDaRota(query = {}) {
  let de = DIA.test(query.de || '') ? query.de : '';
  let ate = DIA.test(query.ate || '') ? query.ate : '';
  if (de && ate && de > ate) [de, ate] = [ate, de];
  const mes = !de && !ate && /^\d{4}-\d{2}$/.test(query.mes || '') ? query.mes : '';
  return { mes, de, ate };
}
export const temPeriodo = (p) => !!(p.mes || p.de || p.ate);
export const paramsDaRota = (p) => ({ ...(p.mes ? { mes: p.mes } : {}), ...(p.de ? { de: p.de } : {}), ...(p.ate ? { ate: p.ate } : {}) });
export const paramsDaApi = (p) => ({ ...(p.mes ? { competencia: p.mes } : {}), ...(p.de ? { de: p.de } : {}), ...(p.ate ? { ate: p.ate } : {}) });
export const dentroDoPeriodo = (p, competencia) => {
  const c = String(competencia || '').slice(0, 10);
  if (p.mes) return c.startsWith(p.mes);
  return (!p.de || (c && c >= p.de)) && (!p.ate || (c && c <= p.ate));
};

const maiuscula = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export function rotuloPeriodo(p, todas = 'Todas as competências') {
  if (p.mes) return maiuscula(nomeMes(p.mes));
  if (p.de && p.ate) return `De ${data(p.de)} a ${data(p.ate)}`;
  if (p.de) return `A partir de ${data(p.de)}`;
  if (p.ate) return `Até ${data(p.ate)}`;
  return todas;
}
// Pedaço do nome de arquivo: 2026-10, 2026-01-01_a_2026-03-31 ou todas.
export const periodoNoArquivo = (p) => p.mes || (p.de || p.ate ? `${p.de || 'inicio'}_a_${p.ate || 'hoje'}` : 'todas');

function atalhos() {
  const [a, m] = hoje().split('-').map(Number);
  let a3 = a;
  let m3 = m - 2;
  if (m3 < 1) { m3 += 12; a3 -= 1; }
  return [
    ['3m', 'Últimos 3 meses', { de: `${a3}-${dois(m3)}-01`, ate: `${a}-${dois(m)}-${dois(ultimoDia(a, m))}` }],
    ['ano', `Este ano (${a})`, { de: `${a}-01-01`, ate: `${a}-12-31` }],
    ['ano-1', `Ano passado (${a - 1})`, { de: `${a - 1}-01-01`, ate: `${a - 1}-12-31` }],
  ];
}

// Devolve { seletor, datas }: o seletor vai na barra da lista; as datas, logo abaixo (aparecem em "Escolher datas").
export function filtroPeriodo({ meses = [], periodo, aoMudar, todas = 'Todas as competências' }) {
  const lista = atalhos();
  const atalho = !periodo.mes && lista.find(([, , p]) => p.de === periodo.de && p.ate === periodo.ate);
  const digitado = !periodo.mes && !atalho && (periodo.de || periodo.ate);
  const atual = periodo.mes || (atalho ? atalho[0] : digitado ? 'datas' : '');
  const todosMeses = periodo.mes && !meses.includes(periodo.mes) ? [periodo.mes, ...meses] : meses;

  const seletor = campo({ rotulo: 'Competência', rotuloOculto: true, opcoes: [['', todas]], valor: '' });
  seletor.classList.add('campo-mes');
  seletor.entrada.append(
    h('optgroup', { label: 'Períodos' },
      lista.map(([v, t]) => h('option', { value: v }, t)),
      h('option', { value: 'datas' }, digitado ? rotuloPeriodo(periodo) : 'Escolher datas (de/até)…')),
    todosMeses.length ? h('optgroup', { label: 'Meses' }, todosMeses.map((m) => h('option', { value: m }, maiuscula(nomeMes(m))))) : null,
  );
  seletor.entrada.value = atual;

  const cDe = campo({ rotulo: 'Competência de', tipo: 'date', valor: periodo.de || '' });
  const cAte = campo({ rotulo: 'até', tipo: 'date', valor: periodo.ate || '' });
  const datas = h('form', { class: 'periodo-datas', hidden: atual !== 'datas', novalidate: true,
    onsubmit: (e) => {
      e.preventDefault();
      let de = cDe.entrada.value;
      let ate = cAte.entrada.value;
      cDe.erro('');
      if (!de && !ate) { cDe.erro('Informe pelo menos uma das datas.'); cDe.entrada.focus(); return; }
      if (de && ate && de > ate) [de, ate] = [ate, de];
      aoMudar({ de, ate });
    } },
  cDe, cAte, h('button', { class: 'btn btn-primario', type: 'submit' }, 'Aplicar'));

  seletor.entrada.addEventListener('change', () => {
    const v = seletor.entrada.value;
    if (v === 'datas') {
      datas.hidden = false;
      if (!cDe.entrada.value && !cAte.entrada.value) { cDe.entrada.value = `${hoje().slice(0, 7)}-01`; cAte.entrada.value = hoje(); }
      cDe.entrada.focus();
      return;
    }
    datas.hidden = true;
    const a = lista.find(([id]) => id === v);
    aoMudar(a ? a[2] : v ? { mes: v } : {});
  });
  return { seletor, datas };
}
