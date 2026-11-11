import { h, anexar, moeda, data, situacaoSelo, campo, nomeMes, vazio, icone, ICONES, plural, aviso, baixarArquivo } from '../ui.js';
import { api } from '../api.js';
import { comCache, rascunhosLocais } from '../store.js';
import { ir, estado } from '../app.js';
import { botaoImportarXml } from './assistida.js';
import { rascunhoEmBranco } from '../rascunho.js';

const FILTROS = [['', 'Todas'], ['emitida', 'Emitidas'], ['pendente', 'Pendentes'], ['rejeitada', 'Rejeitadas'], ['rascunho', 'Rascunhos']];
const empresaEmTestes = () => estado.conta?.empresaAmbiente === 'producao_restrita';

// Uma nota numa linha: cliente e valor em destaque; número, competência e situação como apoio.
// No computador as mesmas partes viram colunas alinhadas (ver .linha-nota no CSS).
export function linhaNota(n, { compacta = false } = {}) {
  // Só nota já enviada tem ambiente; avisa quando ele não é o ambiente atual da empresa.
  const outroAmbiente = n.ambiente && !!n.homologacao !== empresaEmTestes() ? (n.homologacao ? 'testes' : 'produção') : null;
  return h('a', { class: `linha-nota${compacta ? ' compacta' : ''}`, href: n.situacao === 'rascunho' && !n.erros?.length ? `#/nota/${n.id}` : `#/notas/${n.id}` },
    partesDaLinha({ cliente: n.clienteNome || 'Sem cliente', numero: n.nNfse ? `NFS-e nº ${n.nNfse}` : '',
      competencia: [data(n.competencia), outroAmbiente].filter(Boolean).join(' · '), situacao: situacaoSelo(n), valor: moeda(n.valor) }));
}

// Duas linhas no celular (cliente + valor; número · competência + situação); no computador, uma coluna para cada parte.
// `documento` (CNPJ/CPF do fornecedor, nas notas tomadas) acrescenta uma coluna: a linha leva a classe "com-doc".
export const partesDaLinha = ({ cliente, documento, numero, competencia, situacao, valor }) => [
  h('span', { class: 'ln-l1' }, h('span', { class: 'ln-cliente' }, cliente), h('span', { class: 'ln-valor' }, valor)),
  h('span', { class: 'ln-l2' },
    h('span', { class: 'ln-meta' }, documento === undefined ? null : h('span', { class: 'ln-doc' }, documento),
      h('span', { class: 'ln-num' }, numero), h('span', { class: 'ln-comp' }, competencia)),
    h('span', { class: 'ln-sit' }, situacao))];

// Cabeçalho das colunas (só no computador; cada linha já se lê sozinha, por isso fica fora da leitura de tela).
export const cabecalhoNotas = () => h('div', { class: 'cab-notas', 'aria-hidden': 'true' },
  h('span', {}, 'Cliente'), h('span', { class: 'ln-num' }, 'Número'), h('span', {}, 'Competência'), h('span', {}, 'Situação'), h('span', {}, 'Valor'));

// Lista em CSV para o contador: ponto e vírgula e vírgula decimal, como as planilhas em português esperam.
function exportarCsv(lista, nomeArquivo) {
  // Texto que começa com = + - @ seria lido como fórmula pela planilha: vai com apóstrofo na frente.
  const celula = (v) => { const s = String(v ?? ''); return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`; };
  const linhas = [['Competência', 'Número da NFS-e', 'Cliente', 'Situação', 'Valor (R$)', 'Chave de acesso', 'Ambiente'],
    ...lista.map((n) => [data(n.competencia), n.nNfse || '', n.clienteNome || '', n.rotulo || n.situacao,
      n.valor ? Number(n.valor).toFixed(2).replace('.', ',') : '', n.chaveAcesso || '', n.ambiente ? (n.homologacao ? 'Testes' : 'Produção') : ''])];
  baixarArquivo(nomeArquivo, `﻿${linhas.map((l) => l.map(celula).join(';')).join('\r\n')}\r\n`, 'text/csv;charset=utf-8');
}

export async function tela(_, query) {
  const filtro = query.situacao || '';
  const mes = /^\d{4}-\d{2}$/.test(query.mes || '') ? query.mes : '';
  // Competência filtrada no servidor: com centenas de notas, o mês escolhido vem completo.
  const qs = new URLSearchParams({ ...(filtro ? { situacao: filtro } : {}), ...(mes ? { competencia: mes } : {}) }).toString();
  const { notas, limitado, meses: mesesServidor } = await comCache(`notas:${qs}`, () => api('GET', `/api/notas${qs ? `?${qs}` : ''}`));
  const rota = (situacao, m) => { const p = new URLSearchParams({ ...(situacao ? { situacao } : {}), ...(m ? { mes: m } : {}) }).toString(); return `/notas${p ? `?${p}` : ''}`; };
  const soAparelho = (await rascunhosLocais()).filter((r) => !r.noServidor && !rascunhoEmBranco(r));
  const mostrarLocais = soAparelho.length > 0 && (!filtro || filtro === 'rascunho');

  // Competência (mês) e busca: o contador fecha o mês olhando a lista e o total.
  const meses = mesesServidor || [...new Set(notas.map((n) => String(n.competencia || '').slice(0, 7)).filter(Boolean))].sort().reverse();
  if (mes && !meses.includes(mes)) meses.unshift(mes);
  let termo = '';
  let visiveis = notas;
  const resumo = h('p', { class: 'resumo-lista', role: 'status' });
  const corpo = h('div', {});
  // Total só do ambiente atual da empresa: notas de testes não somam com as de produção.
  const totalEmitido = (lista) => {
    const emitidas = lista.filter((n) => n.situacao === 'emitida' && !!n.homologacao === empresaEmTestes());
    return { qtd: emitidas.length, total: emitidas.reduce((soma, n) => soma + Math.round(Number(n.valor || 0) * 100), 0) / 100 };
  };
  const mostrar = () => {
    const t = termo.toLowerCase().trim();
    visiveis = notas.filter((n) => (!t || (n.clienteNome || '').toLowerCase().includes(t) || (n.nNfse || '').includes(t) || (n.chaveAcesso || '').includes(t.replace(/\s/g, ''))));
    // Um bloco por competência, da mais recente para a mais antiga; dentro do mês, a ordem do servidor (última alteração).
    const porMes = new Map();
    for (const n of visiveis) { const m = String(n.competencia || '').slice(0, 7); if (!porMes.has(m)) porMes.set(m, []); porMes.get(m).push(n); }
    const grupos = [...porMes.entries()].sort(([a], [b]) => (a === b ? 0 : !a ? -1 : !b ? 1 : b.localeCompare(a)));
    corpo.replaceChildren();
    if (grupos.length) corpo.append(cabecalhoNotas());
    for (const [m, lista] of grupos) {
      const e = totalEmitido(lista);
      corpo.append(h('section', { class: 'grupo-mes' },
        h('div', { class: 'secao-titulo' }, h('h3', {}, m ? nomeMes(m) : 'Sem competência'),
          // Com a lista cortada (mais de 200), o total do mês poderia sair incompleto: fica só a contagem.
          h('span', { class: 'secao-extra' }, e.qtd && !limitado ? `${moeda(e.total)} em ${plural(e.qtd, 'emitida', 'emitidas')}` : plural(lista.length, 'nota', 'notas'))),
        h('ul', { class: 'lista' }, lista.map((n) => h('li', {}, linhaNota(n))))));
    }
    if (!visiveis.length && !mostrarLocais) {
      corpo.append(notas.length || mes || filtro || t
        ? vazio({ icone: ICONES.busca, titulo: 'Nenhuma nota com estes filtros', texto: 'Mude a situação, a competência ou o texto da busca.',
          acoes: [h('a', { class: 'btn', href: '#/notas' }, 'Limpar filtros')] })
        : vazio({ titulo: 'Suas notas aparecem aqui', texto: 'Emitidas, pendentes, rejeitadas e rascunhos desta empresa ficam nesta lista, separados por mês.',
          acoes: [h('a', { class: 'btn btn-primario', href: '#/nova' }, icone(ICONES.mais), 'Nova nota')] }));
    }
    const e = totalEmitido(visiveis);
    resumo.replaceChildren(); anexar(resumo, h('span', {}, h('strong', {}, String(visiveis.length)), visiveis.length === 1 ? ' nota' : ' notas'),
      e.qtd ? h('span', {}, mes ? 'Emitidas no mês: ' : 'Emitidas: ', h('strong', {}, moeda(e.total))) : null,
      limitado ? h('span', {}, `Mostrando as ${notas.length} mais recentes: escolha a competência para ver as demais.`) : null);
    exportar.hidden = !visiveis.length;
  };
  const exportar = h('button', { class: 'btn btn-pequeno', type: 'button', title: 'Baixa a lista mostrada em planilha (CSV), para você ou para o contador',
    onclick: () => {
      exportarCsv(visiveis, `notas-${mes || 'todas'}${filtro ? `-${filtro}` : ''}.csv`);
      aviso(`${plural(visiveis.length, 'nota exportada', 'notas exportadas')}.${limitado ? ' A lista traz só as mais recentes: escolha a competência para exportar o mês inteiro.' : ''}`, limitado ? 8000 : 4000);
    } }, icone(ICONES.baixar), 'Exportar CSV');
  mostrar();
  const seletorMes = meses.length > 1 || mes ? campo({
    rotulo: 'Competência', rotuloOculto: true, tipo: 'select', valor: mes,
    opcoes: [['', 'Todos os meses'], ...meses.map((m) => [m, nomeMes(m)])],
    onchange: (e) => ir(rota(filtro, e.target.value), { substituir: true }),
  }) : null;
  seletorMes?.classList.add('campo-mes');
  const busca = campo({ rotulo: 'Pesquisar notas', rotuloOculto: true,
    atributos: { type: 'search', autocomplete: 'off', placeholder: 'Buscar cliente, número ou chave' }, oninput: (e) => { termo = e.target.value; mostrar(); } });
  busca.classList.add('busca-icone');

  return {
    titulo: 'Notas', aba: 'notas',
    node: h('div', {},
      h('div', { class: 'filtro-abas', role: 'group', 'aria-label': 'Filtrar por situação' }, FILTROS.map(([v, t]) => h('button', {
        type: 'button', 'aria-pressed': String(v === filtro), onclick: () => ir(rota(v, mes), { substituir: true }),
      }, t))),
      h('div', { class: 'barra-lista' }, busca, seletorMes, exportar),
      resumo,
      mostrarLocais
        ? h('section', { class: 'grupo-mes' }, h('div', { class: 'secao-titulo' }, h('h3', {}, 'Só neste aparelho (sem internet)')),
          h('ul', { class: 'lista' }, soAparelho.map((r) => h('li', {}, h('a', { class: 'linha-nota', href: `#/nota/${r.id}` },
            partesDaLinha({ cliente: r.meta?.cliente?.nome || 'Rascunho sem cliente', numero: '', competencia: r.rascunho.competencia ? data(r.rascunho.competencia) : '',
              situacao: h('span', { class: 'situacao s-rascunho' }, 'Rascunho · não emitida'), valor: moeda(r.rascunho.valor) }))))))
        : null,
      corpo,
      // Notas emitidas direto no Emissor Nacional também entram no histórico pelo XML.
      h('div', { class: 'cartao' }, h('p', { class: 'suave' }, 'Emitiu uma nota direto no Emissor Nacional? Traga o XML para ter o histórico, o PDF e poder clonar.'),
        botaoImportarXml({ texto: 'Importar XML', classe: 'btn' }))),
  };
}
