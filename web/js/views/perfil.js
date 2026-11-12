import { h, anexar, campo, mostrarErros, aviso, mascaraDocumento, data, dataHora, buscaComSugestoes } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { buscarMunicipio } from '../store.js';
import { estado, carregarConta, ir } from '../app.js';
import { copiarTexto } from '../ui.js';
import { consultaAutomatica } from '../cnpj.js';

function checklist(eleg) {
  return h('ul', { class: 'check' }, eleg.itens.map((i) => h('li', {},
    h('span', { class: i.ok ? 'ok' : 'nao', 'aria-hidden': 'true' }, i.ok ? '✓' : '✕'),
    h('span', {}, h('span', { class: 'sr' }, i.ok ? 'Concluído: ' : 'Pendente: '), h('strong', {}, i.titulo),
      i.comoResolver ? h('span', { class: 'suave', style: 'display:block' }, i.comoResolver) : null,
      i.aviso ? h('span', { class: 'suave', style: 'display:block' }, i.aviso) : null))));
}

// Formulário dos dados fiscais de uma empresa: edição da empresa ativa e
// cadastro de uma nova. `salvarDados(corpo)` faz a chamada e o que vem depois.
// `ambientePadrao`: onde a empresa nova nasce (produção, quando o servidor está liberado).
export function formularioEmpresa({ p = {}, producaoLiberada = false, ambientePadrao = 'producao_restrita', textoBotao = 'Salvar dados da empresa', salvarDados }) {
  const cnpj = campo({ rotulo: 'CNPJ da empresa', valor: mascaraDocumento(p.documento || ''), atributos: { inputmode: 'text', autocapitalize: 'characters', autocomplete: 'off' }, oninput: (e) => { e.target.value = mascaraDocumento(e.target.value); } });
  const nome = campo({ rotulo: 'Nome ou razão social', ajuda: 'Só para exibição no app (a nota usa o nome do cadastro do CNPJ).', valor: p.nome || '', atributos: { maxlength: 300 } });
  let municipioIbge = p.municipioIbge || '';
  const municipio = buscaComSugestoes({
    rotulo: 'Município do CNPJ', ajuda: 'O mesmo do endereço do CNPJ na Receita.',
    valorInicial: p.municipio ? `${p.municipio.nome} - ${p.municipio.uf}` : '', placeholder: 'Digite a cidade',
    buscar: buscarMunicipio, formatar: (m) => `${m.nome} - ${m.uf}`,
    aoEscolher: (m, c) => { municipioIbge = m.ibge; c.entrada.value = `${m.nome} - ${m.uf}`; },
  });
  municipio.entrada.addEventListener('input', () => { municipioIbge = ''; });
  const regime = campo({
    rotulo: 'Regime tributário', valor: p.opSimpNac || '2',
    opcoes: [['2', 'MEI'], ['3', 'ME/EPP — Simples Nacional'], ['1', 'Lucro Presumido ou Lucro Real']],
  });
  // ----- Simples Nacional (ME/EPP) -----
  const regApTribSN = campo({
    rotulo: 'Como sua empresa paga os tributos', valor: p.regApTribSN || '1',
    ajuda: 'O normal é tudo pelo DAS. "ISS fora": a receita passou o sublimite estadual/municipal. "Tudo fora": passou o limite do Simples. Na dúvida, pergunte ao contador.',
    opcoes: [
      ['1', 'Tudo pelo Simples (DAS)'],
      ['2', 'ISS fora do Simples (sublimite)'],
      ['3', 'Tudo fora do Simples (limite)'],
    ],
  });
  const fmtPct = (v) => (v ? Number(v).toFixed(2).replace('.', ',') : '');
  const pTotTribSN = campo({
    rotulo: 'Percentual aproximado de tributos (%)', valor: fmtPct(p.pTotTribSN),
    ajuda: 'Sua alíquota efetiva do Simples no mês (está no PGDAS-D). Vai na nota como total aproximado de tributos. Atualize todo mês.',
    atributos: { inputmode: 'decimal', placeholder: 'Ex.: 6,00' },
  });
  const aliqIssSN = campo({
    rotulo: 'Alíquota do ISS no Simples (%)', valor: fmtPct(p.aliqIssSN),
    ajuda: 'Usada só quando o cliente retém o ISS. Entre 1,8% e 5% (regras oficiais E0621 e E0595).',
    atributos: { inputmode: 'decimal', placeholder: 'Ex.: 2,00' },
  });
  const blocoSimples = h('fieldset', { class: 'cartao', style: 'margin:12px 0' },
    h('legend', { class: 'rotulo', style: 'margin:0' }, 'Simples Nacional'), regApTribSN, pTotTribSN, aliqIssSN);
  // ----- Lucro Presumido / Real -----
  const apuracao = campo({ rotulo: 'Forma de tributação do IRPJ', valor: p.apuracao || 'presumido', opcoes: [['presumido', 'Lucro Presumido'], ['real', 'Lucro Real']] });
  const cstPisCofins = campo({
    rotulo: 'Situação do PIS/COFINS nos seus serviços', valor: p.cstPisCofins || '01',
    opcoes: [['01', '01 — Tributável (alíquota básica)'], ['06', '06 — Alíquota zero'], ['08', '08 — Sem incidência'], ['09', '09 — Suspensão']],
  });
  const aliqPis = campo({ rotulo: 'Alíquota do PIS (%)', valor: fmtPct(p.aliqPis), atributos: { inputmode: 'decimal', placeholder: 'Ex.: 0,65' } });
  const aliqCofins = campo({ rotulo: 'Alíquota da COFINS (%)', valor: fmtPct(p.aliqCofins), atributos: { inputmode: 'decimal', placeholder: 'Ex.: 3,00' } });
  const padroes = h('button', {
    class: 'btn btn-pequeno btn-texto', type: 'button',
    onclick: () => {
      const real = apuracao.entrada.value === 'real';
      aliqPis.entrada.value = real ? '1,65' : '0,65';
      aliqCofins.entrada.value = real ? '7,60' : '3,00';
    },
  }, 'Usar alíquotas padrão do regime');
  const avisoPadrao = h('p', { class: 'suave' }, 'Padrão: Presumido (cumulativo) PIS 0,65% e COFINS 3%; Real (não cumulativo) PIS 1,65% e COFINS 7,6%. Há exceções por atividade: confirme com seu contador.');
  const pTotFed = campo({ rotulo: 'Tributos federais aproximados (%)', valor: fmtPct(p.pTotTribFed), ajuda: 'Lei 12.741/2012 (ex.: tabela do IBPT para o seu serviço).', atributos: { inputmode: 'decimal', placeholder: 'Ex.: 13,45' } });
  const pTotMun = campo({ rotulo: 'Tributos municipais aproximados (%)', valor: fmtPct(p.pTotTribMun), ajuda: 'Em geral, a alíquota do ISS.', atributos: { inputmode: 'decimal', placeholder: 'Ex.: 5,00' } });
  const aliqIss = campo({
    rotulo: 'Alíquota do ISS (%)', valor: fmtPct(p.aliqIss),
    ajuda: 'Opcional. Só vai na nota quando o município onde o ISS é devido não é conveniado ao Sistema Nacional (regra E0619).',
    atributos: { inputmode: 'decimal', placeholder: 'Ex.: 5,00' },
  });
  const mostrarAliqPisCofins = () => { aliqPis.hidden = aliqCofins.hidden = padroes.hidden = avisoPadrao.hidden = cstPisCofins.entrada.value !== '01'; };
  cstPisCofins.entrada.addEventListener('change', mostrarAliqPisCofins);
  mostrarAliqPisCofins();
  const blocoFederais = h('fieldset', { class: 'cartao', style: 'margin:12px 0' },
    h('legend', { class: 'rotulo', style: 'margin:0' }, 'Lucro Presumido ou Real'),
    apuracao, cstPisCofins, aliqPis, aliqCofins, avisoPadrao, padroes, pTotFed, pTotMun, aliqIss);

  const mostrarSimples = () => {
    blocoSimples.hidden = regime.entrada.value !== '3';
    blocoFederais.hidden = regime.entrada.value !== '1';
  };
  regime.entrada.addEventListener('change', mostrarSimples);
  mostrarSimples();
  const email = campo({ rotulo: 'E-mail de contato', ajuda: 'Opcional. Vai na nota.', tipo: 'email', valor: p.email || '', atributos: { inputmode: 'email', maxlength: 80 } });
  const fone = campo({ rotulo: 'Telefone', ajuda: 'Opcional. DDD + número.', tipo: 'tel', valor: p.fone || '', atributos: { inputmode: 'tel' } });
  const im = campo({ rotulo: 'Inscrição municipal', ajuda: 'Informe só se a prefeitura tiver você no cadastro complementar (CNC). Se não tiver, deixe em branco: a Receita recusa IM sem cadastro (E0120).', valor: p.inscricaoMunicipal || '', atributos: { maxlength: 15 } });
  const serie = campo({ rotulo: 'Série da DPS', ajuda: 'Deixe 1, a menos que use outro sistema de emissão (faixa 1–49999).', valor: p.serieDps || '1', atributos: { inputmode: 'numeric', maxlength: 5 } });
  const ambiente = campo({
    rotulo: 'Ambiente da Receita', valor: p.ambiente || (producaoLiberada ? ambientePadrao : 'producao_restrita'),
    // Produção é o normal; o ambiente de testes fica para quem quer experimentar sem emitir nota de verdade.
    opcoes: [...(producaoLiberada || p.ambiente === 'producao' ? [['producao', 'Produção — notas fiscais de verdade']] : []), ['producao_restrita', 'Testes (produção restrita) — sem validade jurídica']],
  });
  const erroPerfil = h('p', { class: 'erro-campo', role: 'alert', hidden: true });
  const salvarPerfil = h('button', { class: 'btn btn-primario', type: 'submit' }, textoBotao);

  // Lembra o que veio da consulta: ao corrigir o CNPJ, o que era da empresa errada é trocado.
  const preenchido = { email: null, fone: null, municipio: null, nome: null, cnpj: null, regime: null, apuracao: null };
  const regimeInicial = regime.entrada.value;
  const apuracaoInicial = apuracao.entrada.value;
  const trocarSeAutomatico = (cmp, chave, valor) => {
    if (!cmp.entrada.value || cmp.entrada.value === preenchido[chave]) { cmp.entrada.value = valor || ''; preenchido[chave] = cmp.entrada.value || null; }
  };
  // CNPJ completo: razão social, município e enquadramento vêm da base pública.
  const consulta = consultaAutomatica(cnpj.entrada, {
    inicial: p.documento,
    aoFalhar: (_, cnpjFalhou) => {
      // Falhou a nova consulta do MESMO CNPJ ("Atualizar"): o que veio antes continua certo.
      if (cnpjFalhou && cnpjFalhou === preenchido.cnpj) return;
      preenchido.cnpj = null;
      if (preenchido.nome && nome.entrada.value === preenchido.nome) { nome.entrada.value = ''; preenchido.nome = null; }
      // Regime e apuração da empresa errada voltam ao que estava antes da consulta.
      if (preenchido.regime && regime.entrada.value === preenchido.regime) { regime.entrada.value = regimeInicial; mostrarSimples(); }
      if (preenchido.apuracao && apuracao.entrada.value === preenchido.apuracao) apuracao.entrada.value = apuracaoInicial;
      preenchido.regime = null; preenchido.apuracao = null;
      if (preenchido.municipio && municipioIbge === preenchido.municipio) { municipioIbge = ''; municipio.entrada.value = ''; preenchido.municipio = null; }
      for (const [cmp, k] of [[email, 'email'], [fone, 'fone']]) if (preenchido[k] && cmp.entrada.value === preenchido[k]) { cmp.entrada.value = ''; preenchido[k] = null; }
    },
    aoEncontrar: (d, cnpjAchado) => {
      preenchido.cnpj = cnpjAchado;
      nome.entrada.value = d.razaoSocial;
      preenchido.nome = d.razaoSocial;
      // Sem município na base, não fica o da consulta anterior (CNPJ corrigido).
      if (d.municipio) { municipioIbge = d.municipio.ibge; municipio.entrada.value = `${d.municipio.nome} - ${d.municipio.uf}`; preenchido.municipio = municipioIbge; }
      else if (municipioIbge && municipioIbge === preenchido.municipio) { municipioIbge = ''; municipio.entrada.value = ''; preenchido.municipio = null; }
      if (d.enquadramento?.opSimpNac) { regime.entrada.value = d.enquadramento.opSimpNac; mostrarSimples(); preenchido.regime = regime.entrada.value; }
      // CNPJ achado sem enquadramento: o regime que veio da empresa anterior (consulta errada) volta ao inicial.
      else if (preenchido.regime && regime.entrada.value === preenchido.regime) { regime.entrada.value = regimeInicial; mostrarSimples(); preenchido.regime = null; }
      if (d.enquadramento?.apuracao) { apuracao.entrada.value = d.enquadramento.apuracao; preenchido.apuracao = apuracao.entrada.value; }
      else if (preenchido.apuracao && apuracao.entrada.value === preenchido.apuracao) { apuracao.entrada.value = apuracaoInicial; preenchido.apuracao = null; }
      if (regime.entrada.value === '1' && cstPisCofins.entrada.value === '01' && !aliqPis.entrada.value && !aliqCofins.entrada.value) padroes.click();
      trocarSeAutomatico(email, 'email', d.email);
      trocarSeAutomatico(fone, 'fone', d.fone);
    },
  });
  const atualizarDaReceita = null; // o botão "Buscar dados do CNPJ" da consulta faz isso
  const formPerfil = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      salvarPerfil.disabled = true;
      erroPerfil.hidden = true;
      try {
        await salvarDados({
          documento: cnpj.entrada.value, nome: nome.entrada.value, municipioIbge, opSimpNac: regime.entrada.value,
          email: email.entrada.value, fone: fone.entrada.value, inscricaoMunicipal: im.entrada.value, serieDps: serie.entrada.value, ambiente: ambiente.entrada.value,
          regApTribSN: regApTribSN.entrada.value, pTotTribSN: pTotTribSN.entrada.value, aliqIssSN: aliqIssSN.entrada.value,
          apuracao: apuracao.entrada.value, cstPisCofins: cstPisCofins.entrada.value, aliqPis: aliqPis.entrada.value, aliqCofins: aliqCofins.entrada.value,
          pTotTribFed: pTotFed.entrada.value, pTotTribMun: pTotMun.entrada.value, aliqIss: aliqIss.entrada.value,
        });
      } catch (err) {
        if (err instanceof ErroApi && err.dados?.campos) mostrarErros({ documento: cnpj, municipioIbge: municipio, opSimpNac: regime, regApTribSN, pTotTribSN, aliqIssSN, cstPisCofins, aliqPis, aliqCofins, pTotTribFed: pTotFed, pTotTribMun: pTotMun, aliqIss, email, serieDps: serie, ambiente }, err.dados.campos);
        else { erroPerfil.textContent = err.message; erroPerfil.hidden = false; }
      } finally { salvarPerfil.disabled = false; }
    },
  }, cnpj, consulta, atualizarDaReceita, nome, municipio, regime, blocoSimples, blocoFederais, email, fone, h('details', {}, h('summary', {}, 'Opções avançadas'), im, serie, ambiente), erroPerfil, salvarPerfil);
  return formPerfil;
}

// O que a Receita respondeu à última consulta por procuração (só leitura: nenhuma nota é enviada).
// É a forma de saber, antes da primeira emissão, se a procuração da empresa está valendo.
function situacaoNaReceita(dados) {
  const r = dados.receita || {};
  if (!dados.procurador) return null;
  const conferir = h('button', { class: 'btn btn-pequeno', type: 'button', onclick: async () => {
    conferir.disabled = true;
    conferir.textContent = 'Consultando a Receita…';
    try {
      await api('POST', '/api/notas/sincronizar', {});
      aviso('A Receita aceitou a consulta por procuração desta empresa.', 6000);
    } catch (e) { aviso(e.status === 0 ? 'Sem internet: a consulta à Receita precisa de conexão.' : e.message, 9000); }
    // Recarrega a tela (o aviso continua à vista): aceita ou recusada, a situação aparece no cartão.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } }, 'Conferir a procuração na Receita');
  const texto = r.recusadaEm
    ? h('p', { class: 'erro-campo' }, h('strong', {}, `A Receita recusou a consulta por procuração em ${dataHora(r.recusadaEm)}. `), r.recusaMotivo || '')
    : r.consultadaEm
      ? h('p', {}, h('strong', {}, 'Procuração aceita pela Receita'), ` na consulta de ${dataHora(r.consultadaEm)}.`)
      : h('p', {}, 'A procuração desta empresa ainda não foi conferida na Receita. A consulta só lê as notas: nada é emitido.');
  return h('div', {}, texto, conferir);
}

// Procuração em uso: quem assina e como a empresa concede a procuração na Receita.
function cartaoProcuracao(dados) {
  const pr = dados.procurador;
  return h('section', { class: `cartao ${pr ? 'cartao-ok' : 'cartao-alerta'}` },
    pr ? h('div', {}, h('strong', {}, 'Assina pelo escritório: '), pr.titular, h('p', { class: 'suave' }, `${pr.documentoFormatado} · válido até ${data(pr.validoAte)}`))
      : h('p', {}, h('strong', {}, 'Falta o certificado do escritório. '), 'Envie em Certificado do escritório.'),
    situacaoNaReceita(dados),
    h('p', {}, 'A empresa precisa conceder a procuração no ', h('strong', {}, 'Portal de Serviços da Receita'), ' (servicos.receitafederal.gov.br) › "Nova Autorização": informar o ',
      pr ? `${pr.documentoFormatado} ` : 'CPF/CNPJ do procurador ', 'como procurador, a vigência e escolher o serviço ', h('strong', {}, 'NFS-e'), '. A Receita confere a procuração a cada envio.'),
    pr ? h('button', { class: 'btn btn-pequeno', type: 'button', onclick: (e) => copiarTexto(pr.documentoFormatado.replace(/\W/g, ''), e.currentTarget) }, 'Copiar CPF/CNPJ do procurador') : null,
    h('a', { class: 'btn btn-pequeno btn-texto', href: '#/procurador' }, 'Certificado do escritório'));
}

// Envio de certificado A1 (.pfx): da empresa ou do procurador da conta.
export function formularioCertificado({ url, ajuda, textoBotao = 'Enviar certificado', aoEnviar, consentimentoTexto }) {
  const arquivo = campo({ rotulo: 'Arquivo do certificado A1', ajuda, tipo: 'file', atributos: { accept: '.pfx,.p12,application/x-pkcs12' } });
  // Botão próprio em português no lugar do "Choose File" do navegador; o input continua ligado ao rótulo.
  arquivo.entrada.classList.add('visualmente-oculto');
  const nomeArquivo = h('span', { class: 'suave', 'aria-live': 'polite' }, 'Nenhum arquivo escolhido.');
  arquivo.entrada.addEventListener('change', () => { nomeArquivo.textContent = arquivo.entrada.files?.[0]?.name || 'Nenhum arquivo escolhido.'; arquivo.erro(''); });
  arquivo.entrada.after(h('div', { class: 'arquivo-escolha' },
    h('button', { class: 'btn', type: 'button', tabindex: '-1', 'aria-hidden': 'true', onclick: () => arquivo.entrada.click() }, 'Escolher arquivo .pfx'), nomeArquivo));
  arquivo.entrada.addEventListener('focus', () => arquivo.classList.add('com-foco'));
  arquivo.entrada.addEventListener('blur', () => arquivo.classList.remove('com-foco'));
  const senha = campo({ rotulo: 'Senha do certificado', tipo: 'password', atributos: { autocomplete: 'off' } });
  const idConsentimento = `consentimento-${url.replace(/\W/g, '')}`;
  const consentimento = h('input', { type: 'checkbox', id: idConsentimento });
  const erroCert = h('div', { class: 'erro-campo', role: 'alert', hidden: true });
  const enviar = h('button', { class: 'btn btn-primario', type: 'submit' }, textoBotao);
  return h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      erroCert.hidden = true;
      const f = arquivo.entrada.files?.[0];
      if (!f) { arquivo.erro('Escolha o arquivo do certificado.'); return; }
      if (!consentimento.checked) { erroCert.textContent = 'Marque a autorização para continuar.'; erroCert.hidden = false; return; }
      enviar.disabled = true;
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        await api('POST', url, { pfxBase64: btoa(bin), senha: senha.entrada.value, consentimento: true });
        senha.entrada.value = '';
        aoEnviar();
      } catch (err) {
        erroCert.replaceChildren(err.message, ...(err.dados?.problemas || []).map((x) => h('span', { style: 'display:block' }, `• ${x}`)));
        erroCert.hidden = false;
      } finally { enviar.disabled = false; }
    },
  }, arquivo, senha,
  h('label', { class: 'caixa', for: idConsentimento }, consentimento,
    h('span', {}, consentimentoTexto || 'Autorizo o Nota Sem Stress a guardar meu certificado de forma criptografada e a usá-lo somente para assinar e transmitir as notas que eu mandar emitir, consultar a situação delas e buscar na Receita as notas emitidas e recebidas por esta empresa (inclusive de tempos em tempos, de forma automática). Posso remover a qualquer momento.')),
  erroCert, enviar);
}

// Como a empresa assina: certificado próprio ou procuração eletrônica NFS-e (certificado do escritório).
function escolhaAssinatura(dados) {
  const usaProc = !!dados.perfil?.usaProcuracao;
  const definir = async (ativa) => {
    if (ativa === usaProc) return;
    try {
      await api('PUT', '/api/perfil/procuracao', { ativa });
      aviso(ativa ? 'Esta empresa passa a assinar com o certificado do escritório.' : 'Esta empresa volta a assinar com o próprio certificado.');
      location.reload();
    } catch (err) {
      if (err.dados?.acao === 'procurador') { aviso(err.message, 7000); ir('/procurador'); } else aviso(err.message, 7000);
    }
  };
  const opcao = (ativa, titulo, sub) => h('button', { class: 'item', type: 'button', 'aria-pressed': String(ativa === usaProc), onclick: () => definir(ativa) },
    h('div', { class: 'item-corpo' }, h('div', { class: 'item-titulo', style: 'white-space:normal' }, titulo), h('div', { class: 'item-sub', style: 'white-space:normal' }, sub)));
  const procuracao = opcao(true, 'Certificado do escritório (procuração eletrônica)', 'Um só certificado, o do escritório ou do contador, para todas as empresas que concederam a procuração NFS-e na Receita.');
  const proprio = opcao(false, 'Certificado A1 desta empresa', 'O e-CNPJ da própria empresa assina e envia as notas.');
  // Conta com certificado do escritório trabalha por procuração: essa opção vem primeiro.
  return h('div', { role: 'group', 'aria-label': 'Como esta empresa assina as notas' }, ...(dados.procurador ? [procuracao, proprio] : [proprio, procuracao]));
}

export async function tela() {
  const dados = await api('GET', '/api/perfil');
  const p = dados.perfil || {};
  const node = h('div');
  const formPerfil = formularioEmpresa({
    p, producaoLiberada: dados.producaoLiberada, ambientePadrao: dados.ambientePadrao,
    salvarDados: async (corpo) => {
      await api('PUT', '/api/perfil', corpo);
      aviso('Dados da empresa salvos.');
      await carregarConta({ permitirOffline: false });
      location.reload();
    },
  });

  // ----- Certificado -----
  const cert = dados.certificadoEmpresa;
  const usaProc = !!dados.perfil?.usaProcuracao;
  const formCert = formularioCertificado({
    url: '/api/certificado', ajuda: 'Formato .pfx ou .p12 (e-CNPJ desta empresa).', textoBotao: cert ? 'Trocar certificado' : 'Enviar certificado',
    aoEnviar: () => { aviso('Certificado verificado e guardado com segurança.'); location.reload(); },
  });

  const statusCert = cert
    ? h('div', { class: 'cartao cartao-ok' }, h('strong', {}, 'Certificado ativo'), h('p', {}, cert.titular), h('p', { class: 'suave' }, `Válido até ${data(cert.validoAte)} · ${cert.emissor}`),
      h('button', {
        class: 'btn btn-texto btn-perigo', type: 'button',
        onclick: async () => {
          if (!confirm('Remover o certificado? Você não poderá emitir até enviar outro.')) return;
          await api('DELETE', '/api/certificado');
          location.reload();
        },
      }, 'Remover certificado'))
    : null;

  // A Receita recusou a última consulta por procuração: aparece antes de tudo, porque as notas seriam recusadas.
  const recusada = usaProc && dados.receita?.recusadaEm;
  anexar(node,
    recusada ? h('section', { class: 'cartao cartao-erro', role: 'alert' },
      h('strong', {}, 'A Receita recusou a consulta por procuração desta empresa'),
      h('p', {}, `${dataHora(dados.receita.recusadaEm)}${dados.receita.recusaMotivo ? `: ${dados.receita.recusaMotivo}` : '.'}`),
      h('p', {}, 'Enquanto a procuração eletrônica NFS-e para o escritório não estiver vigente, as notas desta empresa serão recusadas. Confira no Portal de Serviços da Receita e consulte de novo.'),
      h('a', { class: 'btn btn-pequeno', href: '#certificado', onclick: (e) => { e.preventDefault(); document.getElementById('certificado')?.scrollIntoView({ behavior: 'smooth' }); } }, 'Ver a procuração')) : null,
    h('section', { class: 'cartao' }, h('h2', { style: 'font-size:19px;margin-top:0' }, dados.elegibilidade.podeEmitir ? (recusada ? 'Dados prontos para emitir' : 'Tudo pronto para emitir') : 'O que falta para emitir'), checklist(dados.elegibilidade)),
    h('h3', {}, 'Dados fiscais'), formPerfil,
    h('h3', { id: 'certificado' }, 'Certificado digital'),
    h('details', { class: 'cartao' }, h('summary', {}, 'Por que preciso do certificado?'),
      h('p', {}, 'A Receita só aceita notas enviadas por aplicativos quando são assinadas com um certificado digital ICP-Brasil: o do próprio CNPJ (e-CNPJ) ou, desde 1º/11/2026, o de um procurador com procuração eletrônica NFS-e da empresa. O login gov.br e o usuário e senha do Portal servem para o Emissor Nacional no site, não para outros aplicativos.'),
      h('p', {}, 'Aceitamos o modelo A1 (arquivo). O modelo A3 (cartão ou token) não pode ser usado por um servidor.'),
      h('p', {}, 'Sem certificado, você pode continuar preparando rascunhos e emitir pelo Emissor Nacional.')),
    dados.perfil ? escolhaAssinatura(dados) : null,
    usaProc ? cartaoProcuracao(dados) : null,
    usaProc ? null : statusCert,
    !dados.perfil ? h('p', { class: 'suave' }, 'Salve o perfil primeiro.')
      : usaProc ? h('details', {}, h('summary', {}, 'Certificado próprio desta empresa (opcional)'), statusCert, formCert)
        : cert ? h('details', {}, h('summary', {}, 'Trocar certificado'), formCert) : formCert,
    h('h3', {}, 'Empresa'),
    h('button', {
      class: 'btn btn-texto btn-perigo', type: 'button',
      onclick: async () => {
        if (!confirm(`Remover "${p.nome || 'esta empresa'}" da sua conta? Só é possível enquanto ela não tiver enviado notas à Receita. Rascunhos, clientes, serviços, notas tomadas baixadas e o certificado desta empresa serão apagados.`)) return;
        try {
          await api('DELETE', `/api/empresas/${estado.conta.prestadorId}`);
          aviso('Empresa removida.');
          await carregarConta({ permitirOffline: false, empresa: null });
          ir('/empresas', { substituir: true });
        } catch (err) { aviso(err.message, 8000); }
      },
    }, 'Remover empresa da conta'),
  );
  return { titulo: 'Dados da empresa', aba: 'perfil', voltar: true, node };
}
