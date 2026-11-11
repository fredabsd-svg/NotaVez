// Entrega do link de recuperação de senha. Três modos, nesta ordem:
//  1. webhook HTTPS (NOTAVEZ_RECUPERACAO_WEBHOOK + _TOKEN): um serviço de e-mail/SMS seu;
//  2. e-mail direto por SMTP (NOTAVEZ_SMTP_URL, NOTAVEZ_SMTP_DE, NOTAVEZ_URL_PUBLICA);
//  3. terminal (NOTAVEZ_RECUPERACAO=terminal, ou demonstração/desenvolvimento sem os anteriores):
//     o link aparece na janela onde o servidor roda — para uso no próprio computador.
import { enviarEmailSmtp } from './smtp.js';

export function criarEntregaRecuperacao({
  url = process.env.NOTAVEZ_RECUPERACAO_WEBHOOK, token = process.env.NOTAVEZ_RECUPERACAO_WEBHOOK_TOKEN,
  smtpUrl = process.env.NOTAVEZ_SMTP_URL, smtpDe = process.env.NOTAVEZ_SMTP_DE,
  urlPublica = process.env.NOTAVEZ_URL_PUBLICA, modo = process.env.NOTAVEZ_RECUPERACAO,
  local = process.env.NOTAVEZ_DEV === '1' || process.env.NOTAVEZ_DEMO === '1', porta = process.env.PORT || 8080,
  fetchImpl = globalThis.fetch, enviarEmail = enviarEmailSmtp, escrever = (t) => process.stdout.write(t),
} = {}) {
  if (url) {
    const destino = new URL(url);
    if (destino.protocol !== 'https:' || destino.username || destino.password || destino.hash || !token) throw new Error('Recuperação exige webhook HTTPS e token de autenticação.');
    const entregar = async ({ email, token: recuperacaoToken, expiraEm }) => {
      const r = await fetchImpl(destino.href, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email, token: recuperacaoToken, expiraEm }),
      });
      // Não incluir URL, corpo ou token em exceções/logs.
      if (!r.ok) throw new Error('Entrega de recuperação indisponível.');
      await r.body?.cancel();
    };
    entregar.modo = 'email';
    return entregar;
  }
  const link = (base, t) => `${String(base).replace(/\/+$/, '')}/recuperar-conta.html#token=${t}`;
  if (smtpUrl) {
    if (!smtpDe || !urlPublica) throw new Error('E-mail de recuperação por SMTP exige NOTAVEZ_SMTP_DE e NOTAVEZ_URL_PUBLICA (endereço https do app).');
    if (new URL(urlPublica).protocol !== 'https:') throw new Error('NOTAVEZ_URL_PUBLICA precisa ser https.');
    const entregar = async ({ email, token: t, expiraEm }) => {
      const validade = new Date(expiraEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
      await enviarEmail({
        url: smtpUrl, de: smtpDe, para: email, assunto: 'Nota Sem Stress: redefinir sua senha',
        texto: `Olá!\n\nRecebemos um pedido para redefinir a senha do Nota Sem Stress.\n\nAbra o link abaixo para criar uma nova senha (vale até ${validade}, uma única vez):\n${link(urlPublica, t)}\n\nSe não foi você, ignore este e-mail: sua senha continua a mesma.\n`,
      });
    };
    entregar.modo = 'email';
    return entregar;
  }
  if (modo === 'terminal' || local) {
    const base = urlPublica || `http://localhost:${porta}`;
    const entregar = async ({ email, token: t, expiraEm }) => {
      const conta = email && !email.endsWith('.invalid') ? email : 'conta sem e-mail';
      escrever(`\n  Recuperação de senha (${conta}) — abra no navegador até ${new Date(expiraEm).toLocaleTimeString('pt-BR')}:\n  ${link(base, t)}\n\n`);
    };
    entregar.modo = 'terminal';
    return entregar;
  }
  return undefined;
}
