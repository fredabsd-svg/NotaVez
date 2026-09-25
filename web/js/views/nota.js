import { h, anexar, campo, aviso, hoje, moeda, buscaComSugestoes, icone, ICONES } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { salvarLocal, removerLocal, comCache, kvLer, buscarServicoNacional, buscarMunicipio, municipioPorCodigo, servicoNacionalPorCodigo } from '../store.js';
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
      noServidor: true, sincronizado: true,
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
    status.textContent = 'Salvando…';
    salvar(id, r, meta, (onde, _n, erro) => {
      if (onde === 'conta') status.textContent = 'Salvo na sua conta';
      else if (onde === 'aparelho') status.textContent = 'Salvo neste aparelho (sem internet) — ainda não emitida';
      else if (erro?.status === 409) { aviso(erro.message); ir(`/notas/${id}`, { substituir: true }); } else status.textContent = 'Salvo neste aparelho';
    });
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
  const mostrarNacional = () => {
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
    anexar(blocoTrib, h('div', { class: 'cartao cartao-alerta' },
      h('p', { style: 'margin:0' }, 'Lucro Presumido ou Real: a emissão direta ainda não está disponível. Você pode preparar este rascunho e emitir pelo Emissor Nacional.')),
    marcador('tributacao'));
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
      h('p', { class: 'suave' }, 'Rascunho: tudo é salvo automaticamente. Você pode sair e continuar depois.'),
      blocoCliente, blocoServico, blocoQuando, blocoTrib, blocoLocal,
      h('div', { class: 'rodape-fixo' }, status,
        h('button', {
          class: 'btn btn-primario', type: 'button',
          onclick: async () => {
            try { await salvarAgora(id); } catch { /* segue */ }
            ir(`/nota/${id}/revisao`);
          },
        }, 'Revisar nota')),
      h('button', {
        class: 'btn btn-texto btn-perigo', type: 'button',
        onclick: async () => {
          if (!confirm('Descartar este rascunho?')) return;
          await removerLocal(id);
          try { await api('DELETE', `/api/notas/${id}`); } catch { /* pode não existir no servidor */ }
          aviso('Rascunho descartado.');
          ir('/', { substituir: true });
        },
      }, 'Descartar rascunho')),
  };
}
