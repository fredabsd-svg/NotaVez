// E-mail das notas: "Enviar ao cliente" (destinatário do cadastro, texto escrito pela IA, tudo editável,
// PDF e XML em anexo) e a configuração do e-mail de envio da conta (Conta › E-mail para enviar notas).
import { h, campo, aviso, icone, ICONES, dataHora, mostrarErros } from '../ui.js';
import { api, ErroApi, cabecalhosIdentidade } from '../api.js';
import { ir } from '../app.js';

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const listaEmails = (t) => String(t || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
const emailValido = (e) => /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(e);
// "DANFSe-3550308…0011.pdf": a chave de acesso inteira (50 dígitos) não cabe numa linha do celular.
const nomeCurto = (nome) => String(nome).replace(/(\d{7})\d{36,}(\d{4})/, '$1…$2');
const mensagemDe = (e) => (e instanceof ErroApi && e.status === 0 ? 'Sem internet: o envio precisa de conexão.' : e.message);

// O que o texto (talvez editado) deixou de citar. Só avisa; quem decide é a pessoa.
function faltasNoTexto(resumo, corpo) {
  const c = String(corpo || '');
  const faltas = [];
  if (resumo.numero && !new RegExp(`(^|\\D)${resumo.numero}(\\D|$)`).test(c)) faltas.push('o número da nota');
  const [mes, ano] = String(resumo.competencia || '').split('/');
  const nome = MESES[Number(mes) - 1];
  if (resumo.competencia && !(c.includes(resumo.competencia) || (nome && new RegExp(nome, 'i').test(c) && c.includes(ano)))) faltas.push('a competência');
  if (resumo.valor && !c.replace(/\s/g, '').includes(resumo.valor.replace(/\s/g, ''))) faltas.push('o valor do serviço');
  if (!/reten|retid/i.test(c)) faltas.push('se houve retenção');
  return faltas;
}

// Documentos da nota como arquivos (para a folha de compartilhamento do celular, quando não há e-mail configurado).
async function arquivos(notaId, anexos) {
  const docs = [];
  for (const a of anexos) {
    const url = a.id === 'pdf' ? `/api/notas/${notaId}/danfse` : `/api/notas/${notaId}/xml`;
    const r = await fetch(url, { credentials: 'same-origin', headers: cabecalhosIdentidade() });
    if (r.ok) docs.push(new File([await r.blob()], a.nome, { type: a.id === 'pdf' ? 'application/pdf' : 'application/xml' }));
  }
  return docs;
}

// ------------------------------------------------------------------ Enviar ao cliente
export async function enviar({ id }) {
  const dados = await api('GET', `/api/notas/${id}/email`);
  const { resumo } = dados;
  const configurado = !!dados.config?.configurado;

  const cPara = campo({ rotulo: 'Para', valor: dados.para.join(', '), atributos: { type: 'email', multiple: true, inputmode: 'email', autocomplete: 'off', spellcheck: 'false', placeholder: 'email@cliente.com.br' },
    ajuda: dados.para.length ? 'Veio do cadastro do cliente. Pode trocar ou incluir outros, separados por vírgula.' : 'O cliente não tem e-mail no cadastro. Digite um ou mais, separados por vírgula.' });
  const salvarNoCliente = h('input', { type: 'checkbox', id: 'em-salvar-cliente', checked: true });
  const copia = h('input', { type: 'checkbox', id: 'em-copia', checked: configurado ? dados.config.copiaParaMim : false });
  const anexoMarcado = Object.fromEntries(dados.anexos.map((a) => [a.id, h('input', { type: 'checkbox', checked: true, id: `em-anexo-${a.id}` })]));
  const cAssunto = campo({ rotulo: 'Assunto', valor: '', atributos: { maxlength: 200, autocomplete: 'off' } });
  const cCorpo = campo({ rotulo: 'Mensagem', area: true, valor: '', atributos: { rows: 12, maxlength: 10000, class: 'em-mensagem' } });
  const origem = h('p', { class: 'suave em-origem', 'aria-live': 'polite' });
  const faltas = h('p', { class: 'em-faltas', hidden: true, role: 'status' });
  const conferir = () => {
    const f = faltasNoTexto(resumo, cCorpo.entrada.value);
    faltas.hidden = !f.length || !cCorpo.entrada.value.trim();
    faltas.textContent = f.length ? `Confira: a mensagem não cita ${f.join(', ').replace(/, ([^,]*)$/, ' e $1')}.` : '';
  };
  // A mensagem inteira à vista (a caixa cresce com o texto), sem rolagem dentro dela.
  const ajustarAltura = () => { const t = cCorpo.entrada; t.style.height = 'auto'; t.style.height = `${t.scrollHeight + 2}px`; };
  cCorpo.entrada.addEventListener('input', () => { conferir(); ajustarAltura(); });

  // Texto: pedido à IA da conta (ou modelo padrão). "Escrever outro" manda a versão atual para vir diferente.
  let anterior = null;
  const cInstrucao = campo({ rotulo: 'Como você quer o texto? (opcional)', valor: '', atributos: { maxlength: 300, autocomplete: 'off', placeholder: 'ex.: mais formal, mais curto, agradecer pelo projeto novo' } });
  const btnOutro = h('button', { class: 'btn btn-pequeno', type: 'button', onclick: () => escrever() }, icone(ICONES.atualizar), dados.iaConfigurada ? 'Escrever outro texto com a IA' : 'Refazer com o modelo padrão');
  const blocoIa = h('details', { class: 'em-ia' }, h('summary', {}, 'Pedir outro texto'), cInstrucao, btnOutro);
  let pedindo = 0;
  async function escrever() {
    const meu = ++pedindo;
    btnOutro.disabled = true;
    cCorpo.entrada.disabled = true; cAssunto.entrada.disabled = true;
    origem.textContent = dados.iaConfigurada ? 'A IA está escrevendo o e-mail com os dados da nota…' : 'Montando o texto…';
    try {
      const r = await api('POST', `/api/notas/${id}/email/texto`, { instrucao: cInstrucao.entrada.value.trim(), anterior,
        anexos: Object.entries(anexoMarcado).filter(([, c]) => c.checked).map(([k]) => k) });
      if (meu !== pedindo) return;
      cAssunto.entrada.value = r.assunto;
      cCorpo.entrada.value = r.corpo;
      anterior = { corpo: r.corpo };
      requestAnimationFrame(ajustarAltura);
      origem.textContent = r.aviso || (r.origem === 'ia' ? `Escrito pela IA · ${[r.provedorNome, r.modelo].filter(Boolean).join(' · ') || 'assistente'}. Leia e ajuste o que quiser antes de enviar.`
        : 'Texto padrão. Para a IA escrever um texto sob medida, configure o assistente em Assistente › Configurar.');
      conferir();
    } catch (e) {
      if (meu !== pedindo) return;
      origem.textContent = `Não foi possível escrever o texto: ${mensagemDe(e)} Escreva a mensagem ou tente de novo.`;
    } finally {
      if (meu === pedindo) { btnOutro.disabled = false; cCorpo.entrada.disabled = false; cAssunto.entrada.disabled = false; }
    }
  }

  const erroEnvio = h('p', { class: 'cartao cartao-erro', role: 'alert', hidden: true });
  const btnEnviar = h('button', { class: 'btn btn-primario btn-grande', type: 'submit', disabled: !configurado }, icone(ICONES.email), 'Enviar e-mail');
  async function enviarAgora(ev) {
    ev.preventDefault();
    erroEnvio.hidden = true;
    const para = listaEmails(cPara.entrada.value);
    const anexos = Object.entries(anexoMarcado).filter(([, c]) => c.checked).map(([k]) => k);
    const erros = {};
    if (!para.length) erros.para = 'Informe o e-mail do cliente.';
    else if (para.some((e) => !emailValido(e))) erros.para = `Confira: ${para.filter((e) => !emailValido(e)).join(', ')}`;
    if (!cAssunto.entrada.value.trim()) erros.assunto = 'Escreva o assunto.';
    if (!cCorpo.entrada.value.trim()) erros.corpo = 'Escreva a mensagem.';
    mostrarErros({ para: cPara, assunto: cAssunto, corpo: cCorpo }, erros);
    if (Object.keys(erros).length) return;
    if (!anexos.length && !confirm('Enviar sem o PDF e sem o XML da nota?')) return;
    btnEnviar.disabled = true;
    const rotulo = btnEnviar.lastChild.textContent;
    btnEnviar.lastChild.textContent = 'Enviando…';
    try {
      const r = await api('POST', `/api/notas/${id}/email`, { para, copiaParaMim: copia.checked, assunto: cAssunto.entrada.value, corpo: cCorpo.entrada.value, anexos,
        salvarNoCliente: dados.clienteSemEmail && salvarNoCliente.checked });
      aviso(`E-mail enviado para ${r.para.join(', ')}.${r.clienteAtualizado ? ' O e-mail ficou salvo no cadastro do cliente.' : ''}`, 6000);
      ir(`/notas/${id}`, { substituir: true });
    } catch (e) {
      if (e instanceof ErroApi && e.campos) mostrarErros({ para: cPara, assunto: cAssunto, corpo: cCorpo }, e.campos);
      erroEnvio.textContent = mensagemDe(e);
      erroEnvio.hidden = false;
      erroEnvio.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } finally { btnEnviar.disabled = !configurado; btnEnviar.lastChild.textContent = rotulo; }
  }

  // Sem e-mail configurado: compartilhar pelo celular ou abrir o programa de e-mail do aparelho.
  const alternativas = h('div', { class: 'em-alternativas' },
    navigator.share ? h('button', { class: 'btn', type: 'button', onclick: async () => {
      try {
        const docs = await arquivos(id, dados.anexos.filter((a) => anexoMarcado[a.id].checked));
        const texto = cCorpo.entrada.value || `${cAssunto.entrada.value}`;
        if (docs.length && navigator.canShare?.({ files: docs })) await navigator.share({ title: cAssunto.entrada.value, text: texto, files: docs });
        else await navigator.share({ title: cAssunto.entrada.value, text: texto });
      } catch (e) { if (e?.name !== 'AbortError') aviso('Não foi possível compartilhar.'); }
    } }, icone(ICONES.compartilhar), 'Compartilhar') : null,
    h('button', { class: 'btn', type: 'button', onclick: () => {
      const url = `mailto:${listaEmails(cPara.entrada.value).join(',')}?subject=${encodeURIComponent(cAssunto.entrada.value)}&body=${encodeURIComponent(cCorpo.entrada.value)}`;
      location.href = url;
      aviso('No seu programa de e-mail, anexe o PDF e o XML (botões "Ver DANFSe" e "Baixar XML" na nota).', 8000);
    } }, icone(ICONES.abrir), 'Abrir no meu e-mail'));

  const retencao = resumo.retencao.houve
    ? `Retenção: ${resumo.retencao.itens.map((i) => `${i.tributo} ${i.valor}`).join(', ')} · líquido ${resumo.retencao.valorLiquido}`
    : 'Sem retenção de impostos';
  const node = h('form', { class: 'form-estreito em-tela', novalidate: true, onsubmit: enviarAgora },
    h('div', { class: 'cartao em-resumo' },
      h('p', { class: 'em-resumo-titulo' }, h('strong', {}, `NFS-e nº ${resumo.numero}`), dados.clienteNome ? ` · ${dados.clienteNome}` : ''),
      h('p', {}, `Competência ${resumo.competencia} · ${resumo.valor}`),
      h('p', { class: 'suave' }, retencao),
      resumo.teste ? h('p', { class: 'em-teste' }, `Atenção: ${resumo.teste}.`) : null),
    configurado
      ? h('p', { class: 'suave em-de' }, 'De: ', h('strong', {}, dados.remetente.nome), ` <${dados.remetente.email}>`, dados.remetente.via ? ` · pela conta ${dados.remetente.via}` : '', ' · ', h('a', { href: '#/email?voltar=' + encodeURIComponent(`/notas/${id}/email`) }, 'alterar'))
      : h('div', { class: 'cartao cartao-alerta' },
        h('h2', { class: 'em-subtitulo' }, 'Falta configurar o e-mail de envio'),
        h('p', {}, 'O app envia a nota pelo seu próprio e-mail: entre com a sua conta Google ou Microsoft, ou use usuário e senha. É uma vez só e vale para todas as empresas.'),
        h('a', { class: 'btn btn-primario', href: '#/email?voltar=' + encodeURIComponent(`/notas/${id}/email`) }, icone(ICONES.ajustes), 'Configurar e-mail'),
        h('p', { class: 'suave' }, 'Ou, por enquanto, mande por outro caminho com o texto abaixo:'), alternativas),
    cPara,
    dados.clienteSemEmail ? h('label', { class: 'caixa', for: 'em-salvar-cliente' }, salvarNoCliente, h('span', {}, 'Salvar este e-mail no cadastro do cliente')) : null,
    configurado ? h('label', { class: 'caixa', for: 'em-copia' }, copia, h('span', {}, `Receber uma cópia (${dados.config.remetenteEmail})`)) : null,
    h('fieldset', { class: 'em-anexos' }, h('legend', {}, 'Anexos'),
      dados.anexos.map((a) => h('label', { class: 'caixa', for: `em-anexo-${a.id}` }, anexoMarcado[a.id], h('span', {}, a.descricao, h('br'), h('span', { class: 'suave em-arquivo', title: a.nome }, nomeCurto(a.nome)))))),
    cAssunto, cCorpo, origem, faltas, blocoIa,
    erroEnvio,
    configurado ? btnEnviar : null,
    dados.envios.length ? h('section', { class: 'em-envios' }, h('h3', {}, 'Já enviado'),
      h('ul', { class: 'lista-simples' }, dados.envios.map((e) => h('li', { class: 'suave' }, `${dataHora(e.enviadoEm)} · para ${e.para.join(', ')}${e.cco?.length ? ' (com cópia para você)' : ''}`)))) : null,
    h('a', { class: 'btn btn-texto', href: `#/notas/${id}` }, 'Voltar à nota'));
  escrever();
  return { titulo: 'Enviar ao cliente', aba: 'notas', voltar: true, tarefa: true, node };
}

// ------------------------------------------------------------------ Configuração do e-mail de envio
const PROVEDORES = [
  { id: 'gmail', nome: 'Gmail / Google Workspace', host: 'smtp.gmail.com', porta: 465, seguranca: 'ssl',
    dica: 'Use uma senha de app (não a senha do Gmail): na Conta Google, ative a verificação em duas etapas e crie uma em Segurança › Senhas de app. Cole aqui as 16 letras.' },
  { id: 'outlook', nome: 'Outlook.com / Hotmail', host: 'smtp-mail.outlook.com', porta: 587, seguranca: 'starttls',
    dica: 'Ative a verificação em duas etapas na conta Microsoft e crie uma senha de app. A Microsoft vem limitando o envio por senha; se o teste falhar, use o botão "Entrar com a Microsoft" acima.' },
  { id: 'm365', nome: 'Microsoft 365 (empresa)', host: 'smtp.office365.com', porta: 587, seguranca: 'starttls',
    dica: 'O Microsoft 365 vem com o "SMTP autenticado" desligado: o administrador precisa liberar para esta caixa de e-mail. Mais simples: use o botão "Entrar com a Microsoft" acima.' },
  { id: 'zoho', nome: 'Zoho Mail', host: 'smtp.zoho.com', porta: 465, seguranca: 'ssl', dica: 'Com verificação em duas etapas, gere uma senha específica de aplicativo no Zoho.' },
  { id: 'hostinger', nome: 'Hostinger (e-mail do seu domínio)', host: 'smtp.hostinger.com', porta: 465, seguranca: 'ssl', dica: 'Use o e-mail completo e a senha da caixa criada no painel da Hostinger.' },
  { id: 'locaweb', nome: 'Locaweb (e-mail do seu domínio)', host: 'email-ssl.com.br', porta: 465, seguranca: 'ssl', dica: 'Use o e-mail completo e a senha da caixa de e-mail.' },
  { id: 'yahoo', nome: 'Yahoo Mail', host: 'smtp.mail.yahoo.com', porta: 465, seguranca: 'ssl', dica: 'Crie uma senha de app em Segurança da conta Yahoo.' },
  { id: 'icloud', nome: 'iCloud', host: 'smtp.mail.me.com', porta: 587, seguranca: 'starttls', dica: 'Crie uma senha específica de app em appleid.apple.com e use o e-mail @icloud.com como usuário.' },
  { id: 'brevo', nome: 'Brevo (envio profissional)', host: 'smtp-relay.brevo.com', porta: 587, seguranca: 'starttls', dica: 'Usuário e senha são o login e a chave SMTP do Brevo (Configurações › SMTP e API). O remetente precisa estar validado lá.' },
  { id: 'outro', nome: 'Outro servidor', host: '', porta: 465, seguranca: 'ssl', dica: 'Peça ao seu provedor o servidor de saída (SMTP), a porta e o tipo de segurança.' },
];

// Logotipos simples para os botões de conexão (SVG montado no DOM: a CSP não permite innerHTML de terceiros).
function logo(tipo) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'em-logo');
  const forma = (nome, attrs) => { const el = document.createElementNS(ns, nome); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); svg.append(el); };
  if (tipo === 'microsoft') {
    forma('rect', { x: 2, y: 2, width: 9.5, height: 9.5, fill: '#F25022' }); forma('rect', { x: 12.5, y: 2, width: 9.5, height: 9.5, fill: '#7FBA00' });
    forma('rect', { x: 2, y: 12.5, width: 9.5, height: 9.5, fill: '#00A4EF' }); forma('rect', { x: 12.5, y: 12.5, width: 9.5, height: 9.5, fill: '#FFB900' });
  } else {
    forma('path', { d: 'M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z', fill: '#4285F4' });
    forma('path', { d: 'M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z', fill: '#34A853' });
    forma('path', { d: 'M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2L6.4 14z', fill: '#FBBC05' });
    forma('path', { d: 'M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.3 3-4 5.6-4z', fill: '#EA4335' });
  }
  return svg;
}

const NOMES_OAUTH = { google: 'Google', microsoft: 'Microsoft' };
const MOTIVOS = {
  fluxo: 'O pedido de conexão expirou ou foi aberto em outro navegador. Toque no botão de novo, neste mesmo navegador.',
  permissao: 'Faltou autorizar o envio de e-mails. Toque no botão de novo e, na tela de permissões, deixe marcada a opção de enviar e-mails.',
  conta: 'Não foi possível saber o e-mail desta conta. Tente de novo com outra conta.',
  provedor: 'O provedor recusou o pedido de conexão. Tente de novo; se continuar, veja o guia de ativação.',
};

export async function configurar(_params, query = {}) {
  const { config, oauth = {} } = await api('GET', '/api/email/config');
  const voltar = /^\/notas\/[\w-]+\/email$/.test(query.voltar || '') ? query.voltar : null;
  const atual = config.configurado ? config : {};
  const conectada = atual.tipo === 'google' || atual.tipo === 'microsoft';
  // Some com o resultado da conexão do endereço (recarregar a tela não repete o teste).
  if (query.conexao) history.replaceState(null, '', `#/email${voltar ? `?voltar=${encodeURIComponent(voltar)}` : ''}`);

  const estado = h('p', { class: 'suave em-estado', 'aria-live': 'polite' });
  async function testar(botao) {
    if (botao) botao.disabled = true;
    estado.textContent = 'Enviando um e-mail de teste para você…';
    try {
      const t = await api('POST', '/api/email/config/testar', {});
      estado.textContent = `Tudo certo: o e-mail de teste saiu para ${t.para}. Confira a caixa de entrada (e o spam).`;
      return true;
    } catch (e) {
      estado.textContent = e instanceof ErroApi && e.status >= 400 ? `O teste falhou: ${e.message}` : mensagemDe(e);
      return false;
    } finally { if (botao) botao.disabled = false; }
  }

  // ---------- Conectar com Google / Microsoft
  async function entrar(provedor, botao) {
    botao.disabled = true;
    try {
      const { url } = await api('POST', `/api/email/oauth/${provedor}/iniciar`, voltar ? { voltar } : {});
      location.href = url;
    } catch (e) { aviso(mensagemDe(e), 8000); botao.disabled = false; }
  }
  const botaoOAuth = (provedor) => {
    const b = h('button', { class: 'btn em-oauth', type: 'button', disabled: !oauth[provedor], onclick: () => entrar(provedor, b) },
      logo(provedor), `Entrar com ${provedor === 'google' ? 'o Google' : 'a Microsoft'}`);
    return b;
  };
  const algumDesligado = !oauth.google || !oauth.microsoft;
  const blocoConectar = h('section', { class: 'cartao em-bloco' },
    h('h2', {}, conectada ? 'Conta conectada' : 'Conectar sua conta (recomendado)'),
    conectada
      ? h('p', { class: 'em-conectada' }, logo(atual.tipo), h('span', {}, h('strong', {}, atual.conta), ` · conta ${NOMES_OAUTH[atual.tipo]}`, atual.nomeConta ? ` (${atual.nomeConta})` : ''))
      : h('p', {}, 'Entre com a sua conta e autorize o app só a enviar e-mails. Nenhuma senha fica guardada, e funciona com Gmail, Google Workspace, Outlook e Microsoft 365 (mesmo com o "SMTP autenticado" desligado).'),
    h('div', { class: 'em-alternativas' }, botaoOAuth('google'), botaoOAuth('microsoft')),
    conectada ? h('p', { class: 'suave' }, 'Para trocar de conta, entre de novo com a conta desejada.') : null,
    algumDesligado ? h('p', { class: 'suave' }, `${!oauth.google && !oauth.microsoft ? 'Os botões ainda não foram ativados' : `O botão ${!oauth.google ? 'do Google' : 'da Microsoft'} ainda não foi ativado`} neste servidor: o responsável pelo app precisa registrar o Nota Sem Stress no ${!oauth.google && !oauth.microsoft ? 'Google e na Microsoft' : !oauth.google ? 'Google' : 'Microsoft'} (passo a passo no guia "E-mail das notas"). Enquanto isso, use usuário e senha abaixo.`) : null);

  // Preferências da conta conectada (valem também para SMTP, mas lá ficam no formulário completo).
  let blocoPreferencias = null;
  if (conectada) {
    const pNome = campo({ rotulo: 'Nome que aparece para o cliente (opcional)', valor: atual.remetenteNome || '', ajuda: 'Em branco: usa o nome da empresa da nota.', atributos: { maxlength: 80 } });
    const pResponder = campo({ rotulo: 'Respostas do cliente vão para (opcional)', valor: atual.responderPara || '', ajuda: `Em branco: para ${atual.conta}.`, atributos: { type: 'email', inputmode: 'email', spellcheck: 'false' } });
    const pCopia = h('input', { type: 'checkbox', id: 'em-pref-copia', checked: atual.copiaParaMim !== false });
    const btnPref = h('button', { class: 'btn', type: 'submit' }, 'Salvar preferências');
    const btnTeste = h('button', { class: 'btn btn-primario', type: 'button', onclick: () => testar(btnTeste) }, icone(ICONES.email), 'Enviar um e-mail de teste');
    const btnDesconectar = h('button', { class: 'btn btn-perigo', type: 'button', onclick: async () => {
      if (!confirm(`Desconectar ${atual.conta}? As notas deixam de ser enviadas pelo app até você conectar de novo.`)) return;
      try { await api('DELETE', '/api/email/config'); aviso('Conta desconectada.'); ir('/conta', { substituir: true }); } catch (e) { aviso(mensagemDe(e)); }
    } }, 'Desconectar');
    blocoPreferencias = h('form', { class: 'cartao em-bloco', novalidate: true, onsubmit: async (ev) => {
      ev.preventDefault();
      btnPref.disabled = true;
      try {
        await api('PUT', '/api/email/config/preferencias', { remetenteNome: pNome.entrada.value.trim(), responderPara: pResponder.entrada.value.trim(), copiaParaMim: pCopia.checked });
        mostrarErros({ responderPara: pResponder }, {});
        aviso('Preferências salvas.');
      } catch (e) {
        if (e instanceof ErroApi && e.campos) mostrarErros({ responderPara: pResponder }, e.campos); else aviso(mensagemDe(e));
      } finally { btnPref.disabled = false; }
    } },
    h('h2', {}, 'Como o e-mail sai'),
    atual.tipo === 'microsoft' ? h('p', { class: 'suave' }, `Pela Microsoft, o nome que aparece é o da própria conta (${atual.nomeConta || atual.conta}).`) : pNome,
    pResponder,
    h('label', { class: 'caixa', for: 'em-pref-copia' }, pCopia, h('span', {}, 'Por padrão, receber uma cópia de cada nota enviada')),
    btnPref, btnTeste, estado, btnDesconectar);
  }

  // ---------- Usuário e senha (SMTP)
  const atualSmtp = atual.tipo === 'smtp' ? atual : {};
  const preset = PROVEDORES.find((p) => p.host && p.host === atualSmtp.host) || (atualSmtp.host ? PROVEDORES.at(-1) : PROVEDORES[0]);
  const dica = h('p', { class: 'cartao em-dica' });
  const cProvedor = campo({ rotulo: 'Seu e-mail é do', valor: preset.id, opcoes: PROVEDORES.map((p) => [p.id, p.nome]), onchange: () => aplicar(true) });
  const cRemetente = campo({ rotulo: 'E-mail que envia as notas', valor: atualSmtp.remetenteEmail || '', atributos: { type: 'email', inputmode: 'email', autocomplete: 'email', spellcheck: 'false', placeholder: 'voce@seudominio.com.br' },
    oninput: () => { if (!usuarioMexido) cUsuario.entrada.value = cRemetente.entrada.value.trim(); } });
  const cNome = campo({ rotulo: 'Nome que aparece para o cliente (opcional)', valor: atualSmtp.remetenteNome || '', ajuda: 'Em branco: usa o nome da empresa da nota (ex.: "Estudio Web Ltda").', atributos: { maxlength: 80, autocomplete: 'organization' } });
  let usuarioMexido = !!atualSmtp.usuario && atualSmtp.usuario !== atualSmtp.remetenteEmail;
  const cUsuario = campo({ rotulo: 'Usuário (login)', valor: atualSmtp.usuario ?? '', ajuda: 'Quase sempre é o próprio e-mail.', atributos: { autocomplete: 'username', spellcheck: 'false' },
    oninput: () => { usuarioMexido = true; } });
  const cSenha = campo({ rotulo: 'Senha (ou senha de app)', tipo: 'password', valor: '', atributos: { autocomplete: 'new-password', placeholder: atualSmtp.temSenha ? 'Guardada. Deixe em branco para manter.' : '' } });
  const cHost = campo({ rotulo: 'Servidor de saída (SMTP)', valor: atualSmtp.host || preset.host, atributos: { inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'smtp.seuprovedor.com.br' } });
  const cPorta = campo({ rotulo: 'Porta', valor: String(atualSmtp.porta || preset.porta), opcoes: [['465', '465'], ['587', '587'], ['2525', '2525'], ['25', '25']] });
  const cSeguranca = campo({ rotulo: 'Segurança', valor: atualSmtp.seguranca || preset.seguranca, opcoes: [['ssl', 'SSL/TLS (porta 465)'], ['starttls', 'STARTTLS (porta 587)']] });
  const cResponder = campo({ rotulo: 'Respostas do cliente vão para (opcional)', valor: atualSmtp.responderPara || '', ajuda: 'Em branco: para o próprio e-mail que envia.', atributos: { type: 'email', inputmode: 'email', spellcheck: 'false' } });
  const copia = h('input', { type: 'checkbox', id: 'em-cfg-copia', checked: atualSmtp.copiaParaMim !== false });
  const servidor = h('details', { class: 'em-servidor', open: preset.id === 'outro' }, h('summary', {}, 'Servidor, porta e segurança'), cHost, cPorta, cSeguranca);

  function aplicar(trocou) {
    const p = PROVEDORES.find((x) => x.id === cProvedor.entrada.value) || PROVEDORES.at(-1);
    dica.textContent = p.dica;
    if (trocou) {
      if (p.host) cHost.entrada.value = p.host;
      cPorta.entrada.value = String(p.porta);
      cSeguranca.entrada.value = p.seguranca;
      servidor.open = p.id === 'outro';
    }
  }
  aplicar(false);

  const estadoSmtp = h('p', { class: 'suave', 'aria-live': 'polite' });
  const campos = { host: cHost, porta: cPorta, seguranca: cSeguranca, usuario: cUsuario, senha: cSenha, remetenteEmail: cRemetente, remetenteNome: cNome, responderPara: cResponder };
  const corpo = () => ({ host: cHost.entrada.value.trim(), porta: Number(cPorta.entrada.value), seguranca: cSeguranca.entrada.value, usuario: cUsuario.entrada.value.trim(),
    senha: cSenha.entrada.value, remetenteEmail: cRemetente.entrada.value.trim(), remetenteNome: cNome.entrada.value.trim(), responderPara: cResponder.entrada.value.trim(), copiaParaMim: copia.checked });
  const btnSalvar = h('button', { class: 'btn btn-primario', type: 'submit' }, conectada ? 'Trocar para usuário e senha e testar' : 'Salvar e enviar um teste');
  const btnRemover = atual.tipo === 'smtp' ? h('button', { class: 'btn btn-perigo', type: 'button', onclick: async () => {
    if (!confirm('Remover a configuração de e-mail? As notas deixam de ser enviadas pelo app até você configurar de novo.')) return;
    try { await api('DELETE', '/api/email/config'); aviso('Configuração de e-mail removida.'); ir('/conta', { substituir: true }); } catch (e) { aviso(mensagemDe(e)); }
  } }, 'Remover configuração') : null;

  async function salvar(ev) {
    ev.preventDefault();
    if (conectada && !confirm(`Trocar a conta ${NOMES_OAUTH[atual.tipo]} conectada (${atual.conta}) por usuário e senha?`)) return;
    mostrarErros(campos, {});
    btnSalvar.disabled = true;
    estadoSmtp.textContent = 'Salvando…';
    try {
      await api('PUT', '/api/email/config', corpo());
      cSenha.entrada.value = '';
      cSenha.entrada.placeholder = 'Guardada. Deixe em branco para manter.';
      estadoSmtp.textContent = 'Salvo. Enviando um e-mail de teste para o próprio remetente…';
      const t = await api('POST', '/api/email/config/testar', {});
      estadoSmtp.textContent = `Tudo certo: o e-mail de teste saiu para ${t.para}. Confira a caixa de entrada (e o spam).`;
      aviso('E-mail configurado.');
      if (voltar) ir(voltar, { substituir: true });
    } catch (e) {
      if (e instanceof ErroApi && e.campos) { mostrarErros(campos, e.campos); if (e.campos.host || e.campos.porta || e.campos.seguranca) servidor.open = true; }
      estadoSmtp.textContent = e instanceof ErroApi && e.status === 502 ? `Salvo, mas o teste falhou: ${e.message}` : mensagemDe(e);
    } finally { btnSalvar.disabled = false; }
  }

  const blocoSmtp = h('details', { class: 'cartao em-bloco em-smtp', open: atual.tipo === 'smtp' || (!oauth.google && !oauth.microsoft && !conectada) },
    h('summary', {}, conectada ? 'Usar usuário e senha (SMTP) em vez da conta conectada' : 'Ou use usuário e senha (SMTP)'),
    h('form', { novalidate: true, onsubmit: salvar },
      cProvedor, dica, cRemetente, cNome, cUsuario, cSenha, servidor, cResponder,
      h('label', { class: 'caixa', for: 'em-cfg-copia' }, copia, h('span', {}, 'Por padrão, receber uma cópia de cada nota enviada')),
      h('p', { class: 'suave' }, 'A senha fica guardada cifrada no servidor e nunca volta para a tela.'),
      btnSalvar, estadoSmtp, btnRemover));

  // Resultado da conexão (volta do Google/Microsoft): conectou → manda um teste e, se veio do envio, volta para ele.
  const nomeProv = NOMES_OAUTH[query.provedor] || 'provedor';
  const resultado = query.conexao === 'ok' ? null
    : query.conexao === 'cancelada' ? h('p', { class: 'cartao cartao-alerta', role: 'status' }, `A conexão com ${nomeProv === 'Google' ? 'o Google' : 'a Microsoft'} foi cancelada. Nada mudou.`)
      : query.conexao === 'erro' ? h('p', { class: 'cartao cartao-erro', role: 'alert' }, `Não foi possível conectar a conta ${nomeProv}. ${MOTIVOS[query.motivo] || `O ${nomeProv} não confirmou a conexão. Tente de novo.`}`) : null;
  if (query.conexao === 'ok' && conectada) {
    aviso(`Conta ${NOMES_OAUTH[atual.tipo]} conectada: ${atual.conta}.`, 6000);
    testar().then((ok) => { if (ok && voltar) setTimeout(() => ir(voltar, { substituir: true }), 1500); });
  }

  const node = h('div', { class: 'form-estreito em-config' },
    h('p', {}, 'O app manda as notas aos clientes pelo seu próprio e-mail, com o PDF (DANFSe) e o XML em anexo. Configure uma vez: vale para todas as empresas da conta.'),
    resultado, blocoConectar, blocoPreferencias, blocoSmtp,
    conectada ? null : estado,
    voltar ? h('a', { class: 'btn btn-texto', href: `#${voltar}` }, 'Voltar ao envio da nota') : null);
  return { titulo: 'E-mail para enviar notas', aba: 'conta', voltar: true, node };
}
