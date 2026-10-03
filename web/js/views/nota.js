import { h, anexar, campo, aviso, hoje, moeda, data as dataBr, buscaComSugestoes, icone, ICONES } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { salvarLocal, removerLocal, resolverConflito, contextoConta, conferirContexto, comCache, kvLer, buscarServicoNacional, buscarMunicipio, municipioPorCodigo, servicoNacionalPorCodigo } from '../store.js';
import { carregar, salvar, salvarAgora, rascunhoVazio } from '../rascunho.js';
import { usarNaNota } from './servicos.js';
import { ir, estado } from '../app.js';

export async function nova() {
  const id = crypto.randomUUID();
  await salvarLocal(id, rascunhoVazio(), { meta: {} });
  try { await salvarAgora(id); } catch { /* segue no aparelho */ }
  ir(`/nota/${id}`, { substituir: true });
  return null;
}

export async function clonarUltima() {
  try {
    const { nota } = await api('POST', '/api/notas/clonar-ultima', {});
    await salvarLocal(nota.id, nota.rascunho, {
      noServidor: true, versao: nota.versao, sincronizado: true,
      meta: { cliente: nota.tomadorExibicao && { nome: nota.tomadorExibicao.nome, documentoExibicao: nota.tomadorExibicao.documentoExibicao, tipo: nota.tomadorExibicao.tipo }, servicoNacional: nota.servicoNacional, clonadaDe: nota.origemId },
    });
    aviso('Nova nota criada a partir da última. Confira os campos destacados.');
    ir(`/nota/${nota.id}`, { substituir: true });
    return null;
  } catch (e) {
    if (e instanceof ErroApi && e.status === 0) {
      return { titulo: 'Clonar', voltar: true, node: h('div', { class: 'cartao cartao-alerta' }, h('p', {}, 'Para clonar, conecte-se à internet: precisamos confirmar qual foi a sua última nota emitida.'), h('a', { class: 'btn', href: '#/nova' }, 'Começar uma nota em branco')) };
    }
    throw e;
  }
}

const REVISAO = { competencia: 'a data da competência', valor: 'o valor', descricao: 'a descrição', tributacao: 'a tributação' };

export async function tela({ id }) {
  const ctx = contextoConta();
  const dados = await carregar(id);
  if (!['rascunho', 'rejeitada'].includes(dados.situacao)) { ir(`/notas/${id}`, { substituir: true }); return null; }
  const r = { ...rascunhoVazio(), ...dados.rascunho };
  const meta = { ...dados.meta };
  const perfil = estado.inicio?.perfil || (await kvLer('inicio'))?.perfil;
  if (!meta.servicoNacional && r.cTribNac) meta.servicoNacional = await servicoNacionalPorCodigo(r.cTribNac);
  let servicos = [];
  try { servicos = (await comCache('servicos', () => api('GET', '/api/servicos'))).servicos; } catch { /* sem cache */ }

  const status = h('p', { class: 'salvo', role: 'status', 'aria-live': 'polite' }, dados.local ? 'Salvo neste aparelho' : 'Salvo');
  const persistir = () => {
    conferirContexto(ctx);
    status.textContent = 'Salvando…';
    salvar(id, r, meta, (onde, _n, erro) => {
      if (onde === 'conta') status.textContent = 'Salvo na sua conta';
      else if (onde === 'aparelho') status.textContent = 'Salvo neste aparelho (sem internet) — ainda não emitida';
      else if (erro?.status === 409) { status.textContent = 'Conflito: sua cópia foi preservada. Abra novamente este rascunho para escolher qual versão manter.'; } else status.textContent = 'Salvo neste aparelho';
    }, ctx).catch((e) => { status.textContent = e.message || 'Não foi possível salvar. Sua conta mudou.'; });
  };
  const revisado = (campoNome) => {
    if (!r.revisar.includes(campoNome)) return;
    r.revisar = r.revisar.filter((x) => x !== campoNome);
    marcadores[campoNome]?.remove();
    persistir();
  };
  const marcadores = {};
  const marcador = (campoNome) => {
    if (!r.revisar.includes(campoNome)) return null;
    const cx = h('input', { type: 'checkbox', onchange: (e) => { if (e.target.checked) revisado(campoNome); } });
    marcadores[campoNome] = h('label', { class: 'caixa revisar' }, cx, h('span', {}, h('strong', {}, 'Nota clonada: '), `confira ${REVISAO[campoNome]} e marque aqui.`));
    return marcadores[campoNome];
  };

  // ----- Cliente -----
  const cliente = meta.cliente || (r.tomador && r.tomador.nome ? { nome: r.tomador.nome, documentoExibicao: '', tipo: r.tomador.tipo } : null);
  const blocoCliente = h('section', { 'aria-labelledby': 'h-cliente' },
    h('h3', { id: 'h-cliente' }, '1. Cliente'),
    cliente
      ? h('a', { class: 'item selecionado', href: `#/clientes?para=${id}` },
        h('div', { class: 'item-corpo' }, h('div', { class: 'item-titulo' }, cliente.nome), h('div', { class: 'item-sub' }, `${cliente.tipo || ''} ${cliente.documentoExibicao || ''}`)),
        h('span', { class: 'suave' }, 'Trocar'))
      : h('a', { class: 'btn', href: `#/clientes?para=${id}` }, icone(ICONES.pessoas), 'Escolher cliente'));

  // ----- Serviço -----
  const nacionalTexto = h('p', { class: 'suave', 'aria-live': 'polite' });
  const avisoLocal = h('div');
  const descricao = campo({
    rotulo: 'Descrição do serviço', ajuda: 'Como vai aparecer na nota. Até 1.000 caracteres.', area: true, valor: r.descricao,
    atributos: { maxlength: 1000 },
    oninput: (e) => { r.descricao = e.target.value; revisado('descricao'); persistir(); },
  });
  let atualizarIbs = null; // definido na seção de tributação (Lucro Presumido/Real)
  const mostrarNacional = () => {
    atualizarIbs?.();
    const n = meta.servicoNacional;
    nacionalTexto.replaceChildren(n ? h('span', {}, 'Código nacional: ', h('strong', {}, `${n.codigo} — ${n.descricao}`)) : 'Escolha um serviço salvo ou busque na lista nacional.');
    if (n?.grupoExigido) nacionalTexto.append(h('span', { class: 'erro-campo', style: 'display:block' }, 'Este serviço exige dados de obra/evento, ainda não suportados. Use o Emissor Nacional para ele.'));
    blocoLocal.open = n?.incidencia === 'LP';
    avisoLocal.replaceChildren(n?.incidencia === 'LP'
      ? h('p', { class: 'cartao cartao-alerta' }, 'Para este serviço, o ISS é devido na cidade onde ele foi prestado. Confirme a cidade abaixo.')
      : '');
  };
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Serviços salvos' }, servicos.map((s) => h('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(r.servicoId === s.id),
    onclick: async () => {
      await usarNaNota(id, s, { manterDescricao: false });
      const atual = await carregar(id);
      Object.assign(r, atual.rascunho);
      Object.assign(meta, atual.meta);
      descricao.entrada.value = r.descricao;
      valor.entrada.value = r.valor ? Number(r.valor).toFixed(2).replace('.', ',') : '';
      for (const b of chips.querySelectorAll('.chip')) b.setAttribute('aria-pressed', String(b === chips.querySelector(`[data-id="${s.id}"]`)));
      mostrarNacional();
    },
    dataset: { id: s.id },
  }, s.apelido)));
  const buscaNacional = buscaComSugestoes({
    rotulo: 'Ou busque na lista nacional', placeholder: 'Ex.: manutenção, design, aula',
    buscar: buscarServicoNacional, formatar: (x) => `${x.codigo} — ${x.descricao}`,
    aoEscolher: (x, c) => {
      c.entrada.value = '';
      if (r.cTribNac !== x.codigo) { r.cNBS = null; r.cIndOp = null; r.cClassTrib = null; }
      r.cTribNac = x.codigo; r.servicoId = null; meta.servicoNacional = x;
      if (!r.descricao) { r.descricao = x.descricao; descricao.entrada.value = x.descricao; }
      for (const b of chips.querySelectorAll('.chip')) b.setAttribute('aria-pressed', 'false');
      mostrarNacional(); persistir();
    },
  });
  const blocoServico = h('section', { 'aria-labelledby': 'h-servico' },
    h('h3', { id: 'h-servico' }, '2. Serviço'),
    servicos.length ? chips : h('p', { class: 'suave' }, 'Dica: ', h('a', { href: `#/servicos/novo?para=${id}` }, 'salve este serviço'), ' para usar nas próximas notas.'),
    buscaNacional, nacionalTexto, descricao, marcador('descricao'));

  // ----- Quando e quanto -----
  const competencia = campo({
    rotulo: 'Competência', ajuda: 'Data em que o serviço foi prestado (não pode ser futura).', tipo: 'date', valor: r.competencia,
    atributos: { max: hoje() }, oninput: (e) => { r.competencia = e.target.value; revisado('competencia'); persistir(); },
  });
  const valor = campo({
    rotulo: 'Valor do serviço (R$)', valor: r.valor ? Number(r.valor).toFixed(2).replace('.', ',') : '',
    atributos: { inputmode: 'decimal', placeholder: '0,00', autocomplete: 'off' },
    oninput: (e) => {
      const v = e.target.value.replace(/[^\d,.]/g, '');
      const n = /,\d{0,2}$/.test(v) ? v.replace(/\./g, '').replace(',', '.') : v.replace(/,/g, '');
      r.valor = Number.isFinite(Number(n)) && n !== '' ? Number(n).toFixed(2) : '';
      previa.textContent = r.valor ? moeda(r.valor) : '';
      revisado('valor'); persistir();
    },
  });
  const previa = h('p', { class: 'suave', 'aria-live': 'polite' }, r.valor ? moeda(r.valor) : '');
  const blocoQuando = h('section', { 'aria-labelledby': 'h-quando' }, h('h3', { id: 'h-quando' }, '3. Quando e quanto'),
    competencia, marcador('competencia'), valor, previa, marcador('valor'));

  // ----- Tributação (depende do regime do perfil) -----
  const blocoTrib = h('section', { 'aria-labelledby': 'h-trib' }, h('h3', { id: 'h-trib' }, '4. Tributação'));
  const pctTexto = (v) => (v ? Number(v).toFixed(2).replace('.', ',') : '');
  const lerPct = (v) => {
    const n = Number(String(v).replace('%', '').replace(',', '.'));
    return String(v).trim() && Number.isFinite(n) ? n.toFixed(2) : null;
  };
  if (perfil?.opSimpNac === '3') {
    const reg = String(perfil.regApTribSN || '1');
    const explicacao = {
      1: 'Simples Nacional: tributos federais e ISS pagos no DAS.',
      2: 'Simples Nacional: tributos federais no DAS; ISS fora do Simples, pela regra do município.',
      3: 'Tributos federais e ISS fora do Simples, pela regra de cada tributo.',
    }[reg];
    const avisoRet = h('p', { class: 'suave', 'aria-live': 'polite' });
    const aliq = campo({
      rotulo: reg === '1' ? 'Alíquota do ISS no Simples (%)' : 'Alíquota do ISS do município (%)',
      ajuda: reg === '1'
        ? `Obrigatória quando o cliente retém o ISS (entre 1,8% e 5%).${perfil.aliqIssSN ? ` Se deixar em branco, usamos a do perfil: ${pctTexto(perfil.aliqIssSN)}%.` : ''}`
        : 'Só vai na nota se o município onde o ISS é devido não for conveniado ao Sistema Nacional. Conferimos na revisão.',
      valor: pctTexto(r.pAliq), atributos: { inputmode: 'decimal', placeholder: reg === '1' ? pctTexto(perfil.aliqIssSN) || '2,00' : 'Ex.: 3,00' },
      oninput: (e) => { r.pAliq = lerPct(e.target.value); revisado('tributacao'); persistir(); },
    });
    const retido = h('input', {
      type: 'checkbox', id: 'iss-retido', checked: !!r.issRetido,
      onchange: (e) => { r.issRetido = e.target.checked; atualizarAliq(); revisado('tributacao'); persistir(); },
    });
    const atualizarAliq = () => {
      aliq.hidden = reg === '1' && !r.issRetido;
      const cpf = (meta.cliente?.tipo || r.tomador?.tipo) === 'CPF';
      avisoRet.textContent = r.issRetido && cpf ? 'Atenção: nesta versão, só clientes com CNPJ podem reter o ISS.' : '';
    };
    const pTot = campo({
      rotulo: 'Percentual aproximado de tributos (%)',
      ajuda: perfil.pTotTribSN ? `Do perfil: ${pctTexto(perfil.pTotTribSN)}%. Mude só se a alíquota do mês for outra.` : 'Sua alíquota efetiva do Simples no mês.',
      valor: pctTexto(r.pTotTribSN), atributos: { inputmode: 'decimal', placeholder: pctTexto(perfil.pTotTribSN) || 'Ex.: 6,00' },
      oninput: (e) => { r.pTotTribSN = lerPct(e.target.value); revisado('tributacao'); persistir(); },
    });
    anexar(blocoTrib,
      h('div', { class: 'cartao' }, h('p', { style: 'margin:0' }, h('strong', {}, 'ME/EPP: '), explicacao)),
      h('label', { class: 'caixa', for: 'iss-retido' }, retido, h('span', {}, h('strong', {}, 'O cliente vai reter o ISS'), h('span', { class: 'ajuda' }, 'Marque se o cliente desconta o ISS e recolhe ao município.'))),
      avisoRet, aliq, pTot, marcador('tributacao'));
    atualizarAliq();
  } else if (perfil?.opSimpNac === '1') {
    // ISS: retenção pelo cliente; alíquota só vale se o município de incidência não for conveniado (E0617/E0619).
    const retidoIss = h('input', { type: 'checkbox', id: 'iss-retido', checked: !!r.issRetido, onchange: (e) => { r.issRetido = e.target.checked; revisado('tributacao'); persistir(); } });
    const aliqIss = campo({
      rotulo: 'Alíquota do ISS do município (%)',
      ajuda: `Só vai na nota se o município onde o ISS é devido não for conveniado ao Sistema Nacional.${perfil.aliqIss ? ` Em branco = ${pctTexto(perfil.aliqIss)}% do perfil.` : ''}`,
      valor: pctTexto(r.pAliq), atributos: { inputmode: 'decimal', placeholder: pctTexto(perfil.aliqIss) || 'Ex.: 5,00' },
      oninput: (e) => { r.pAliq = lerPct(e.target.value); revisado('tributacao'); persistir(); },
    });

    // Retenções federais (NT 007: PIS, COFINS e CSLL retidos vão SOMADOS em um só valor).
    const rf = { pis: false, cofins: false, csll: false, valorContribuicoes: null, irrf: null, cp: null, ...(r.retencoesFederais || {}) };
    const salvarRf = () => { r.retencoesFederais = { ...rf }; revisado('tributacao'); persistir(); };
    const valorTexto = (v) => (v ? Number(v).toFixed(2).replace('.', ',') : '');
    const lerValor = (v) => {
      const t = String(v).trim();
      if (!t) return null;
      const n = Number(/,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, ''));
      return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
    };
    const caixa = (k, rotulo) => h('label', { class: 'caixa', style: 'margin:6px 0' },
      h('input', { type: 'checkbox', checked: !!rf[k], onchange: (e) => { rf[k] = e.target.checked; salvarRf(); } }), h('span', {}, rotulo));
    const vContrib = campo({ rotulo: 'Valor retido de PIS/COFINS/CSLL, somados (R$)', valor: valorTexto(rf.valorContribuicoes), atributos: { inputmode: 'decimal', placeholder: '0,00' },
      oninput: (e) => { rf.valorContribuicoes = lerValor(e.target.value); salvarRf(); } });
    const calc465 = h('button', {
      class: 'btn btn-pequeno btn-texto', type: 'button',
      onclick: () => {
        if (!r.valor) return aviso('Informe o valor do serviço primeiro.');
        const v = (Number(r.valor) * 4.65 / 100).toFixed(2);
        vContrib.entrada.value = v.replace('.', ','); rf.valorContribuicoes = v; rf.pis = rf.cofins = rf.csll = true;
        for (const cx of blocoRet.querySelectorAll('input[type=checkbox]')) cx.checked = true;
        salvarRf();
      },
    }, 'Preencher 4,65% (PIS 0,65% + COFINS 3% + CSLL 1%)');
    const vIrrf = campo({ rotulo: 'IRRF retido (R$)', valor: valorTexto(rf.irrf), atributos: { inputmode: 'decimal', placeholder: '0,00' }, oninput: (e) => { rf.irrf = lerValor(e.target.value); salvarRf(); } });
    const vCp = campo({ rotulo: 'INSS retido (R$)', valor: valorTexto(rf.cp), atributos: { inputmode: 'decimal', placeholder: '0,00' }, oninput: (e) => { rf.cp = lerValor(e.target.value); salvarRf(); } });
    const blocoRet = h('details', { open: !!(rf.pis || rf.cofins || rf.csll || rf.irrf || rf.cp) },
      h('summary', {}, 'Retenções federais (cliente empresa)'),
      h('p', { class: 'suave' }, 'Marque o que o cliente vai reter. As alíquotas dependem do serviço e do cliente: confirme com seu contador.'),
      caixa('pis', 'PIS retido'), caixa('cofins', 'COFINS retida'), caixa('csll', 'CSLL retida'), vContrib, calc465, vIrrf, vCp);

    // IBS/CBS (opções oficiais do Anexo VIII para o serviço escolhido).
    const blocoIbs = h('div', { class: 'cartao' });
    atualizarIbs = async () => {
      const cod = r.cTribNac;
      if (!cod) { blocoIbs.replaceChildren(h('p', { class: 'suave', style: 'margin:0' }, 'Escolha o serviço para ver as opções de IBS/CBS.')); return; }
      let info;
      try { info = await comCache(`ibscbs:${cod}`, () => api('GET', `/api/tabelas/ibscbs/${cod}`)); } catch { info = null; }
      if (!info) { blocoIbs.replaceChildren(h('p', { class: 'suave', style: 'margin:0' }, 'Sem internet: as opções de IBS/CBS aparecem quando a conexão voltar.')); return; }
      const cab = h('p', { style: 'margin-top:0' }, h('strong', {}, 'IBS/CBS: '), `obrigatório na nota a partir de ${dataBr(info.obrigatorioDesde)} (Ato Conjunto RFB/CGIBS nº 4/2026). A Receita calcula os valores; você informa a classificação.`);
      if (!info.opcoes.length) { blocoIbs.replaceChildren(cab, h('p', { class: 'erro-campo' }, 'Este serviço não tem correlação oficial de IBS/CBS (Anexo VIII). Use o Emissor Nacional ou outro código.')); return; }
      const nbsAtual = r.cNBS || (info.opcoes.length === 1 ? info.opcoes[0].nbs : '');
      const entrada = info.opcoes.find((o) => o.nbs === nbsAtual);
      const selNbs = campo({
        rotulo: 'Código NBS do serviço', valor: nbsAtual,
        opcoes: [['', 'Escolha…'], ...info.opcoes.map((o) => [o.nbs, `${o.nbs.replace(/^(\d)(\d{4})(\d{2})(\d{2})$/, '$1.$2.$3.$4')} — ${o.descricao}`])],
        onchange: (e) => { r.cNBS = e.target.value || null; r.cIndOp = null; r.cClassTrib = null; revisado('tributacao'); persistir(); atualizarIbs(); },
      });
      const partes = [cab, selNbs];
      if (entrada && entrada.cIndOp.length > 1) {
        partes.push(campo({
          rotulo: 'Como o serviço é prestado', valor: r.cIndOp || '', ajuda: 'Define onde o IBS/CBS é devido (Anexo VII).',
          opcoes: [['', 'Escolha…'], ...entrada.cIndOp.map((c) => [c.codigo, `${c.caracteristica || c.tipo || c.codigo}`])],
          onchange: (e) => { r.cIndOp = e.target.value || null; revisado('tributacao'); persistir(); },
        }));
      }
      if (entrada && entrada.cClassTrib.length > 1) {
        partes.push(campo({
          rotulo: 'Classificação tributária do IBS/CBS', valor: r.cClassTrib || (entrada.cClassTrib.some((c) => c.codigo === '000001') ? '000001' : ''),
          opcoes: [['', 'Escolha…'], ...entrada.cClassTrib.map((c) => [c.codigo, `${c.codigo} — ${c.nome}`])],
          onchange: (e) => { r.cClassTrib = e.target.value || null; revisado('tributacao'); persistir(); },
        }));
      } else if (entrada) {
        partes.push(h('p', { class: 'suave' }, `Classificação: ${entrada.cClassTrib[0].codigo} — ${entrada.cClassTrib[0].nome}`));
      }
      const tipoCliente = meta.cliente?.tipo || r.tomador?.tipo;
      const indFinal = r.indFinal ?? (tipoCliente === 'CPF' ? '1' : '0');
      const radio = (v, t) => h('label', { class: 'caixa', style: 'margin:6px 0' },
        h('input', { type: 'radio', name: 'ind-final', value: v, checked: indFinal === v, onchange: () => { r.indFinal = v; revisado('tributacao'); persistir(); } }), h('span', {}, t));
      partes.push(h('fieldset', { style: 'border:0;padding:0;margin:8px 0' },
        h('legend', { class: 'rotulo', style: 'margin:0' }, 'O serviço é para uso ou consumo pessoal do cliente?'),
        radio('1', 'Sim (em geral, pessoa física)'), radio('0', 'Não (uso na atividade da empresa)')));
      blocoIbs.replaceChildren(...partes);
    };

    anexar(blocoTrib,
      h('div', { class: 'cartao' }, h('p', { style: 'margin:0' }, h('strong', {}, `Lucro ${perfil.apuracao === 'real' ? 'Real' : 'Presumido'}: `), 'ISS, PIS/COFINS do perfil e IBS/CBS.')),
      h('label', { class: 'caixa', for: 'iss-retido' }, retidoIss, h('span', {}, h('strong', {}, 'O cliente vai reter o ISS'), h('span', { class: 'ajuda' }, 'Só para cliente com CNPJ.'))),
      aliqIss, blocoRet, blocoIbs, marcador('tributacao'));
    atualizarIbs();
  } else {
    anexar(blocoTrib, h('div', { class: 'cartao' },
      h('p', { style: 'margin-top:0' }, h('strong', {}, 'MEI: '), 'o ISS e os impostos federais já são pagos no DAS mensal.'),
      h('p', { class: 'suave' }, 'A nota sai como operação tributável, sem alíquota e sem retenção de ISS, como exige a Receita para MEI.')),
    marcador('tributacao'));
  }

  // ----- Local e opções (só quando necessário) -----
  const localAtual = r.localPrestacaoIbge ? await municipioPorCodigo(r.localPrestacaoIbge) : null;
  const localPerfil = perfil?.municipio;
  const local = buscaComSugestoes({
    rotulo: 'Cidade onde o serviço foi prestado',
    ajuda: `Se nada for escolhido, usamos ${localPerfil ? `${localPerfil.nome} - ${localPerfil.uf}` : 'a cidade do seu perfil'}.`,
    placeholder: 'Digite a cidade', valorInicial: localAtual ? `${localAtual.nome} - ${localAtual.uf}` : '',
    buscar: buscarMunicipio, formatar: (m) => `${m.nome} - ${m.uf}`,
    aoEscolher: (m, c) => { r.localPrestacaoIbge = m.ibge; c.entrada.value = `${m.nome} - ${m.uf}`; persistir(); },
  });
  local.entrada.addEventListener('input', (e) => { if (!e.target.value) { r.localPrestacaoIbge = null; persistir(); } });
  const blocoLocal = h('details', {}, h('summary', {}, 'Local da prestação e outras opções'), avisoLocal, local,
    campo({ rotulo: 'Código de tributação municipal', ajuda: 'Só se a prefeitura exigir (3 dígitos).', valor: r.cTribMun || '', atributos: { inputmode: 'numeric', maxlength: 3 }, oninput: (e) => { r.cTribMun = e.target.value.replace(/\D/g, '') || null; persistir(); } }),
    campo({ rotulo: 'Código NBS', ajuda: 'Opcional (9 dígitos).', valor: r.cNBS || '', atributos: { inputmode: 'numeric', maxlength: 9 }, oninput: (e) => { r.cNBS = e.target.value.replace(/\D/g, '') || null; persistir(); } }));
  mostrarNacional();

  const rejeitada = dados.situacao === 'rejeitada' && dados.nota?.erros?.length
    ? h('div', { class: 'cartao cartao-erro', role: 'alert' }, h('strong', {}, 'A Receita recusou o envio anterior. Nenhuma nota foi emitida.'),
      h('ul', {}, dados.nota.erros.map((e) => h('li', {}, e.mensagem, ' ', h('span', { class: 'suave' }, `(${e.codigo})`)))))
    : null;

  return {
    titulo: dados.meta?.clonadaDe || dados.nota?.origemId ? 'Nova nota (clonada)' : 'Nova nota', voltar: true, aba: 'inicio',
    node: h('div', {},
      rejeitada,
      dados.conflito ? h('div', { class: 'cartao cartao-alerta', role: 'alert' },
        h('h2', {}, 'Rascunho alterado em outro aparelho'),
        h('p', {}, 'Sua edição neste aparelho foi preservada. Escolha qual versão manter antes de revisar e emitir.'),
        dados.conflito.rascunho ? h('p', {}, 'Na conta: ', moeda(dados.conflito.rascunho.valor), ' · ', dados.conflito.rascunho.descricao || 'Sem descrição') : null,
        h('a', { class: 'btn btn-texto', href: `#/notas/${id}` }, 'Consultar a situação na conta'),
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          try { conferirContexto(ctx); await resolverConflito(id, true); window.dispatchEvent(new HashChangeEvent('hashchange')); }
          catch (e) { aviso(e.message); }
        } }, 'Manter minha edição deste aparelho'),
        h('button', { class: 'btn btn-texto', type: 'button', onclick: async () => {
          if (!confirm('Substituir a edição deste aparelho pela versão atual da conta?')) return;
          try { conferirContexto(ctx); await resolverConflito(id, false); window.dispatchEvent(new HashChangeEvent('hashchange')); }
          catch (e) { aviso(e.message); }
        } }, 'Usar versão da conta')) : null,
      h('p', { class: 'suave' }, 'Rascunho: tudo é salvo automaticamente. Você pode sair e continuar depois.'),
      blocoCliente, blocoServico, blocoQuando, blocoTrib, blocoLocal,
      h('div', { class: 'rodape-fixo' }, status,
        h('button', {
          class: 'btn btn-primario', type: 'button',
          onclick: async () => {
            try { conferirContexto(ctx); await salvarAgora(id); } catch (e) { if (e.status !== 0) { aviso(e.message); window.dispatchEvent(new HashChangeEvent('hashchange')); return; } }
            ir(`/nota/${id}/revisao`);
          },
        }, 'Revisar nota')),
      h('button', {
        class: 'btn btn-texto btn-perigo', type: 'button',
        onclick: async () => {
          conferirContexto(ctx);
          if (!confirm('Descartar este rascunho?')) return;
          await removerLocal(id);
          try { await api('DELETE', `/api/notas/${id}`); } catch { /* pode não existir no servidor */ }
          aviso('Rascunho descartado.');
          ir('/', { substituir: true });
        },
      }, 'Descartar rascunho')),
  };
}
