// Cliente SMTP mínimo (sem dependências) para o e-mail de recuperação de senha.
// NOTAVEZ_SMTP_URL:
//   smtps://usuario:senha@smtp.exemplo.com:465   (TLS desde o início)
//   smtp://usuario:senha@smtp.exemplo.com:587    (STARTTLS obrigatório; nunca envia em texto puro)
// Usuário e senha podem ter caracteres especiais codificados (%40 para @).
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

const CRLF = '\r\n';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const cabecalhoUtf8 = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const enderecoValido = (e) => /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(e);

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
  };
  const aoDado = (d) => { buffer += d.toString('utf8'); entregar(); };
  const aoErro = (err) => { if (espera) { const e = espera; espera = null; e.falha(err); } };
  return {
    ligar(s) { s.on('data', aoDado); s.on('error', aoErro); s.on('close', () => aoErro(new Error('Conexão SMTP encerrada.'))); },
    desligar(s) { s.off('data', aoDado); },
    proxima: () => (respostas.length ? Promise.resolve(respostas.shift()) : new Promise((ok, falha) => { espera = { ok, falha }; })),
  };
}

export async function enviarEmailSmtp({ url, de, para, assunto, texto, timeoutMs = 20_000, ca }) {
  const u = new URL(url);
  const seguro = u.protocol === 'smtps:';
  if (!seguro && u.protocol !== 'smtp:') throw new Error('NOTAVEZ_SMTP_URL deve começar com smtps:// ou smtp://');
  if (!enderecoValido(de) || !enderecoValido(para)) throw new Error('Endereço de e-mail inválido.');
  const host = u.hostname;
  const porta = Number(u.port || (seguro ? 465 : 587));
  const usuario = decodeURIComponent(u.username || '');
  const senha = decodeURIComponent(u.password || '');

  let socket = seguro ? tls.connect({ host, port: porta, servername: host, ...(ca ? { ca } : {}) }) : net.connect({ host, port: porta });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Tempo esgotado no servidor de e-mail.')));
  let ler = leitor(socket);
  ler.ligar(socket);
  const enviar = (linha) => socket.write(linha + CRLF);
  const esperar = async (esperado, etapa) => {
    const r = await ler.proxima();
    if (!esperado.includes(r.codigo)) throw new Error(`Servidor de e-mail recusou (${etapa}: ${r.codigo}).`);
    return r;
  };
  try {
    await esperar([220], 'saudação');
    enviar(`EHLO nota-sem-stress`);
    let ehlo = await esperar([250], 'EHLO');
    if (!seguro) {
      // Sem TLS, nada de senha nem conteúdo: STARTTLS é obrigatório.
      if (!/STARTTLS/i.test(ehlo.texto)) throw new Error('O servidor de e-mail não oferece STARTTLS; use smtps://');
      enviar('STARTTLS');
      await esperar([220], 'STARTTLS');
      ler.desligar(socket);
      socket = tls.connect({ socket, servername: host, ...(ca ? { ca } : {}) });
      await new Promise((ok, falha) => { socket.once('secureConnect', ok); socket.once('error', falha); });
      ler = leitor(socket);
      ler.ligar(socket);
      enviar(`EHLO nota-sem-stress`);
      ehlo = await esperar([250], 'EHLO');
    }
    if (usuario) {
      enviar('AUTH LOGIN');
      await esperar([334], 'AUTH');
      enviar(b64(usuario));
      await esperar([334], 'AUTH usuário');
      enviar(b64(senha));
      await esperar([235], 'AUTH senha');
    }
    enviar(`MAIL FROM:<${de}>`);
    await esperar([250], 'MAIL FROM');
    enviar(`RCPT TO:<${para}>`);
    await esperar([250, 251], 'RCPT TO');
    enviar('DATA');
    await esperar([354], 'DATA');
    const corpo = b64(texto).match(/.{1,76}/g).join(CRLF);
    const mensagem = [
      `From: Nota Sem Stress <${de}>`, `To: <${para}>`, `Subject: ${cabecalhoUtf8(assunto)}`,
      `Date: ${new Date().toUTCString()}`, `Message-ID: <${randomUUID()}@nota-sem-stress>`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', corpo,
    ].join(CRLF);
    socket.write(`${mensagem}${CRLF}.${CRLF}`);
    await esperar([250], 'envio');
    enviar('QUIT');
  } finally {
    socket.end();
  }
}
