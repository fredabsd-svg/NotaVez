// Notas tomadas: NFS-e que fornecedores emitiram para a empresa ativa,
// baixadas do Ambiente de Dados Nacional com o certificado da empresa.
import { h, campo, moeda, data, dataHora, chaveFormatada, aviso, icone, ICONES, plural, codigoServico, vazio, baixarCsv, valorCsv } from '../ui.js';
import { api, ErroApi, cabecalhosIdentidade } from '../api.js';
import { comCache } from '../store.js';
import { ir, estado } from '../app.js';
import { partesDaLinha, resumoDaBusca } from './historico.js';
import { periodoDaRota, paramsDaRota, paramsDaApi, temPeriodo, rotuloPeriodo, periodoNoArquivo, filtroPeriodo } from '../periodo.js';
import { baixarEmLote } from '../lote.js';

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const mesAtual = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
const selo = (t) => h('span', { class: `situacao s-${t.situacao}` }, t.situacao === 'cancelada' ? 'Cancelada' : 'Válida');

async function baixar(t, tipo, { abrir = false } = {}) {
  const r = await fetch(`/api/tomadas/${t.id}/${tipo}`, { credentials: 'same-origin', headers: cabecalhosIdentidade() });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.erro || 'Não foi possível obter o arquivo agora.');
  const nome = tipo === 'xml' ? `NFSe-${t.chaveAcesso}.xml` : `DANFSe-${t.chaveAcesso}.pdf`;
  const arquivo = new File([await r.blob()], nome, { type: tipo === 'xml' ? 'application/xml' : 'application/pdf' });
  if (abrir) return arquivo;
  const url = URL.createObjectURL(arquivo);
  const a = h('a', { href: url, download: nome });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return arquivo;
}

const CSV_TOMADAS = ['Competência', 'Número da NFS-e', 'Fornecedor', 'CNPJ/CPF', 'Situação', 'ISS retido', 'Valor (R$)', 'Valor líquido (R$)', 'Chave de acesso'];
const linhasCsv = (lista) => lista.map((t) => [data(t.competencia), t.nNfse || '', t.emitente?.nome || '', t.emitente?.documentoFormatado || '', t.situacao === 'cancelada' ? 'Cancelada' : 'Válida',
  t.issRetido ? 'Sim' : 'Não', valorCsv(t.valor), valorCsv(t.valorLiquido), t.chaveAcesso || '']);

export async function lista(_, query) {
  // Competência: um mês, um atalho (últimos 3 meses, este ano...) ou datas de/até.
  const periodo = periodoDaRota(query);
  const comPeriodo = temPeriodo(periodo);
  const qs = new URLSearchParams(paramsDaApi(periodo)).toString();
  const dados = await comCache(`tomadas:${qs}`, () => api('GET', `/api/tomadas${qs ? `?${qs}` : ''}`));
  const ul = h('ul', { class: 'lista', 'aria-live': 'polite' });
  const semItens = h('div', {});
  const contador = h('p', { class: 'suave', role: 'status' });
  const cabecalho = h('div', { class: 'cab-notas com-doc', 'aria-hidden': 'true' },
    h('span', {}, 'Fornecedor'), h('span', { class: 'ln-doc' }, 'CNPJ/CPF'), h('span', { class: 'ln-num' }, 'Número'), h('span', {}, 'Competência'), h('span', {}, 'Situação'), h('span', {}, 'Valor'));

  // Mesma linha das notas emitidas: fornecedor e valor em destaque; número, competência e situação como apoio.
  const item = (t) => h('li', {}, h('a', { class: `linha-nota com-doc${t.situacao === 'cancelada' ? ' cancelada' : ''}`, href: `#/tomadas/${t.id}` },
    partesDaLinha({ cliente: t.emitente?.nome || 'Fornecedor', documento: t.emitente?.documentoFormatado || '', numero: t.nNfse ? `NFS-e nº ${t.nNfse}` : '', competencia: data(t.competencia),
      situacao: h('span', { class: 'marcadores' }, selo(t), t.issRetido ? h('span', { class: 'marcador marcador-alerta' }, 'ISS retido') : null, t.homologacao ? h('span', { class: 'marcador' }, 'Testes') : null),
      valor: moeda(t.valor) })));

  let visiveisAgora = [];
  // A lista mostrada, em planilha, para o contador conferir retenções e serviços tomados.
  const exportar = h('button', { class: 'btn btn-pequeno', type: 'button', title: 'Baixa a lista mostrada em planilha (CSV)', onclick: () => {
    baixarCsv(`notas-tomadas-${periodoNoArquivo(periodo)}.csv`, CSV_TOMADAS, linhasCsv(visiveisAgora));
    aviso(`${plural(visiveisAgora.length, 'nota exportada', 'notas exportadas')}.`);
  } }, icone(ICONES.baixar), 'Exportar CSV');
  // XML e PDF (DANFSe) de todas as notas mostradas, num ZIP.
  const lote = baixarEmLote({
    notas: () => visiveisAgora.filter((t) => t.chaveAcesso),
    url: (t, tipo) => `/api/tomadas/${encodeURIComponent(t.id)}/${tipo === 'xml' ? 'xml' : 'danfse?baixar=1'}`,
    nomePadrao: (t, tipo) => (tipo === 'xml' ? `NFSe-${t.chaveAcesso}.xml` : `DANFSe-${t.chaveAcesso}.pdf`),
    rotulo: (t) => `NFS-e nº ${t.nNfse || '?'} — ${t.emitente?.nome || 'fornecedor'} — chave ${t.chaveAcesso}`,
    nomeZip: () => `notas-tomadas_${String(estado.conta?.empresaDocumentoFormatado || '').replace(/\D/g, '') || 'empresa'}_${periodoNoArquivo(periodo)}.zip`,
    planilha: () => ({ cabecalho: CSV_TOMADAS, linhas: linhasCsv(visiveisAgora.filter((t) => t.chaveAcesso)) }),
    observacao: dados.limitado ? 'A lista traz só as 2.000 mais recentes: escolha um período menor para baixar tudo.' : '',
  });
  function mostrar(q = '') {
    const s = semAcento(q).trim();
    const dig = s.replace(/[^0-9a-z]/g, '');
    const visiveis = dados.tomadas.filter((t) => !s || semAcento(t.emitente?.nome).includes(s)
      || (dig.length >= 3 && [t.emitente?.documentoFormatado, t.nNfse, t.chaveAcesso].some((x) => semAcento(x).replace(/[^0-9a-z]/g, '').includes(dig))));
    visiveisAgora = visiveis;
    exportar.hidden = !visiveis.length;
    lote.atualizar();
    contador.textContent = plural(visiveis.length, 'nota', 'notas');
    ul.replaceChildren(...visiveis.map(item));
    cabecalho.hidden = !visiveis.length;
    semItens.replaceChildren(...(visiveis.length ? [] : [dados.tomadas.length
      ? vazio({ icone: ICONES.busca, titulo: 'Nenhuma nota encontrada', texto: 'Confira o fornecedor, o CNPJ, o número ou a chave digitados.' })
      : vazio({ icone: ICONES.recebida, titulo: comPeriodo ? 'Nenhuma nota recebida neste período' : 'As notas recebidas aparecem aqui',
        texto: dados.temCertificado ? 'Toque em "Buscar notas na Receita" para trazer as notas que fornecedores emitiram para esta empresa.'
          : 'Envie o certificado (acima) para buscar na Receita as notas que fornecedores emitiram para esta empresa.' })]));
  }
  mostrar();

  const buscar = h('button', { class: 'btn btn-primario', type: 'button' }, icone(ICONES.atualizar), 'Buscar notas na Receita');
  buscar.addEventListener('click', async () => {
    buscar.disabled = true;
    try {
      const r = await api('POST', '/api/tomadas/sincronizar', {});
      // A mesma busca traz as notas tomadas e as que a empresa emitiu fora do app.
      aviso(resumoDaBusca(r), 6000);
      window.dispatchEvent(new HashChangeEvent('hashchange')); // recarrega a lista
    } catch (e) {
      aviso(e instanceof ErroApi && e.status === 0 ? 'Sem internet: a busca de notas tomadas precisa de conexão.' : e.message, 7000);
    } finally { buscar.disabled = false; }
  });

  // Meses em português (o <input type=month> aparece vazio ou em inglês em vários navegadores) + atalhos e datas de/até.
  const ultimos = [];
  for (let i = 0, [a, m] = mesAtual().split('-').map(Number); i < 24; i++) {
    ultimos.push(`${a}-${String(m).padStart(2, '0')}`);
    m -= 1; if (m === 0) { m = 12; a -= 1; }
  }
  const { seletor: filtroMes, datas: datasPeriodo } = filtroPeriodo({ meses: ultimos, periodo,
    aoMudar: (p) => { const q = new URLSearchParams(paramsDaRota(p)).toString(); ir(`/tomadas${q ? `?${q}` : ''}`, { substituir: true }); } });
  const busca = dados.tomadas.length > 5 ? campo({ rotulo: 'Pesquisar notas tomadas', rotuloOculto: true,
    atributos: { type: 'search', autocomplete: 'off', placeholder: 'Buscar fornecedor, CNPJ, número ou chave' }, oninput: (e) => mostrar(e.target.value) }) : null;
  busca?.classList.add('busca-icone');
  const s = dados.sincronizacao || {};
  return {
    titulo: 'Notas tomadas', aba: 'tomadas',
    node: h('div', {},
      h('p', { class: 'suave' }, 'Notas de serviço que fornecedores emitiram para esta empresa, baixadas do Ambiente de Dados Nacional da NFS-e.'),
      dados.temCertificado
        ? h('div', {}, buscar, s.recusadaEm ? h('p', { class: 'erro-campo', role: 'alert' }, `A Receita recusou a busca de ${dataHora(s.recusadaEm)}${s.recusaMotivo ? `: ${s.recusaMotivo}` : '.'}${dados.porProcuracao ? ' Confira a procuração desta empresa.' : ''}`) : null,
          h('p', { class: 'suave' }, s.sincronizadoEm ? `Última busca: ${dataHora(s.sincronizadoEm)}${dados.porProcuracao ? ', por procuração' : ''}. O app busca sozinho de hora em hora.`
          : `Ainda não buscamos as notas desta empresa${dados.porProcuracao ? ' (a busca usa o certificado do escritório, por procuração)' : ''}. A busca automática acontece de hora em hora, ou toque no botão acima.`))
        : dados.porProcuracao
          // Empresa por procuração: quem falta é o certificado do escritório, não o da empresa.
          ? h('section', { class: 'cartao cartao-alerta' }, h('strong', {}, 'Envie o certificado do escritório'),
            h('p', {}, 'Esta empresa usa a procuração eletrônica: as notas tomadas são buscadas com o certificado do escritório (procurador).'),
            h('a', { class: 'btn btn-pequeno', href: '#/procurador' }, 'Certificado do escritório'))
          : h('section', { class: 'cartao cartao-alerta' }, h('strong', {}, 'Envie o certificado A1 desta empresa'),
            h('p', {}, 'A Receita só entrega as notas recebidas para quem apresenta o certificado digital do CNPJ (ou do escritório, por procuração).'),
            h('a', { class: 'btn btn-pequeno', href: '#/perfil' }, 'Enviar certificado')),
      // Sem certificado e sem notas: só o cartão de como começar (sem filtro nem totais zerados).
      ...(dados.tomadas.length || dados.temCertificado || comPeriodo ? [
        h('div', { class: 'barra-lista' }, busca, filtroMes, h('div', { class: 'barra-acoes' }, exportar, lote.botao)),
        datasPeriodo,
        lote.painel,
        dados.limitado ? h('p', { class: 'cartao cartao-alerta' }, 'Mostrando as 2.000 notas mais recentes. Escolha um período menor para ver as demais.') : null,
        h('section', { 'aria-label': 'Totais' },
          h('div', { class: 'secao-titulo' }, h('h3', { class: 'titulo-mes' }, rotuloPeriodo(periodo)),
            h('span', { class: 'secao-extra' }, plural(dados.totais.quantidade, 'nota válida', 'notas válidas'))),
          h('div', { class: `painel${moeda(dados.totais.valor).length > 13 ? ' uma-coluna' : ''}` },
            h('div', { class: 'cartao kpi' }, h('div', { class: 'kpi-rotulo' }, 'Valor dos serviços'), h('div', { class: 'kpi-valor' }, moeda(dados.totais.valor))),
            h('div', { class: 'cartao kpi' }, h('div', { class: 'kpi-rotulo' }, 'Valor líquido'), h('div', { class: 'kpi-valor' }, moeda(dados.totais.valorLiquido))))),
        dados.tomadas.length ? contador : null] : []),
      cabecalho, ul, semItens),
  };
}

export async function detalhe({ id }) {
  const { tomada: t } = await api('GET', `/api/tomadas/${id}`);
  const linha = (rotulo, valor, classe) => (valor ? h('div', {}, h('dt', {}, rotulo), h('dd', { class: classe }, valor)) : null);
  const acao = (rotulo, ic, fn) => h('button', { class: 'btn', type: 'button', onclick: async () => { try { await fn(); } catch (e) { aviso(e.message); } } }, icone(ic), rotulo);
  return {
    titulo: t.nNfse ? `Nota recebida nº ${t.nNfse}` : 'Nota recebida', aba: 'tomadas', voltar: true,
    node: h('div', {},
      t.situacao === 'cancelada' ? h('p', { class: 'cartao cartao-erro' }, h('strong', {}, 'Nota cancelada pelo fornecedor. '), 'Não use para pagamento ou crédito.') : null,
      h('p', { class: 'valor-grande' }, moeda(t.valor)),
      h('dl', { class: 'dados cartao' },
        linha('Fornecedor (prestador)', t.emitente?.nome),
        linha(t.emitente?.tipo || 'Documento', t.emitente?.documentoFormatado),
        linha('Situação', selo(t)),
        linha('Competência', data(t.competencia)),
        linha('Emitida em', dataHora(t.emitidaEm)),
        linha('Serviço', [codigoServico(t.cTribNac), t.servico].filter(Boolean).join(' — ')),
        linha('Descrição', t.descricao),
        linha('Local da prestação', t.localPrestacao ? [t.localPrestacao.nome, t.localPrestacao.uf].filter(Boolean).join(' - ') : null),
        linha('Valor líquido', moeda(t.valorLiquido)),
        linha('ISS', t.issRetido ? `Retido pelo tomador${t.vIss ? ` (${moeda(t.vIss)})` : ''}` : t.vIss ? moeda(t.vIss) : null),
        linha('Chave de acesso', chaveFormatada(t.chaveAcesso), 'chave'),
        linha('Baixada em', dataHora(t.baixadaEm))),
      acao('Ver DANFSe', ICONES.documento, async () => {
        const aba = window.open('', '_blank');
        try {
          const url = URL.createObjectURL(await baixar(t, 'danfse', { abrir: true }));
          if (aba) aba.location.href = url; else location.href = url;
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch (e) { aba?.close(); throw e; }
      }),
      acao('Baixar XML', ICONES.baixar, () => baixar(t, 'xml')),
      navigator.share ? acao('Compartilhar', ICONES.compartilhar, async () => {
        const arquivos = [await baixar(t, 'danfse', { abrir: true }), await baixar(t, 'xml', { abrir: true })];
        const texto = `NFS-e nº ${t.nNfse || ''} de ${t.emitente?.nome || ''} — ${moeda(t.valor)}\nChave de acesso: ${t.chaveAcesso}`;
        if (navigator.canShare?.({ files: arquivos })) await navigator.share({ title: 'NFS-e tomada', text: texto, files: arquivos });
        else await navigator.share({ title: 'NFS-e tomada', text: texto });
      }) : null),
  };
}
