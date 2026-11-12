import { h, moeda, data, icone, ICONES, plural, nomeMes } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { comCache, rascunhosLocais } from '../store.js';
import { estado, atualizarSelo, sair } from '../app.js';
import { rascunhoEmBranco } from '../rascunho.js';
import { linhaNota } from './historico.js';

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

const ALTURA_BARRA = 72; // px da maior barra (o trilho tem folga para o rótulo)
// Valor curto para caber em cima de uma barra: "1,2 mil".
const compacto = (v) => Number(v).toLocaleString('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const soMes = (m) => nomeMes(m).split(' de ')[0];

// Limite anual de receita do MEI: o quanto já foi emitido por aqui no ano, com a faixa dita em texto.
function cartaoLimite(pn) {
  const limite = Number(pn.limiteAnual.valor);
  const total = Number(pn.ano.total);
  const pct = limite > 0 ? (total / limite) * 100 : 0;
  const faixa = pct > 100 ? 'excedido' : pct >= 80 ? 'atencao' : '';
  const ano = pn.ano.ano;
  const situacao = pct > 120
    ? ['Mais de 20% acima do limite. ', `Pela regra do MEI, nesse caso o desenquadramento vale desde janeiro de ${ano} (ou desde a abertura, se a empresa abriu neste ano). Procure seu contador.`]
    : pct > 100
      ? [`Acima do limite em ${moeda(total - limite)}. `, 'Pela regra do MEI, com até 20% de excesso a empresa deixa de ser MEI a partir de janeiro do ano seguinte e recolhe um DAS complementar sobre o excesso. Procure seu contador.']
      : pct >= 80
        ? [`Atenção: restam ${moeda(limite - total)} até o limite de ${ano}. `, 'Vale conversar com seu contador antes de passar.']
        : [`Ainda cabem ${moeda(limite - total)} em ${ano}. `, ''];
  const texto = `${pct > 0 && pct < 1 ? 'menos de 1' : Math.round(pct)}% do limite`;
  return h('section', { class: 'cartao largo', 'aria-label': 'Limite anual do MEI' },
    h('div', { class: 'limite-cabecalho' }, h('strong', {}, 'Limite anual do MEI'), h('span', {}, `${moeda(total)} de ${moeda(limite)} · ${texto}`)),
    h('div', { class: `medidor ${faixa}`, role: 'progressbar', 'aria-label': 'Parte do limite anual do MEI já emitida por aqui',
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.min(100, Math.round(pct))), 'aria-valuetext': `${moeda(total)} de ${moeda(limite)}` },
    h('div', { class: 'medidor-fill', style: `width:${Math.min(100, pct).toFixed(1)}%` })),
    h('p', { class: 'limite-nota' }, h('strong', {}, situacao[0]), situacao[1]),
    h('p', { class: 'limite-nota' }, `Conta só as notas emitidas por aqui: vendas sem nota também entram no limite. No ano de abertura do MEI, o limite é de ${moeda(pn.limiteAnual.porMesNoAnoDeAbertura)} por mês de atividade.`));
}

// Resumo do mês e do ano, por competência, só do ambiente atual da empresa.
function painel(dados) {
  const pn = dados.painel;
  if (!pn?.meses?.length) return null; // cópia guardada por uma versão anterior do app
  if (!dados.emitidas) {
    return h('p', { class: 'cartao suave' }, 'Depois da primeira nota emitida desta empresa, o resumo do mês e o total do ano aparecem aqui, e você poderá cloná-la no mês seguinte.');
  }
  const atual = pn.meses[pn.meses.length - 1];
  const anterior = pn.meses[pn.meses.length - 2];
  const maior = Math.max(...pn.meses.map((m) => Number(m.total)));
  const testes = pn.ambiente === 'producao_restrita';
  const barra = (m) => {
    const descricao = `${nomeMes(m.mes)}: ${moeda(m.total)} em ${plural(m.qtd, 'nota emitida', 'notas emitidas')}`;
    const ehAtual = m === atual;
    return h('a', { class: `barra-mes${ehAtual ? ' atual' : ''}`, href: `#/notas?situacao=emitida&mes=${m.mes}`, title: descricao, 'aria-label': descricao },
      h('span', { class: 'barra-trilho', 'aria-hidden': 'true' },
        // Um rótulo só (o mês atual): os demais valores estão no toque/ponteiro e na lista do mês.
        ehAtual && Number(m.total) > 0 ? h('span', { class: 'barra-valor' }, compacto(m.total)) : null,
        h('span', { class: 'barra-fill', style: `height:${maior > 0 && Number(m.total) > 0 ? Math.max(4, Math.round((Number(m.total) / maior) * ALTURA_BARRA)) : 0}px` })),
      h('span', { 'aria-hidden': 'true' }, nomeMes(m.mes, { curto: true })));
  };
  return h('section', { 'aria-labelledby': 'h-resumo' },
    h('div', { class: 'secao-titulo' }, h('h3', { id: 'h-resumo' }, 'Notas emitidas'),
      testes ? h('span', { class: 'selo selo-teste' }, 'Notas de teste, sem validade') : null),
    // Valores na casa do milhão não cabem lado a lado no celular: um indicador por linha.
    h('div', { class: `painel${[atual.total, pn.ano.total].some((v) => moeda(v).length > 13) ? ' uma-coluna' : ''}` },
      h('div', { class: 'cartao kpi' },
        h('div', { class: 'kpi-rotulo' }, `Em ${soMes(atual.mes)}`),
        h('div', { class: 'kpi-valor' }, moeda(atual.total)),
        h('div', { class: 'kpi-apoio' }, plural(atual.qtd, 'nota', 'notas')),
        h('div', { class: 'kpi-apoio' }, `Em ${soMes(anterior.mes)}: ${moeda(anterior.total)}`)),
      h('div', { class: 'cartao kpi' },
        h('div', { class: 'kpi-rotulo' }, `Em ${pn.ano.ano}`),
        h('div', { class: 'kpi-valor' }, moeda(pn.ano.total)),
        h('div', { class: 'kpi-apoio' }, plural(pn.ano.qtd, 'nota', 'notas'))),
      h('div', { class: 'cartao largo grafico' },
        h('p', { class: 'barras-titulo' }, 'Emitido por mês, em R$ (últimos 6 meses)'),
        h('div', { class: 'barras', role: 'group', 'aria-label': 'Emitido por mês: toque num mês para ver as notas' }, pn.meses.map(barra))),
      pn.limiteAnual && dados.perfil?.opSimpNac === '2' ? cartaoLimite(pn) : null));
}

export async function tela() {
  let dados;
  let falha = null;
  try {
    dados = await comCache('inicio', () => api('GET', '/api/inicio'));
  } catch (e) {
    if (!(e instanceof ErroApi)) throw e;
    dados = { elegibilidade: null };
    // Só falha passageira (sem internet, servidor fora, limite) merece "Tentar de novo".
    if (e.status === 0 || e.status === 429 || e.status >= 500) falha = e;
  }
  estado.inicio = dados;
  atualizarSelo();
  // Deixa clientes, serviços e perfil guardados no aparelho: sem internet, a nota continua preparável.
  if (navigator.onLine) {
    for (const [k, url] of [['clientes', '/api/clientes'], ['servicos', '/api/servicos'], ['perfil', '/api/perfil?leve=1']]) comCache(k, () => api('GET', url)).catch(() => {});
  }
  const locais = (await rascunhosLocais()).filter((r) => !r.sincronizado && !(!r.noServidor && rascunhoEmBranco(r))).length;

  // O resumo não chegou (sem internet e sem cópia guardada, ou servidor fora): a ação principal continua à mão.
  if (falha && estado.conta?.prestadorId) {
    return {
      titulo: 'Início', aba: 'inicio',
      node: h('div', {},
        h('div', { class: 'acoes-inicio' }, h('a', { class: 'btn btn-primario btn-grande', href: '#/nova' }, icone(ICONES.mais), 'Nova nota')),
        h('div', { class: 'cartao cartao-alerta', role: 'alert' },
          h('p', {}, falha.status === 0
            ? 'Sem internet: o resumo e as últimas notas aparecem quando a conexão voltar. Você pode preparar notas agora; elas ficam como rascunho neste aparelho e ainda não foram emitidas.'
            : 'Não foi possível carregar o resumo agora. Suas notas não foram alteradas.'),
          h('button', { class: 'btn', type: 'button', onclick: () => window.dispatchEvent(new HashChangeEvent('hashchange')) }, 'Tentar de novo')),
        h('button', { class: 'btn btn-texto', type: 'button', onclick: sair }, 'Sair da conta')),
    };
  }

  if (!dados.perfil) {
    return {
      titulo: 'Início', aba: 'inicio',
      node: h('div', {},
        h('h2', {}, 'Bem-vindo ao Nota Sem Stress'),
        h('p', {}, 'Primeiro, cadastre a empresa pelo CNPJ: buscamos os dados na Receita para você.'),
        h('a', { class: 'btn btn-primario btn-grande', href: '#/empresas/nova' }, 'Cadastrar empresa')),
    };
  }

  const p0 = dados.perfil;
  // Uma rejeitada mais recente que a última emitida vira alerta; o botão de clonar diz qual nota ele copia.
  const rejeitadaRecente = dados.ultima && dados.ultima.situacao === 'rejeitada' ? dados.ultima : null;
  const clonavel = dados.ultimaEmitida || (dados.ultima?.situacao === 'emitida' ? dados.ultima : null);
  // Certificado usado na emissão (da empresa ou do escritório, por procuração): avisa com 30 dias de antecedência
  // e também quando já venceu (a cópia guardada do Início pode ser anterior ao vencimento).
  const validade = dados.certificadoValidoAte ? new Date(dados.certificadoValidoAte) - Date.now() : null;
  const diasCertificado = validade === null ? null : Math.floor(validade / 86400_000); // negativo: já venceu
  const doEscritorio = !!dados.certificadoDoEscritorio;
  const qualCertificado = doEscritorio ? 'O certificado do escritório' : 'Seu certificado digital';
  const alertaCertificado = diasCertificado === null || diasCertificado > 30 ? null
    : h('a', { class: 'alerta-linha', href: doEscritorio ? '#/procurador' : '#/perfil' },
      h('span', {}, diasCertificado < 0
        ? `${qualCertificado} venceu em ${data(dados.certificadoValidoAte)}. Envie o novo para voltar a emitir pelo app.`
        : `${qualCertificado} vence ${diasCertificado === 0 ? 'em menos de 24 horas' : `em ${plural(diasCertificado, 'dia', 'dias')}`} (${data(dados.certificadoValidoAte)}). Sem ele, o app não emite: envie o novo antes.`),
      h('b', { class: 'alerta-acao' }, 'Trocar ›'));

  // A Receita recusou a última consulta das notas: por procuração, é o sinal de que ela não está vigente
  // (e as notas desta empresa seriam recusadas). Aparece antes de a pessoa tentar emitir.
  const recusa = dados.receita?.recusadaEm ? dados.receita : null;
  const alertaReceita = recusa ? h('a', { class: 'alerta-linha', href: '#/perfil', role: 'alert' },
    h('span', {}, p0.usaProcuracao
      ? 'A Receita recusou a última consulta por procuração desta empresa. Confira se a procuração eletrônica NFS-e para o escritório está vigente antes de emitir.'
      : 'A Receita recusou a última consulta das notas desta empresa. Confira o certificado antes de emitir.'),
    h('b', { class: 'alerta-acao' }, 'Ver ›')) : null;

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
          h('span', {}, `${plural(dados.pendentes, 'nota aguarda', 'notas aguardam')} confirmação da Receita. Não emita de novo.`), h('b', { class: 'alerta-acao' }, 'Verificar ›'))
        : dados.elegibilidade && !dados.elegibilidade.podeEmitir
          // Uma linha no Início; a lista completa fica em Dados da empresa.
          ? h('a', { class: 'alerta-linha', href: '#/perfil' },
            h('span', {}, `Falta pouco para emitir pelo app: ${plural(dados.elegibilidade.pendencias.length, 'item pendente', 'itens pendentes')}. Enquanto isso, prepare a nota e emita pelo Emissor Nacional.`), h('b', { class: 'alerta-acao' }, 'Ver ›'))
          : alertaReceita || alertaCertificado,
      h('div', { class: 'acoes-inicio' },
        h('a', { class: 'btn btn-primario btn-grande', href: '#/nova' }, icone(ICONES.mais), 'Nova nota'),
        dados.podeClonar
          ? h('a', { class: 'btn btn-grande btn-duas-linhas', href: '#/clonar' }, icone(ICONES.clonar),
            h('span', {}, 'Clonar a última emitida', clonavel ? h('small', {}, `${clonavel.clienteNome || 'Sem cliente'} · ${moeda(clonavel.valor)}`) : null))
          : null),
      rejeitadaRecente ? h('a', { class: 'alerta-linha', href: `#/notas/${rejeitadaRecente.id}` },
        h('span', {}, `A última nota enviada (${rejeitadaRecente.clienteNome || 'sem cliente'}, ${moeda(rejeitadaRecente.valor)}) foi rejeitada.`), h('b', { class: 'alerta-acao' }, 'Corrigir ›')) : null,
      painel(dados),
      h('div', { class: 'inicio-colunas' },
        dados.recentes?.length
          ? h('section', { 'aria-labelledby': 'h-recentes' },
            h('div', { class: 'secao-titulo' }, h('h3', { id: 'h-recentes' }, 'Notas recentes'), h('a', { href: '#/notas' }, 'Ver todas')),
            h('ul', { class: 'lista' }, dados.recentes.map((n) => h('li', {}, linhaNota(n, { compacta: true })))))
          : null,
        h('section', { 'aria-labelledby': 'h-atalhos' },
          h('div', { class: 'secao-titulo' }, h('h3', { id: 'h-atalhos' }, 'Atalhos')),
          h('ul', { class: 'atalhos' },
            rascunhos ? atalho('#/notas?situacao=rascunho', ICONES.rascunho, 'Rascunhos', [dados.rascunhos ? `${plural(dados.rascunhos, 'salvo', 'salvos')} na conta` : null, locais ? `${locais} só neste aparelho` : null].filter(Boolean).join(' · ')) : null,
            atalho('#/servicos', ICONES.servico, 'Serviços salvos', 'Descrições prontas para a nota'),
            atalho('#/perfil', ICONES.ajustes, 'Dados da empresa', 'Regime, certificado e endereço'),
            atalho('#/conta', ICONES.pessoas, 'Minha conta', `Conectado como ${estado.conta?.documentoFormatado || estado.conta?.email || 'você'}`)))),
      // O app fica conectado no aparelho; sair leva de volta à tela de usuário e senha.
      h('button', { class: 'btn btn-texto', type: 'button', onclick: sair }, 'Sair da conta')),
  };
}
