// Cadastro de empresas em lote (escritórios): cole os CNPJs ou envie a planilha; o app consulta cada um
// na base pública do CNPJ, sugere o regime (MEI, Simples, Presumido ou Real), a IA da conta revisa cada
// empresa e só então as escolhidas são salvas.
import { h, campo, aviso, icone, ICONES, plural } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { carregarConta } from '../app.js';

const REGIMES = [['mei', 'MEI'], ['simples', 'Simples Nacional (ME/EPP)'], ['presumido', 'Lucro Presumido'], ['real', 'Lucro Real']];
const ROTULO = Object.fromEntries(REGIMES);
const ACEITOS = '.xlsx,.xlsm,.csv,.tsv,.txt,.pdf,.docx';
const SIMULTANEAS = 3;
const POR_REVISAO = 10;
const LIMITE_ARQUIVO = 3 * 1024 * 1024;
const VEREDITO = { aprovar: ['IA: aprovada', 'marcador-ok'], revisar: ['IA: conferir', 'marcador-alerta'], bloquear: ['IA: não salvar', 'marcador-erro'] };
const SITUACAO = {
  fila: ['Na fila', ''], consultando: ['Consultando…', ''], pronta: ['Dados conferidos', 'marcador-ok'], revisar: ['Conferir', 'marcador-alerta'],
  bloqueada: ['Não pode ser salva', 'marcador-erro'], ja_cadastrada: ['Já cadastrada', ''], erro: ['Erro na consulta', 'marcador-erro'], salva: ['Salva', 'marcador-ok'],
};
// CNAE como a Receita escreve: 6201-5/01.
const cnae = (c) => (/^\d{7}$/.test(String(c || '')) ? String(c).replace(/^(\d{4})(\d)(\d{2})$/, '$1-$2/$3') : (c || ''));
const espera = (ms) => new Promise((r) => { setTimeout(r, ms); });
const paraBase64 = (arquivo) => new Promise((ok, falha) => {
  const leitor = new FileReader();
  leitor.onload = () => ok(String(leitor.result).split(',')[1] || '');
  leitor.onerror = () => falha(new Error('Não foi possível ler o arquivo.'));
  leitor.readAsDataURL(arquivo);
});

export async function tela() {
  const [procurador, ia] = await Promise.all([
    api('GET', '/api/procurador').catch(() => null),
    api('GET', '/api/ia/config').then((r) => r.config).catch(() => ({ configurado: false })),
  ]);

  // ---------------------------------------------------------- passo 1: a lista
  let arquivo = null;
  const cLista = campo({ rotulo: 'CNPJs', area: true, ajuda: 'Um por linha (ou separados por vírgula). Pode colar direto da planilha, com ou sem pontuação. Depois do CNPJ, a linha pode dizer o regime: "MEI", "Simples", "Presumido" ou "Real".',
    atributos: { rows: 6, spellcheck: 'false', autocomplete: 'off', placeholder: '11.222.333/0001-81 Simples\n45.997.418/0001-53\n…' } });
  const chipArquivo = h('ul', { class: 'ia-anexos' });
  const entradaArquivo = h('input', { type: 'file', accept: ACEITOS, hidden: true });
  const escolher = (f) => {
    if (!f) return;
    if (f.size > LIMITE_ARQUIVO) { aviso('O arquivo passa de 3 MB. Divida a planilha ou cole os CNPJs.'); return; }
    if (/\.(xls|doc)$/i.test(f.name)) { aviso('Formato antigo: abra no Excel/Word e salve como .xlsx/.docx.'); return; }
    arquivo = f;
    chipArquivo.replaceChildren(h('li', {}, icone(ICONES.documento), h('span', {}, f.name),
      h('button', { class: 'ia-anexo-remover', type: 'button', 'aria-label': `Remover ${f.name}`, onclick: () => { arquivo = null; chipArquivo.replaceChildren(); } }, '×')));
  };
  entradaArquivo.addEventListener('change', () => { escolher(entradaArquivo.files[0]); entradaArquivo.value = ''; });
  const botaoArquivo = h('button', { class: 'btn btn-pequeno', type: 'button', onclick: () => entradaArquivo.click() }, icone(ICONES.baixar), 'Enviar planilha (Excel ou CSV)');
  const porProcuracao = procurador?.certificado ? h('input', { type: 'checkbox', id: 'lote-procuracao', checked: true }) : null;
  const erroPasso1 = h('p', { class: 'erro-campo', role: 'alert', hidden: true });
  const consultar = h('button', { class: 'btn btn-primario', type: 'submit' }, icone(ICONES.busca), 'Consultar CNPJs');
  const passo1 = h('form', { class: 'cartao lote-entrada', novalidate: true },
    h('h2', { class: 'lote-titulo' }, '1. Informe as empresas'),
    cLista,
    h('div', { class: 'lote-arquivo' }, botaoArquivo, entradaArquivo, chipArquivo),
    h('p', { class: 'suave' }, 'Na planilha, o app procura a coluna CNPJ e, se houver, Regime (MEI, Simples, Presumido ou Real), Inscrição municipal, E-mail e Razão social. Até 300 empresas por vez.'),
    porProcuracao ? h('label', { class: 'caixa', for: 'lote-procuracao' }, porProcuracao,
      h('span', {}, h('strong', {}, 'Usar o certificado do escritório (procuração eletrônica)'),
        h('span', { class: 'ajuda' }, 'As empresas já nascem prontas para emitir e buscar notas. Desmarque se cada uma tiver o próprio certificado A1.'))) : null,
    erroPasso1, consultar);
  // Arrastar a planilha para o cartão também funciona.
  passo1.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); passo1.classList.add('arrastando'); } });
  passo1.addEventListener('dragleave', () => passo1.classList.remove('arrastando'));
  passo1.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); passo1.classList.remove('arrastando'); escolher(e.dataTransfer.files[0]); } });

  // ---------------------------------------------------------- passo 2: conferência e revisão
  let itens = [];
  let semIa = false;
  let avisosPadrao = {};
  const resumo = h('p', { class: 'suave', role: 'status', 'aria-live': 'polite' });
  const barra = h('progress', { max: 1, value: 0, hidden: true });
  const lista = h('ul', { class: 'lista lote-lista' });
  const acoes = h('div', { class: 'lote-acoes-finais' });
  const passo2 = h('section', { hidden: true, 'aria-label': 'Conferência das empresas' }, h('h2', { class: 'lote-titulo' }, '2. Confira e revise'), resumo, barra, lista, acoes);
  const passo3 = h('section', { class: 'cartao', hidden: true, 'aria-live': 'polite' });

  const incluivel = (it) => it.preparada && ['pronta', 'revisar'].includes(it.preparada.situacao) && it.situacao !== 'salva';
  const escolhidas = () => itens.filter((it) => incluivel(it) && it.incluir && it.regime);
  const precisamRevisao = () => escolhidas().filter((it) => !it.revisao);

  function cartao(it) {
    const p = it.preparada;
    const d = p?.dados;
    const [rotSit, clsSit] = SITUACAO[it.situacao] || SITUACAO.fila;
    const marcadores = [h('span', { class: `marcador ${clsSit}` }, rotSit)];
    if (it.revisao) { const [r, c] = VEREDITO[it.revisao.veredito]; marcadores.push(h('span', { class: `marcador ${c}` }, r)); }
    const incluir = h('input', { type: 'checkbox', checked: it.incluir && incluivel(it), disabled: !incluivel(it), 'aria-label': `Incluir ${d?.razaoSocial || p?.cnpjFormatado || it.entrada.cnpjFormatado}` });
    incluir.addEventListener('change', () => { it.incluir = incluir.checked; atualizarAcoes(); });
    const regime = h('select', { class: 'lote-regime', 'aria-label': 'Regime', disabled: !incluivel(it) },
      h('option', { value: '' }, 'Escolha o regime'), REGIMES.map(([v, t]) => h('option', { value: v }, t)));
    regime.value = it.regime || '';
    regime.addEventListener('change', () => {
      it.regime = regime.value || null;
      // Regime mudou: a IA confere de novo antes de salvar, e o lembrete dos parâmetros acompanha.
      it.revisao = null;
      atualizarCartao(it);
      it.no.querySelector('.lote-regime')?.focus();
      atualizarAcoes();
    });
    const notas = [...(p?.problemas || []).map((t) => h('li', { class: 'lote-problema' }, t)), ...(p?.avisos || []).map((t) => h('li', {}, t)),
      // Lembrete dos parâmetros padrão do regime escolhido agora (muda junto com o seletor).
      ...(incluivel(it) && avisosPadrao[it.regime] ? [h('li', {}, avisosPadrao[it.regime])] : [])];
    const r = it.revisao;
    const blocoIa = r ? h('div', { class: `lote-ia lote-ia-${r.veredito}` },
      h('p', {}, h('strong', {}, 'Revisão da IA: '), r.resumo || (r.veredito === 'aprovar' ? 'Sem problemas.' : '')),
      r.problemas?.length ? h('ul', {}, r.problemas.map((t) => h('li', {}, t))) : null,
      r.regimeSugerido && r.regimeSugerido !== it.regime ? h('button', { class: 'btn btn-pequeno', type: 'button', onclick: () => {
        it.regime = r.regimeSugerido; it.revisao = null; atualizarCartao(it); atualizarAcoes();
      } }, `Usar ${ROTULO[r.regimeSugerido]} (sugestão da IA)`) : null) : null;
    const li = h('li', { class: 'lote-empresa' },
      h('div', { class: 'lote-topo-empresa' }, incluir,
        h('div', { class: 'lote-identificacao' },
          h('strong', {}, d?.razaoSocial || p?.perfil?.nome || it.entrada.nome || 'CNPJ ' + it.entrada.cnpjFormatado),
          h('span', { class: 'suave' }, [it.entrada.cnpjFormatado, d?.municipio ? `${d.municipio.nome}/${d.municipio.uf}` : null, d?.cnae ? `CNAE ${cnae(d.cnae.codigo)}${d.cnae.descricao ? ` — ${d.cnae.descricao}` : ''}` : null].filter(Boolean).join(' · '))),
        h('div', { class: 'marcadores' }, marcadores)),
      p && incluivel(it) ? h('div', { class: 'lote-regime-linha' }, regime,
        h('span', { class: 'suave' }, [d?.enquadramento ? `Base pública: ${d.enquadramento}` : null, p.regimeDeclarado ? `Planilha: ${ROTULO[p.regimeDeclarado]}` : null].filter(Boolean).join(' · '))) : null,
      notas.length ? h('ul', { class: 'lote-notas' }, notas) : null,
      blocoIa);
    it.no = li;
    return li;
  }
  // Troca o cartão no lugar (sem perder a rolagem).
  function atualizarCartao(it) { const antigo = it.no; const novo = cartao(it); antigo?.replaceWith(novo); }

  function contagem() {
    const c = {};
    for (const it of itens) c[it.situacao] = (c[it.situacao] || 0) + 1;
    return c;
  }
  function atualizarAcoes() {
    const c = contagem();
    const consultando = (c.fila || 0) + (c.consultando || 0);
    const partes = [plural(itens.length, 'empresa', 'empresas')];
    if (consultando) partes.push(`consultando a base pública: ${itens.length - consultando} de ${itens.length}`);
    for (const [k, t] of [['pronta', 'conferidas'], ['revisar', 'para conferir'], ['bloqueada', 'não podem ser salvas'], ['ja_cadastrada', 'já cadastradas'], ['erro', 'com erro'], ['salva', 'salvas']]) if (c[k]) partes.push(`${c[k]} ${t}`);
    resumo.textContent = `${partes.join(' · ')}.`;
    barra.hidden = !consultando;
    barra.max = itens.length; barra.value = itens.length - consultando;
    const n = escolhidas().length;
    const faltam = precisamRevisao().length;
    const semRegime = itens.filter((it) => incluivel(it) && it.incluir && !it.regime).length;
    const temporarias = itens.filter((it) => it.situacao === 'erro' && it.preparada?.temporario).length;
    const bloqueadasIa = escolhidas().filter((it) => it.revisao?.veredito === 'bloquear').length;
    acoes.replaceChildren(...[
      consultando ? null : h('div', { class: 'lote-botoes' },
        temporarias ? h('button', { class: 'btn', type: 'button', onclick: () => consultarTodas(itens.filter((it) => it.situacao === 'erro' && it.preparada?.temporario)) }, icone(ICONES.atualizar), `Consultar de novo ${plural(temporarias, 'a que falhou', 'as que falharam')}`) : null,
        ia.configurado && faltam ? h('button', { class: 'btn btn-primario', type: 'button', onclick: revisar }, icone(ICONES.assistente || ICONES.busca), `Revisar ${plural(faltam, 'empresa', 'empresas')} com a IA`) : null,
        n && (!faltam || semIa) ? h('button', { class: 'btn btn-primario', type: 'button', onclick: salvar }, `Salvar ${plural(n, 'empresa', 'empresas')}`) : null),
      semRegime ? h('p', { class: 'erro-campo' }, `${plural(semRegime, 'empresa marcada está', 'empresas marcadas estão')} sem regime: escolha MEI, Simples, Presumido ou Real.`) : null,
      bloqueadasIa ? h('p', { class: 'erro-campo' }, `A IA recomendou não salvar ${plural(bloqueadasIa, 'empresa marcada', 'empresas marcadas')}. Desmarque ou confira antes de salvar.`) : null,
      !consultando && !ia.configurado && n ? h('div', { class: 'cartao cartao-alerta' },
        h('p', {}, h('strong', {}, 'A revisão pela IA precisa do assistente configurado. '), 'Escolha o provedor e informe a chave de API para a IA conferir cada empresa antes de salvar.'),
        h('a', { class: 'btn btn-pequeno', href: '#/assistente/configurar' }, 'Configurar o assistente'),
        h('label', { class: 'caixa' }, h('input', { type: 'checkbox', checked: semIa, onchange: (e) => { semIa = e.target.checked; atualizarAcoes(); } }),
          h('span', {}, 'Salvar sem a revisão da IA (só com as conferências automáticas do app)'))) : null,
      !consultando && ia.configurado && faltam && n ? h('p', { class: 'suave' }, `A IA (${ia.modelo}) confere situação cadastral, regime, atividade e parâmetros de cada empresa antes de salvar.`) : null,
    ].filter(Boolean));
  }

  async function consultarUma(it) {
    it.situacao = 'consultando'; atualizarCartao(it);
    for (let tentativa = 0; ; tentativa++) {
      try {
        const { empresa } = await api('POST', '/api/empresas/lote/consultar', it.entrada);
        it.preparada = empresa;
        it.situacao = empresa.situacao;
        it.regime = empresa.regime || null;
        it.incluir = ['pronta', 'revisar'].includes(empresa.situacao);
        it.revisao = null;
        break;
      } catch (e) {
        // Limite de consultas por minuto: espera e continua sozinho.
        if (e instanceof ErroApi && e.status === 429 && tentativa < 6) { resumo.textContent = 'Aguardando o limite de consultas da base pública…'; await espera(20_000); continue; }
        it.preparada = { situacao: 'erro', temporario: true, problemas: [e.message], avisos: [] };
        it.situacao = 'erro';
        break;
      }
    }
    atualizarCartao(it); atualizarAcoes();
  }
  async function consultarTodas(alvo) {
    for (const it of alvo) { it.situacao = 'fila'; atualizarCartao(it); }
    atualizarAcoes();
    let proxima = 0;
    const trabalhar = async () => { while (proxima < alvo.length && document.body.contains(lista)) await consultarUma(alvo[proxima++]); };
    await Promise.all(Array.from({ length: Math.min(SIMULTANEAS, alvo.length) }, trabalhar));
    atualizarAcoes();
  }

  async function revisar(ev) {
    const botao = ev?.currentTarget;
    if (botao) botao.disabled = true;
    const fila = precisamRevisao();
    try {
      for (let i = 0; i < fila.length; i += POR_REVISAO) {
        const grupo = fila.slice(i, i + POR_REVISAO);
        resumo.textContent = `A IA está revisando: ${Math.min(i + grupo.length, fila.length)} de ${fila.length}…`;
        const r = await api('POST', '/api/ia/revisar-empresas', { empresas: grupo.map((it) => ({ ...it.preparada, regime: it.regime })) });
        for (const rev of r.revisoes) {
          const it = grupo.find((x) => x.preparada.cnpj === rev.cnpj);
          if (!it) continue;
          it.revisao = rev;
          // A IA recomendou não salvar: sai marcada como não incluída (o usuário pode marcar de novo).
          if (rev.veredito === 'bloquear') it.incluir = false;
          atualizarCartao(it);
        }
      }
      const c = { aprovar: 0, revisar: 0, bloquear: 0 };
      for (const it of fila) if (it.revisao) c[it.revisao.veredito] += 1;
      aviso(`Revisão da IA: ${c.aprovar} aprovada(s), ${c.revisar} para conferir, ${c.bloquear} para não salvar.`, 7000);
    } catch (e) {
      aviso(e.status === 0 ? 'Sem internet: a revisão da IA precisa de conexão.' : e.message, 8000);
    } finally { atualizarAcoes(); }
  }

  async function salvar(ev) {
    const botao = ev?.currentTarget;
    const alvo = escolhidas();
    const comBloqueio = alvo.filter((it) => it.revisao?.veredito === 'bloquear').length;
    if (comBloqueio && !confirm(`A IA recomendou não salvar ${plural(comBloqueio, 'destas empresas', 'destas empresas')}. Salvar mesmo assim?`)) return;
    if (botao) botao.disabled = true;
    resumo.textContent = `Salvando ${plural(alvo.length, 'empresa', 'empresas')}…`;
    try {
      const r = await api('POST', '/api/empresas/lote/salvar', {
        usaProcuracao: !!porProcuracao?.checked,
        empresas: alvo.map((it) => ({ perfil: it.preparada.perfil, regime: it.regime, veredito: it.revisao?.veredito || null })),
      });
      const falhas = r.resultados.filter((x) => !x.ok);
      for (const x of r.resultados) {
        const it = alvo.find((i) => i.preparada.cnpj === x.cnpj);
        if (it && x.ok) { it.situacao = 'salva'; it.incluir = false; atualizarCartao(it); }
      }
      await carregarConta({ permitirOffline: false }).catch(() => {});
      passo3.hidden = false;
      passo3.replaceChildren(...[
        h('h2', { class: 'lote-titulo' }, '3. Pronto'),
        h('p', {}, h('strong', {}, `${plural(r.criadas, 'empresa cadastrada', 'empresas cadastradas')}`), porProcuracao?.checked ? ', já por procuração.' : '. Envie o certificado A1 de cada uma para emitir e buscar notas.'),
        falhas.length ? h('div', { class: 'cartao cartao-alerta' }, h('strong', {}, `${plural(falhas.length, 'empresa não foi salva', 'empresas não foram salvas')}:`),
          h('ul', {}, falhas.map((f) => h('li', {}, `${f.cnpj}: ${f.erro}`)))) : null,
        h('p', { class: 'suave' }, 'Os parâmetros fiscais entraram com os padrões do regime: confira cada empresa em Dados da empresa (percentual de tributos, ISS do município).'),
        h('a', { class: 'btn btn-primario', href: '#/empresas' }, 'Ver empresas')].filter(Boolean));
      passo3.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      aviso(e.status === 0 ? 'Sem internet: tente de novo quando a conexão voltar.' : e.message, 8000);
    } finally { atualizarAcoes(); }
  }

  passo1.addEventListener('submit', async (e) => {
    e.preventDefault();
    erroPasso1.hidden = true;
    const texto = cLista.entrada.value.trim();
    if (!texto && !arquivo) { erroPasso1.textContent = 'Cole os CNPJs ou envie a planilha.'; erroPasso1.hidden = false; return; }
    consultar.disabled = true;
    try {
      const corpo = { texto, ...(arquivo ? { arquivo: { nome: arquivo.name, base64: await paraBase64(arquivo) } } : {}) };
      const r = await api('POST', '/api/empresas/lote/ler', corpo);
      avisosPadrao = r.avisosPadrao || {};
      itens = r.linhas.map((l) => ({ entrada: l, preparada: null, situacao: l.jaCadastrada ? 'ja_cadastrada' : 'fila', incluir: false, regime: l.regimeDeclarado || null, revisao: null }));
      lista.replaceChildren(...itens.map(cartao));
      passo2.hidden = false;
      passo3.hidden = true;
      const extras = [r.invalidos?.length ? `${plural(r.invalidos.length, 'CNPJ inválido ignorado', 'CNPJs inválidos ignorados')} (${r.invalidos.slice(0, 3).join(', ')}${r.invalidos.length > 3 ? '…' : ''})` : null,
        r.repetidos ? plural(r.repetidos, 'repetido ignorado', 'repetidos ignorados') : null,
        r.excedente ? `${r.excedente} além do limite de ${r.maximo} ficaram de fora` : null].filter(Boolean);
      if (extras.length) aviso(`${extras.join(' · ')}.`, 8000);
      passo2.scrollIntoView({ behavior: 'smooth', block: 'start' });
      await consultarTodas(itens.filter((it) => it.situacao === 'fila'));
    } catch (err) {
      erroPasso1.textContent = err.status === 0 ? 'Sem internet: a consulta precisa de conexão.' : err.message;
      erroPasso1.hidden = false;
    } finally { consultar.disabled = false; }
  });

  return {
    titulo: 'Cadastrar empresas em lote', aba: 'empresas', voltar: true,
    node: h('div', { class: 'lote-empresas' },
      h('p', {}, 'Para escritórios: informe vários CNPJs de uma vez. O app busca razão social, município, atividade e enquadramento (MEI, Simples, Presumido ou Real) na base pública da Receita, a IA confere cada empresa e você salva só as que aprovar.'),
      passo1, passo2, passo3),
  };
}
