// Cliente SMTP mínimo (sem dependências): recuperação de senha e envio das notas ao cliente.
//
// Recuperação de senha (configuração do servidor), NOTAVEZ_SMTP_URL:
//   smtps://usuario:senha@smtp.exemplo.com:465   (TLS desde o início)
//   smtp://usuario:senha@smtp.exemplo.com:587    (STARTTLS obrigatório; nunca envia em texto puro)
// Usuário e senha podem ter caracteres especiais codificados (%40 para @).
//
// Envio de notas (configuração de cada conta): enviarEmail({ host, porta, seguranca: 'ssl' | 'starttls', ... }).
// O servidor de e-mail é informado pelo usuário: antes de conectar, o nome é resolvido e endereços internos
// (rede local, nuvem, loopback) são recusados; a conexão vai ao IP conferido, com o certificado TLS validado
// pelo nome do servidor.
import net from 'node:net';
import tls from 'node:tls';
import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';

const CRLF = '\r\n';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const linhas76 = (base64) => (base64.match(/.{1,76}/g) || ['']).join(CRLF);
export const enderecoValido = (e) => typeof e === 'string' && e.length <= 254 && /^[^@\s<>"(),;:\\[\]]+@[^@\s<>"(),;:\\[\]]+\.[^@\s<>"(),;:\\[\]]+$/.test(e);
export const PORTAS_SMTP = [25, 465, 587, 2525];

// Cabeçalho com acentos: palavras codificadas (RFC 2047) de até 75 caracteres, dobradas em linhas.
export function cabecalhoUtf8(s) {
  const t = String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(t)) return t;
  const partes = [];
  let atual = '';
  for (const ch of t) {
    if (Buffer.byteLength(atual + ch, 'utf8') > 45) { partes.push(atual); atual = ''; }
    atual += ch;
  }
  if (atual) partes.push(atual);
  return partes.map((p) => `=?UTF-8?B?${b64(p)}?=`).join(`${CRLF} `);
}

const nomeEndereco = (nome, email) => (nome ? `${/^[\w .-]*$/.test(nome) ? `"${nome}"` : cabecalhoUtf8(nome)} <${email}>` : `<${email}>`);
const nomeArquivo = (n) => String(n || 'anexo').replace(/[^\w.-]+/g, '_').slice(0, 120);

// Mensagem MIME: texto simples; com anexos, multipart/mixed. Só base64 no corpo (nenhuma linha começa com ".").
export function montarMensagem({ de, nomeRemetente = '', para, cc = [], responderPara = '', assunto, texto, anexos = [], agora = new Date() }) {
  const dominio = de.split('@')[1] || 'nota-sem-stress';
  const cab = [
    `From: ${nomeEndereco(nomeRemetente, de)}`,
    `To: ${para.map((e) => `<${e}>`).join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.map((e) => `<${e}>`).join(', ')}`] : []),
    ...(responderPara ? [`Reply-To: <${responderPara}>`] : []),
    `Subject: ${cabecalhoUtf8(assunto)}`,
    `Date: ${agora.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomUUID()}@${dominio}>`,
    'MIME-Version: 1.0',
  ];
  const textoNormalizado = String(texto ?? '').replace(/\r?\n/g, CRLF);
  const parteTexto = ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', linhas76(b64(textoNormalizado))];
  if (!anexos.length) return [...cab, ...parteTexto].join(CRLF);
  const fronteira = `=_nss_${randomUUID().replace(/-/g, '')}`;
  const corpo = [`--${fronteira}`, ...parteTexto];
  for (const a of anexos) {
    const nome = nomeArquivo(a.nome);
    corpo.push(`--${fronteira}`, `Content-Type: ${a.tipo || 'application/octet-stream'}; name="${nome}"`,
      `Content-Disposition: attachment; filename="${nome}"`, 'Content-Transfer-Encoding: base64', '',
      linhas76(Buffer.from(a.conteudo).toString('base64')));
  }
  corpo.push(`--${fronteira}--`, '');
  return [...cab, `Content-Type: multipart/mixed; boundary="${fronteira}"`, '', 'This is a multi-part message in MIME format.', ...corpo].join(CRLF);
}

// Endereços que um servidor de e-mail da internet não usa (rede interna, nuvem, loopback, reservados).
// Listas separadas: numa lista só, a regra ::ffff:0:0/96 (IPv4 mapeado) pegaria todo endereço IPv4.
const V4 = new net.BlockList();
const V6 = new net.BlockList();
for (const [rede, prefixo] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) {
  V4.addSubnet(rede, prefixo, 'ipv4');
}
for (const [rede, prefixo] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  V6.addSubnet(rede, prefixo, 'ipv6');
}
export function enderecoInterno(ip) {
  if (net.isIPv4(ip)) return V4.check(ip, 'ipv4');
  const mapeado = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapeado) return V4.check(mapeado[1], 'ipv4');
  return !net.isIPv6(ip) || V6.check(ip, 'ipv6');
}

export class ErroSmtp extends Error {
  constructor(mensagem, { codigo = null, etapa = null, resposta = '' } = {}) {
    super(mensagem);
    this.codigo = codigo; this.etapa = etapa; this.resposta = resposta;
  }
}

// Resolve o servidor e confere que é da internet (a não ser em testes e no computador do próprio usuário).
export async function resolverServidor(host, { permitirRedeLocal = false, resolver = lookup } = {}) {
  const nome = String(host || '').trim().toLowerCase();
  if (!nome || nome.length > 253 || !/^[a-z0-9.-]+$|^[0-9a-f:]+$/i.test(nome)) throw new ErroSmtp('Servidor de e-mail inválido.', { etapa: 'endereco' });
  const enderecos = net.isIP(nome) ? [{ address: nome, family: net.isIP(nome) }] : await resolver(nome, { all: true, verbatim: true }).catch(() => {
    throw new ErroSmtp(`Não encontrei o servidor de e-mail "${nome}". Confira o endereço.`, { etapa: 'endereco' });
  });
  if (!enderecos.length) throw new ErroSmtp(`Não encontrei o servidor de e-mail "${nome}".`, { etapa: 'endereco' });
  if (!permitirRedeLocal && enderecos.some((e) => enderecoInterno(e.address))) {
    throw new ErroSmtp('Esse servidor de e-mail aponta para um endereço interno e não pode ser usado.', { etapa: 'endereco' });
  }
  // IPv4 primeiro: muitos servidores (a Vercel inclusive) não têm saída IPv6, e o DNS pode listar o IPv6 antes.
  const ips = [...enderecos].sort((a, b) => (net.isIPv4(b.address) ? 1 : 0) - (net.isIPv4(a.address) ? 1 : 0)).map((e) => e.address);
  return { nome, ip: ips[0], ips };
}

// Erro de rede ou de TLS → mensagem em linguagem comum.
const ERROS_DE_REDE = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EADDRNOTAVAIL'];
function erroConexao(e) {
  if (e instanceof ErroSmtp) return e;
  const msg = e?.message || '';
  return new ErroSmtp(ERROS_DE_REDE.includes(e?.code) ? 'Não consegui conectar ao servidor de e-mail. Confira o servidor e a porta.'
    : /certificate|self.signed|altnames/i.test(msg) ? 'O certificado de segurança do servidor de e-mail não confere com o endereço informado.'
      : /wrong version|packet length|ssl3|tls/i.test(msg) ? 'A segurança escolhida não combina com a porta: use SSL/TLS na porta 465 e STARTTLS na 587.'
        : 'A conexão com o servidor de e-mail falhou.', { etapa: 'conexao' });
}

// Abre a conexão tentando cada endereço conferido, na ordem (rede fora do ar num endereço → o próximo).
// Erro de TLS (certificado, segurança trocada) não muda de um endereço para outro: para na hora.
async function conectar(ips, porta, seguro, opcoesTls, limiteMs) {
  let ultimo = null;
  for (const ip of ips.slice(0, 4)) {
    try {
      return await new Promise((ok, falha) => {
        const s = seguro ? tls.connect({ host: ip, port: porta, ...opcoesTls }) : net.connect({ host: ip, port: porta });
        const relogio = setTimeout(() => { s.destroy(); falha(Object.assign(new Error('tempo esgotado ao conectar'), { code: 'ETIMEDOUT' })); }, limiteMs);
        s.once(seguro ? 'secureConnect' : 'connect', () => { clearTimeout(relogio); s.removeListener('error', falha); ok(s); });
        s.once('error', (e) => { clearTimeout(relogio); falha(e); });
      });
    } catch (e) {
      ultimo = e;
      if (!ERROS_DE_REDE.includes(e?.code)) break;
    }
  }
  throw erroConexao(ultimo);
}

function leitor(socket) {
  let buffer = '';
  let espera = null;
  const respostas = [];
  const entregar = () => {
    // Resposta completa: última linha no formato "NNN texto" (sem hífen).
    for (;;) {
      const linhas = buffer.split(CRLF);
      const fim = linhas.findIndex((l) => /^\d{3} /.test(l) || /^\d{3}$/.test(l));
      if (fim < 0 || fim >= linhas.length - 1) return;
      const bloco = linhas.slice(0, fim + 1);
      buffer = linhas.slice(fim + 1).join(CRLF);
      respostas.push({ codigo: Number(bloco[fim].slice(0, 3)), texto: bloco.join('\n') });
      if (espera) { const e = espera; espera = null; e.ok(respostas.shift()); }
    }
    if (buffer.length > 64_000) aoErro(new ErroSmtp('Resposta inválida do servidor de e-mail.'));
  };
  const aoDado = (d) => { buffer += d.toString('utf8'); entregar(); };
  function aoErro(err) { if (espera) { const e = espera; espera = null; e.falha(err); } }
  return {
    ligar(s) { s.on('data', aoDado); s.on('error', aoErro); s.on('close', () => aoErro(new ErroSmtp('O servidor de e-mail encerrou a conexão.'))); },
    desligar(s) { s.off('data', aoDado); },
    proxima: () => (respostas.length ? Promise.resolve(respostas.shift()) : new Promise((ok, falha) => { espera = { ok, falha }; })),
  };
}

// Resposta do servidor numa linha curta (sem o código), para a mensagem de erro.
const resumoResposta = (texto) => String(texto || '').split('\n').map((l) => l.replace(/^\d{3}[ -](\d\.\d\.\d+ )?/, '').trim()).filter(Boolean).join(' ').slice(0, 200);

function erroDaEtapa(etapa, r, extra = {}) {
  const detalhe = resumoResposta(r.texto);
  const mensagens = {
    autenticacao: 'O servidor de e-mail recusou o usuário ou a senha. No Gmail e no Outlook use uma "senha de app" (não a senha normal da conta).',
    remetente: 'O servidor de e-mail recusou o remetente. Use como remetente o mesmo e-mail da conta configurada.',
    destinatario: `O servidor de e-mail recusou o destinatário ${extra.destinatario || ''}. Confira o endereço.`.replace('  ', ' '),
    envio: 'O servidor de e-mail recusou a mensagem.',
  };
  return new ErroSmtp(`${mensagens[etapa] || `O servidor de e-mail recusou (${etapa}).`}${detalhe ? ` Resposta do servidor: ${detalhe}` : ''}`, { codigo: r.codigo, etapa, resposta: detalhe });
}

// Envia uma mensagem. para/cc/cco: listas de e-mails; anexos: [{ nome, tipo, conteudo: Buffer }].
export async function enviarEmail({
  host, porta, seguranca = 'ssl', usuario = '', senha = '', de, nomeRemetente = '', para, cc = [], cco = [], responderPara = '',
  assunto, texto, anexos = [], timeoutMs = 25_000, ca, permitirRedeLocal = false, resolver,
}) {
  const lista = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  para = lista(para); cc = lista(cc); cco = lista(cco);
  if (!['ssl', 'starttls'].includes(seguranca)) throw new ErroSmtp('Escolha a segurança da conexão (SSL/TLS ou STARTTLS).');
  if (![de, ...para, ...cc, ...cco, ...(responderPara ? [responderPara] : [])].every(enderecoValido)) throw new ErroSmtp('Endereço de e-mail inválido.');
  if (!para.length) throw new ErroSmtp('Informe ao menos um destinatário.');
  const p = Number(porta);
  if (!Number.isInteger(p) || p < 1 || p > 65535 || (!permitirRedeLocal && !PORTAS_SMTP.includes(p))) throw new ErroSmtp(`Porta de e-mail não aceita. Use ${PORTAS_SMTP.join(', ')}.`);
  const destino = await resolverServidor(host, { permitirRedeLocal, ...(resolver ? { resolver } : {}) });
  const opcoesTls = { servername: net.isIP(destino.nome) ? undefined : destino.nome, ...(ca ? { ca } : {}),
    // O certificado é conferido pelo NOME do servidor (a conexão vai ao IP já conferido).
    checkServerIdentity: (_h, cert) => tls.checkServerIdentity(destino.nome, cert) };

  const seguro = seguranca === 'ssl';
  let socket = await conectar(destino.ips, p, seguro, opcoesTls, Math.min(timeoutMs, 10_000));
  const tempo = () => socket.destroy(new ErroSmtp('O servidor de e-mail não respondeu a tempo. Confira o servidor, a porta e a segurança (SSL/TLS ou STARTTLS).', { etapa: 'conexao' }));
  // Saudação em até 10 s: STARTTLS numa porta SSL (ou o contrário) fica muda; melhor avisar logo.
  socket.setTimeout(Math.min(timeoutMs, 10_000), tempo);
  let ler = leitor(socket);
  ler.ligar(socket);
  socket.once('error', () => {});
  const enviar = (linha) => socket.write(linha + CRLF);
  const esperar = async (esperado, etapa, extra) => {
    let r;
    try { r = await ler.proxima(); } catch (e) { throw erroConexao(e); }
    if (!esperado.includes(r.codigo)) throw erroDaEtapa(etapa, r, extra);
    return r;
  };
  try {
    await esperar([220], 'saudação');
    socket.setTimeout(timeoutMs, tempo);
    enviar('EHLO nota-sem-stress');
    let ehlo = await esperar([250], 'EHLO');
    if (!seguro) {
      // Sem TLS, nada de senha nem conteúdo: STARTTLS é obrigatório.
      if (!/STARTTLS/i.test(ehlo.texto)) throw new ErroSmtp('O servidor de e-mail não oferece STARTTLS nessa porta. Use SSL/TLS (porta 465).', { etapa: 'starttls' });
      enviar('STARTTLS');
      await esperar([220], 'STARTTLS');
      ler.desligar(socket);
      socket.setTimeout(0);
      socket = tls.connect({ socket, ...opcoesTls });
      socket.setTimeout(timeoutMs, tempo);
      socket.once('error', () => {});
      ler = leitor(socket);
      ler.ligar(socket);
      await new Promise((ok, falha) => { socket.once('secureConnect', ok); socket.once('error', falha); }).catch((e) => {
        throw new ErroSmtp(/certificate|altnames|self.signed/i.test(e?.message || '') ? 'O certificado de segurança do servidor de e-mail não confere com o endereço informado.' : 'Falha ao proteger a conexão (STARTTLS).', { etapa: 'starttls' });
      });
      enviar('EHLO nota-sem-stress');
      ehlo = await esperar([250], 'EHLO');
    }
    if (usuario) {
      const auth = (/^250[ -]AUTH[ =](.*)$/im.exec(ehlo.texto)?.[1] || '').toUpperCase().split(/\s+/);
      if (auth.includes('LOGIN') || !auth.includes('PLAIN')) {
        enviar('AUTH LOGIN');
        await esperar([334], 'autenticacao');
        enviar(b64(usuario));
        await esperar([334], 'autenticacao');
        enviar(b64(senha));
        await esperar([235], 'autenticacao');
      } else {
        enviar(`AUTH PLAIN ${b64(`\0${usuario}\0${senha}`)}`);
        await esperar([235], 'autenticacao');
      }
    }
    enviar(`MAIL FROM:<${de}>`);
    await esperar([250], 'remetente');
    for (const d of [...new Set([...para, ...cc, ...cco].map((e) => e.toLowerCase()))]) {
      enviar(`RCPT TO:<${d}>`);
      await esperar([250, 251], 'destinatario', { destinatario: d });
    }
    enviar('DATA');
    await esperar([354], 'envio');
    const mensagem = montarMensagem({ de, nomeRemetente, para, cc, responderPara, assunto, texto, anexos });
    socket.write(`${mensagem.replace(/^\./gm, '..')}${CRLF}.${CRLF}`);
    const r = await esperar([250], 'envio');
    enviar('QUIT');
    return { aceito: true, resposta: resumoResposta(r.texto) };
  } finally {
    socket.end();
  }
}

// Recuperação de senha: configuração do servidor numa URL smtps:// ou smtp://.
export async function enviarEmailSmtp({ url, de, para, assunto, texto, timeoutMs = 20_000, ca }) {
  const u = new URL(url);
  const seguro = u.protocol === 'smtps:';
  if (!seguro && u.protocol !== 'smtp:') throw new Error('NOTAVEZ_SMTP_URL deve começar com smtps:// ou smtp://');
  return await enviarEmail({
    host: u.hostname.replace(/^\[|\]$/g, ''), porta: Number(u.port || (seguro ? 465 : 587)), seguranca: seguro ? 'ssl' : 'starttls',
    usuario: decodeURIComponent(u.username || ''), senha: decodeURIComponent(u.password || ''), de, nomeRemetente: 'Nota Sem Stress', para: [para],
    assunto, texto, timeoutMs, ca,
    // Configuração do próprio servidor (não do usuário): pode ser um relay interno.
    permitirRedeLocal: true,
  });
}
