import { h, moeda, data, icone, ICONES, situacaoSelo, aviso } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { comCache, rascunhosLocais } from '../store.js';
import { estado, atualizarSelo } from '../app.js';

export function pendenciasCartao(eleg, { compacto = false } = {}) {
  if (!eleg || eleg.podeEmitir) return null;
  return h('section', { class: 'cartao cartao-alerta', 'aria-labelledby': 'falta' },
    h('h2', { id: 'falta', style: 'font-size:19px;margin-top:0' }, 'Falta pouco para emitir'),
    h('p', {}, 'Você já pode preparar notas. Elas ficam como rascunho até tudo estar pronto:'),
    h('ul', { class: 'check' }, eleg.pendencias.map((p) => h('li', {}, h('span', { class: 'nao', 'aria-hidden': 'true' }, '✕'),
      h('span', {}, h('strong', {}, p.titulo), h('br'), h('span', { class: 'suave' }, p.comoResolver))))),
    compacto ? null : h('a', { class: 'btn btn-pequeno', href: '#/perfil' }, 'Resolver no Perfil'));
}

export async function tela() {
  let dados;
  try {
    dados = await comCache('inicio', () => api('GET', '/api/inicio'));
  } catch (e) {
    if (!(e instanceof ErroApi)) throw e;
    dados = { elegibilidade: null };
  }
  estado.inicio = dados;
  atualizarSelo();
  const locais = (await rascunhosLocais()).filter((r) => !r.sincronizado).length;

  if (!dados.perfil) {
    return {
      titulo: 'Início', aba: 'inicio',
      node: h('div', {},
        h('h2', {}, 'Bem-vindo ao Nota Sem Stress'),
        h('p', {}, 'Primeiro, preencha seu perfil fiscal (CNPJ, município e regime). Leva um minuto.'),
        h('a', { class: 'btn btn-primario btn-grande', href: '#/perfil' }, 'Preencher perfil')),
    };
  }

  const u = dados.ultima;
  const ultima = u
    ? h('a', { class: 'item', href: `#/notas/${u.id}` },
      h('div', { class: 'item-corpo' },
        h('div', { class: 'item-titulo' }, u.clienteNome || 'Sem cliente'),
        h('div', { class: 'item-sub' }, u.nNfse ? `NFS-e nº ${u.nNfse} · ` : '', data(u.competencia)),
        h('div', { style: 'margin-top:6px' }, situacaoSelo(u))),
      h('div', { class: 'item-valor' }, moeda(u.valor)))
    : h('p', { class: 'suave' }, 'Você ainda não enviou nenhuma nota.');

  const clonar = dados.podeClonar
    ? h('a', { class: 'btn', href: '#/clonar' }, icone(ICONES.clonar), 'Clonar última nota')
    : h('button', { class: 'btn', type: 'button', 'aria-disabled': 'true', onclick: () => aviso('Depois da sua primeira nota emitida, você poderá cloná-la aqui.') }, icone(ICONES.clonar), 'Clonar última nota');

  return {
    titulo: 'Início', aba: 'inicio',
    node: h('div', {},
      dados.perfil.ambiente === 'producao_restrita'
        ? h('p', { class: 'cartao cartao-alerta', style: 'font-size:15px' }, 'Ambiente de testes da Receita: as notas emitidas aqui não têm validade jurídica.')
        : null,
      pendenciasCartao(dados.elegibilidade),
      dados.pendentes ? h('a', { class: 'cartao cartao-alerta', href: '#/notas?situacao=pendente', style: 'display:block;color:inherit' },
        h('strong', {}, `${dados.pendentes} nota(s) pendente(s) de confirmação.`), ' Não emita de novo — toque para verificar.') : null,
      h('a', { class: 'btn btn-primario btn-grande', href: '#/nova' }, icone(ICONES.mais), 'Emitir nota'),
      clonar,
      h('a', { class: 'btn', href: '#/clientes' }, icone(ICONES.pessoas), 'Clientes'),
      h('h3', {}, 'Última emissão'),
      ultima,
      h('h3', {}, 'Atalhos'),
      h('a', { class: 'item', href: '#/servicos' }, h('div', { class: 'item-corpo' }, h('div', { class: 'item-titulo' }, 'Serviços salvos'), h('div', { class: 'item-sub' }, 'Descrições que você usa sempre'))),
      h('a', { class: 'item', href: '#/notas?situacao=rascunho' }, h('div', { class: 'item-corpo' },
        h('div', { class: 'item-titulo' }, 'Rascunhos'),
        h('div', { class: 'item-sub' }, `${dados.rascunhos || 0} na conta${locais ? ` · ${locais} só neste aparelho` : ''}`))),
      h('a', { class: 'item', href: '#/instalar' }, h('div', { class: 'item-corpo' }, h('div', { class: 'item-titulo' }, 'Instalar na tela inicial'), h('div', { class: 'item-sub' }, 'Android e iPhone')))),
  };
}
