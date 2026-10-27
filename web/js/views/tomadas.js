// Notas tomadas: NFS-e que fornecedores emitiram para a empresa ativa,
// baixadas do Ambiente de Dados Nacional com o certificado da empresa.
import { h, campo, moeda, data, dataHora, chaveFormatada, aviso, icone, ICONES } from '../ui.js';
import { api, ErroApi, cabecalhosIdentidade } from '../api.js';
import { comCache } from '../store.js';
import { ir } from '../app.js';

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
  const contador = h('p', { class: 'suave', role: 'status' });

  const item = (t) => h('li', {}, h('a', { class: 'item', href: `#/tomadas/${t.id}` },
    h('div', { class: 'item-corpo' },
      h('div', { class: 'item-titulo' }, t.emitente?.nome || 'Fornecedor'),
      h('div', { class: 'item-sub' }, [t.nNfse ? `NFS-e nº ${t.nNfse}` : null, data(t.competencia), t.emitente?.documentoFormatado, t.issRetido ? 'ISS retido' : null, t.homologacao ? 'teste' : null].filter(Boolean).join(' · ')),
      h('div', { style: 'margin-top:6px' }, selo(t))),
    h('div', { class: 'item-valor' }, moeda(t.valor))));

  function mostrar(q = '') {
    const s = semAcento(q).trim();
    const dig = s.replace(/[^0-9a-z]/g, '');
    const visiveis = dados.tomadas.filter((t) => !s || semAcento(t.emitente?.nome).includes(s)
      || (dig.length >= 3 && [t.emitente?.documentoFormatado, t.nNfse, t.chaveAcesso].some((x) => semAcento(x).replace(/[^0-9a-z]/g, '').includes(dig))));
    contador.textContent = `${visiveis.length} nota(s)`;
    ul.replaceChildren(...visiveis.map(item));
    if (!visiveis.length) ul.append(h('li', { class: 'suave' }, dados.tomadas.length ? 'Nenhuma nota encontrada.' : 'Nenhuma nota tomada baixada ainda. Toque em "Buscar notas na Receita".'));
  }
  mostrar();

  const buscar = h('button', { class: 'btn btn-primario', type: 'button' }, icone(ICONES.atualizar), 'Buscar notas na Receita');
  buscar.addEventListener('click', async () => {
    buscar.disabled = true;
    try {
      const r = await api('POST', '/api/tomadas/sincronizar', {});
      aviso(r.novas || r.canceladas
        ? `${r.novas} nota(s) nova(s)${r.canceladas ? ` e ${r.canceladas} cancelamento(s)` : ''}.`
        : 'Nenhuma nota nova desde a última busca.');
      window.dispatchEvent(new HashChangeEvent('hashchange')); // recarrega a lista
    } catch (e) {
      aviso(e instanceof ErroApi && e.status === 0 ? 'Sem internet: a busca de notas tomadas precisa de conexão.' : e.message, 7000);
    } finally { buscar.disabled = false; }
  });

  const meses = [['', 'Todas'], [mesAtual(), 'Este mês'], [mesAnterior(), 'Mês passado']];
  const filtroMes = campo({
    rotulo: 'Competência', tipo: 'month', valor: mes,
    onchange: (e) => ir(`/tomadas${e.target.value ? `?mes=${e.target.value}` : ''}`, { substituir: true }),
  });
  const s = dados.sincronizacao || {};
  return {
    titulo: 'Notas tomadas', aba: 'tomadas',
    node: h('div', {},
      h('p', { class: 'suave' }, 'Notas de serviço que fornecedores emitiram para esta empresa, baixadas do Ambiente de Dados Nacional da NFS-e.'),
      dados.temCertificado
        ? h('div', {}, buscar, h('p', { class: 'suave' }, s.sincronizadoEm ? `Última busca: ${dataHora(s.sincronizadoEm)}.` : 'Ainda não buscamos as notas desta empresa.'))
        : h('section', { class: 'cartao cartao-alerta' }, h('strong', {}, 'Envie o certificado A1 desta empresa'),
          h('p', {}, 'A Receita só entrega as notas recebidas para quem apresenta o certificado digital do CNPJ.'),
          h('a', { class: 'btn btn-pequeno', href: '#/perfil' }, 'Enviar certificado')),
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Filtrar por mês' }, meses.map(([v, t]) => h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(v === mes), onclick: () => ir(`/tomadas${v ? `?mes=${v}` : ''}`, { substituir: true }),
      }, t))),
      filtroMes,
      h('section', { class: 'cartao', 'aria-label': 'Totais' },
        h('p', { class: 'suave', style: 'margin:0' }, `${mes ? nomeMes(mes) : 'Todas as competências'} · ${dados.totais.quantidade} nota(s) válida(s)`),
        h('div', { class: 'totais' },
          h('div', {}, h('span', { class: 'suave' }, 'Valor dos serviços'), h('strong', {}, moeda(dados.totais.valor))),
          h('div', {}, h('span', { class: 'suave' }, 'Valor líquido'), h('strong', {}, moeda(dados.totais.valorLiquido))))),
      dados.tomadas.length > 5 ? campo({ rotulo: 'Pesquisar', ajuda: 'Fornecedor, CNPJ, número ou chave', atributos: { type: 'search', autocomplete: 'off' }, oninput: (e) => mostrar(e.target.value) }) : null,
      contador, ul),
  };
}

export async function detalhe({ id }) {
  const { tomada: t } = await api('GET', `/api/tomadas/${id}`);
  const linha = (rotulo, valor, classe) => (valor ? h('div', {}, h('dt', {}, rotulo), h('dd', { class: classe }, valor)) : null);
  const acao = (rotulo, ic, fn) => h('button', { class: 'btn', type: 'button', onclick: async () => { try { await fn(); } catch (e) { aviso(e.message); } } }, icone(ic), rotulo);
  return {
    titulo: t.nNfse ? `NFS-e nº ${t.nNfse}` : 'Nota tomada', aba: 'tomadas', voltar: true,
    node: h('div', {},
      t.situacao === 'cancelada' ? h('p', { class: 'cartao cartao-erro' }, h('strong', {}, 'Nota cancelada pelo fornecedor. '), 'Não use para pagamento ou crédito.') : null,
      h('p', { class: 'valor-grande' }, moeda(t.valor)),
      h('dl', { class: 'dados cartao' },
        linha('Fornecedor (prestador)', t.emitente?.nome),
        linha(t.emitente?.tipo || 'Documento', t.emitente?.documentoFormatado),
        linha('Situação', t.situacao === 'cancelada' ? 'Cancelada' : 'Válida'),
        linha('Competência', data(t.competencia)),
        linha('Emitida em', dataHora(t.emitidaEm)),
        linha('Serviço', [t.cTribNac, t.servico].filter(Boolean).join(' — ')),
        linha('Descrição', t.descricao),
        linha('Local da prestação', t.localPrestacao ? [t.localPrestacao.nome, t.localPrestacao.uf].filter(Boolean).join(' - ') : null),
        linha('Valor líquido', moeda(t.valorLiquido)),
        linha('ISS', t.issRetido ? `Retido pelo tomador${t.vIss ? ` (${moeda(t.vIss)})` : ''}` : t.vIss ? moeda(t.vIss) : null),
        linha('Chave de acesso', chaveFormatada(t.chaveAcesso), 'chave'),
        linha('Baixada em', dataHora(t.baixadaEm))),
      acao('Ver DANFSe (PDF)', ICONES.documento, async () => {
        const aba = window.open('', '_blank');
        try {
          const url = URL.createObjectURL(await baixar(t, 'danfse', { abrir: true }));
          if (aba) aba.location.href = url; else location.href = url;
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        } catch (e) { aba?.close(); throw e; }
      }),
      acao('Baixar XML da NFS-e', ICONES.baixar, () => baixar(t, 'xml')),
      navigator.share ? acao('Compartilhar', ICONES.compartilhar, async () => {
        const arquivos = [await baixar(t, 'danfse', { abrir: true }), await baixar(t, 'xml', { abrir: true })];
        const texto = `NFS-e nº ${t.nNfse || ''} de ${t.emitente?.nome || ''} — ${moeda(t.valor)}\nChave de acesso: ${t.chaveAcesso}`;
        if (navigator.canShare?.({ files: arquivos })) await navigator.share({ title: 'NFS-e tomada', text: texto, files: arquivos });
        else await navigator.share({ title: 'NFS-e tomada', text: texto });
      }) : null),
  };
}
