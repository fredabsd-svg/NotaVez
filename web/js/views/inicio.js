import { h, moeda, data, icone, ICONES, situacaoSelo, aviso } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { comCache, rascunhosLocais } from '../store.js';
import { estado, atualizarSelo, sair } from '../app.js';

export function pendenciasCartao(eleg, { compacto = false } = {}) {
  if (!eleg || eleg.podeEmitir) return null;
  return h('section', { class: 'cartao cartao-alerta', 'aria-labelledby': 'falta' },
    h('h2', { id: 'falta', style: 'font-size:19px;margin-top:0' }, 'Falta pouco para emitir'),
    h('p', {}, 'Você já pode preparar notas. Elas ficam como rascunho até tudo estar pronto:'),
    h('ul', { class: 'check' }, eleg.pendencias.map((p) => h('li', {}, h('span', { class: 'nao', 'aria-hidden': 'true' }, '✕'),
      h('span', {}, h('strong', {}, p.titulo), h('br'), h('span', { class: 'suave' }, p.comoResolver))))),
    compacto ? null : h('a', { class: 'btn btn-pequeno', href: '#/perfil' }, 'Resolver nos dados da empresa'));
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
        h('p', {}, 'Primeiro, cadastre a empresa pelo CNPJ: buscamos os dados na Receita para você.'),
        h('a', { class: 'btn btn-primario btn-grande', href: '#/empresas/nova' }, 'Cadastrar empresa')),
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

  const botao = (href, ic, titulo, sub, extra = {}) => h('a', { class: `btn ${extra.primario ? 'btn-primario' : ''}`, href, ...extra.attrs },
    icone(ic), h('span', {}, titulo), sub ? h('small', {}, sub) : null);
  const clonar = dados.podeClonar
    ? botao('#/clonar', ICONES.clonar, 'Clonar última nota', 'Refaz a nota do mês')
    : h('button', { class: 'btn', type: 'button', 'aria-disabled': 'true', onclick: () => aviso('Depois da primeira nota emitida desta empresa, você poderá cloná-la aqui.') },
      icone(ICONES.clonar), h('span', {}, 'Clonar última nota'), h('small', {}, 'Após a 1ª emissão'));
  const p = dados.perfil;
  const regime = p.opSimpNac === '2' ? 'MEI' : p.opSimpNac === '3' ? 'Simples Nacional' : p.apuracao === 'real' ? 'Lucro Real' : 'Lucro Presumido';

  return {
    titulo: 'Início', aba: 'inicio',
    node: h('div', {},
      h('p', { class: 'suave' }, [p.documentoFormatado, regime, p.municipio ? `${p.municipio.nome} - ${p.municipio.uf}` : null].filter(Boolean).join(' · ')),
      p.ambiente === 'producao_restrita'
        ? h('p', { class: 'cartao cartao-alerta', style: 'font-size:15px' }, 'Ambiente de testes da Receita: as notas emitidas aqui não têm validade jurídica.')
        : null,
      pendenciasCartao(dados.elegibilidade),
      dados.pendentes ? h('a', { class: 'cartao cartao-alerta', href: '#/notas?situacao=pendente', style: 'display:block;color:inherit' },
        h('strong', {}, `${dados.pendentes} nota(s) pendente(s) de confirmação.`), ' Não emita de novo — toque para verificar.') : null,
      h('nav', { class: 'grade-acoes', 'aria-label': 'Ações desta empresa' },
        botao('#/nova', ICONES.mais, 'Emitir nota', 'NFS-e de serviço', { primario: true }),
        clonar,
        botao('#/notas', ICONES.documento, 'Notas emitidas', 'Histórico, PDF e XML'),
        botao('#/tomadas', ICONES.recebida, 'Notas tomadas', 'Recebidas de fornecedores'),
        botao('#/notas?situacao=rascunho', ICONES.rascunho, 'Rascunhos', `${dados.rascunhos || 0} na conta${locais ? ` · ${locais} no aparelho` : ''}`),
        botao('#/clientes', ICONES.pessoas, 'Clientes', 'Tomadores salvos'),
        botao('#/servicos', ICONES.servico, 'Serviços salvos', 'Descrições prontas'),
        botao('#/perfil', ICONES.ajustes, 'Dados da empresa', 'Regime e certificado')),
      h('h3', {}, 'Última emissão'),
      ultima,
      h('a', { class: 'btn btn-texto', href: '#/empresas' }, icone(ICONES.empresa), 'Trocar de empresa'),
      h('a', { class: 'btn btn-texto', href: '#/instalar' }, 'Instalar na tela inicial'),
      // O app fica conectado no aparelho; sair leva de volta à tela de usuário e senha.
      h('h3', {}, 'Conta'),
      h('p', { class: 'suave' }, `Conectado como ${estado.conta?.documentoFormatado || estado.conta?.email || 'você'}.`),
      h('a', { class: 'btn btn-texto', href: '#/conta' }, 'Minha conta e gov.br'),
      h('button', { class: 'btn btn-texto', type: 'button', onclick: sair }, 'Sair da conta')),
  };
}
