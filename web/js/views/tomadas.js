// Notas tomadas: NFS-e que fornecedores emitiram para a empresa ativa,
// baixadas do Ambiente de Dados Nacional com o certificado da empresa.
import { h, campo, moeda, data, dataHora, chaveFormatada, aviso, icone, ICONES, plural, codigoServico, vazio, baixarCsv, valorCsv } from '../ui.js';
import { api, ErroApi, cabecalhosIdentidade } from '../api.js';
import { comCache } from '../store.js';
import { ir } from '../app.js';
import { partesDaLinha, resumoDaBusca } from './historico.js';

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const mesAtual = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);
const mesAnterior = () => { const d = new Date(Date.now() - 3 * 3600_000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const nomeMes = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
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

export async function lista(_, query) {
  const mes = /^\d{4}-\d{2}$/.test(query.mes || '') ? query.mes : '';
  const dados = await comCache(`tomadas:${mes}`, () => api('GET', `/api/tomadas${mes ? `?competencia=${mes}` : ''}`));
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
    baixarCsv(`notas-tomadas-${mes || 'todas'}.csv`, ['Competência', 'Número da NFS-e', 'Fornecedor', 'CNPJ/CPF', 'Situação', 'ISS retido', 'Valor (R$)', 'Valor líquido (R$)', 'Chave de acesso'],
      visiveisAgora.map((t) => [data(t.competencia), t.nNfse || '', t.emitente?.nome || '', t.emitente?.documentoFormatado || '', t.situacao === 'cancelada' ? 'Cancelada' : 'Válida',
        t.issRetido ? 'Sim' : 'Não', valorCsv(t.valor), valorCsv(t.valorLiquido), t.chaveAcesso || '']));
    aviso(`${plural(visiveisAgora.length, 'nota exportada', 'notas exportadas')}.`);
  } }, icone(ICONES.baixar), 'Exportar CSV');
  function mostrar(q = '') {
    const s = semAcento(q).trim();
    const dig = s.replace(/[^0-9a-z]/g, '');
    const visiveis = dados.tomadas.filter((t) => !s || semAcento(t.emitente?.nome).includes(s)
      || (dig.length >= 3 && [t.emitente?.documentoFormatado, t.nNfse, t.chaveAcesso].some((x) => semAcento(x).replace(/[^0-9a-z]/g, '').includes(dig))));
    visiveisAgora = visiveis;
    exportar.hidden = !visiveis.length;
    contador.textContent = plural(visiveis.length, 'nota', 'notas');
    ul.replaceChildren(...visiveis.map(item));
    cabecalho.hidden = !visiveis.length;
    semItens.replaceChildren(...(visiveis.length ? [] : [dados.tomadas.length
      ? vazio({ icone: ICONES.busca, titulo: 'Nenhuma nota encontrada', texto: 'Confira o fornecedor, o CNPJ, o número ou a chave digitados.' })
      : vazio({ icone: ICONES.recebida, titulo: mes ? 'Nenhuma nota recebida nesta competência' : 'As notas recebidas aparecem aqui',
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

  // Seletor de mês em português (o <input type=month> aparece vazio ou em inglês em vários navegadores).
  const ultimos = [];
  for (let i = 0, [a, m] = mesAtual().split('-').map(Number); i < 24; i++) {
    ultimos.push(`${a}-${String(m).padStart(2, '0')}`);
    m -= 1; if (m === 0) { m = 12; a -= 1; }
  }
  if (mes && !ultimos.includes(mes)) ultimos.push(mes);
  const rotuloMes = (m) => (m === mesAtual() ? `Este mês (${nomeMes(m)})` : m === mesAnterior() ? `Mês passado (${nomeMes(m)})` : nomeMes(m));
  const filtroMes = campo({
    rotulo: 'Competência', rotuloOculto: true, valor: mes, opcoes: [['', 'Todas as competências'], ...ultimos.map((m) => [m, rotuloMes(m)])],
    onchange: (e) => ir(`/tomadas${e.target.value ? `?mes=${e.target.value}` : ''}`, { substituir: true }),
  });
  filtroMes.classList.add('campo-mes');
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
          h('p', { class: 'suave' }, s.sincronizadoEm ? `Última busca: ${dataHora(s.sincronizadoEm)}${dados.porProcuracao ? ', por procuração' : ''}.`
          : `Ainda não buscamos as notas desta empresa${dados.porProcuracao ? ' (a busca usa o certificado do escritório, por procuração)' : ''}.`))
        : dados.porProcuracao
          // Empresa por procuração: quem falta é o certificado do escritório, não o da empresa.
          ? h('section', { class: 'cartao cartao-alerta' }, h('strong', {}, 'Envie o certificado do escritório'),
            h('p', {}, 'Esta empresa usa a procuração eletrônica: as notas tomadas são buscadas com o certificado do escritório (procurador).'),
            h('a', { class: 'btn btn-pequeno', href: '#/procurador' }, 'Certificado do escritório'))
          : h('section', { class: 'cartao cartao-alerta' }, h('strong', {}, 'Envie o certificado A1 desta empresa'),
            h('p', {}, 'A Receita só entrega as notas recebidas para quem apresenta o certificado digital do CNPJ (ou do escritório, por procuração).'),
            h('a', { class: 'btn btn-pequeno', href: '#/perfil' }, 'Enviar certificado')),
      // Sem certificado e sem notas: só o cartão de como começar (sem filtro nem totais zerados).
      ...(dados.tomadas.length || dados.temCertificado || mes ? [
        h('div', { class: 'barra-lista' }, busca, filtroMes, exportar),
        h('section', { 'aria-label': 'Totais' },
          h('div', { class: 'secao-titulo' }, h('h3', { class: 'titulo-mes' }, mes ? nomeMes(mes) : 'Todas as competências'),
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
