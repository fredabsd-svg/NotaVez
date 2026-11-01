import { h, moeda, data, icone, ICONES, situacaoSelo, plural } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { comCache, rascunhosLocais } from '../store.js';
import { estado, atualizarSelo, sair } from '../app.js';
import { rascunhoEmBranco } from '../rascunho.js';

export function pendenciasCartao(eleg, { compacto = false } = {}) {
  if (!eleg || eleg.podeEmitir) return null;
  return h('section', { class: 'cartao cartao-alerta', 'aria-labelledby': 'falta' },
    h('h2', { id: 'falta', style: 'font-size:19px;margin-top:0' }, 'Falta pouco para emitir'),
    h('p', {}, 'Você já pode preparar notas. Elas ficam como rascunho até tudo estar pronto:'),
    h('ul', { class: 'check' }, eleg.pendencias.map((p) => h('li', {}, h('span', { class: 'nao', 'aria-hidden': 'true' }, '✕'),
      h('span', {}, h('strong', {}, p.titulo), h('br'), h('span', { class: 'suave' }, p.comoResolver))))),
    // Sem A1 ainda dá para emitir: no site oficial, com usuário e senha ou gov.br.
    eleg.pendencias.some((p) => String(p.id).startsWith('cert'))
      ? h('p', { class: 'suave' }, 'Sem certificado? Você pode emitir pelo Emissor Nacional com usuário e senha ou gov.br: crie a nota e, na revisão, toque em "Emitir pelo Emissor Nacional".')
      : null,
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
  const locais = (await rascunhosLocais()).filter((r) => !r.sincronizado && !(!r.noServidor && rascunhoEmBranco(r.rascunho))).length;

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

  const atalho = (href, ic, titulo, sub) => h('li', {}, h('a', { class: 'item item-seta', href },
    icone(ic), h('div', { class: 'item-corpo' }, h('div', { class: 'item-titulo' }, titulo), sub ? h('div', { class: 'item-sub' }, sub) : null)));
  const p = dados.perfil;
  const regime = p.opSimpNac === '2' ? 'MEI' : p.opSimpNac === '3' ? 'Simples Nacional' : p.apuracao === 'real' ? 'Lucro Real' : 'Lucro Presumido';
  const rascunhos = (dados.rascunhos || 0) + locais;

  return {
    titulo: 'Início', aba: 'inicio',
    node: h('div', {},
      h('p', { class: 'suave', style: 'margin-top:0' }, [regime, p.municipio ? `${p.municipio.nome} - ${p.municipio.uf}` : null].filter(Boolean).join(' · ')),
      // Um único alerta por vez, do mais urgente ao menos urgente.
      dados.pendentes
        ? h('a', { class: 'alerta-linha', href: '#/notas?situacao=pendente', role: 'alert' },
          h('span', {}, `${plural(dados.pendentes, 'nota aguarda', 'notas aguardam')} confirmação da Receita. Não emita de novo.`), 'Verificar ›')
        : dados.elegibilidade && !dados.elegibilidade.podeEmitir
          // Uma linha no Início; a lista completa fica em Dados da empresa.
          ? h('a', { class: 'alerta-linha', href: '#/perfil' },
            h('span', {}, `Falta pouco para emitir pelo app: ${plural(dados.elegibilidade.pendencias.length, 'item pendente', 'itens pendentes')}. Enquanto isso, prepare a nota e emita pelo Emissor Nacional.`), 'Ver ›')
          : null,
      h('div', { class: 'acoes-inicio' },
        h('a', { class: 'btn btn-primario btn-grande', href: '#/nova' }, icone(ICONES.mais), 'Nova nota'),
        dados.podeClonar
          ? h('a', { class: 'btn', href: '#/clonar' }, icone(ICONES.clonar), 'Clonar a última emitida')
          : null),
      h('h3', {}, 'Última nota enviada'),
      ultima,
      // O "Clonar" copia a última EMITIDA; se a última enviada foi outra (rejeitada, pendente), mostra qual.
      dados.ultimaEmitida ? h('p', { class: 'suave' }, 'O botão "Clonar" copia a última emitida: ',
        h('a', { href: `#/notas/${dados.ultimaEmitida.id}` }, `${dados.ultimaEmitida.nNfse ? `NFS-e nº ${dados.ultimaEmitida.nNfse}` : 'nota'} · ${dados.ultimaEmitida.clienteNome || 'sem cliente'} · ${moeda(dados.ultimaEmitida.valor)}`), '.') : null,
      h('h3', {}, 'Atalhos'),
      h('ul', { class: 'atalhos' },
        rascunhos ? atalho('#/notas?situacao=rascunho', ICONES.rascunho, 'Rascunhos', [dados.rascunhos ? `${plural(dados.rascunhos, 'salvo', 'salvos')} na conta` : null, locais ? `${locais} só neste aparelho` : null].filter(Boolean).join(' · ')) : null,
        atalho('#/servicos', ICONES.servico, 'Serviços salvos', 'Descrições prontas para a nota'),
        atalho('#/perfil', ICONES.ajustes, 'Dados da empresa', 'Regime, certificado e endereço'),
        atalho('#/conta', ICONES.pessoas, 'Minha conta', `Conectado como ${estado.conta?.documentoFormatado || estado.conta?.email || 'você'}`)),
      dados.podeClonar ? null : h('p', { class: 'suave' }, 'Depois da primeira nota emitida desta empresa, você poderá cloná-la no mês seguinte.'),
      // O app fica conectado no aparelho; sair leva de volta à tela de usuário e senha.
      h('button', { class: 'btn btn-texto', type: 'button', onclick: sair }, 'Sair da conta')),
  };
}
