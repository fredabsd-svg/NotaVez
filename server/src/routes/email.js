// E-mail das notas: configuração do envio (por conta) e envio de uma nota emitida ao cliente.
import { exigirPrestador } from './perfil.js';

export async function rotasEmail(app) {
  const { email, limites } = app.ctx;

  app.get('/email/config', async (req) => ({ config: await email.configPublica(req.usuario.id) }));
  app.put('/email/config', async (req) => ({ config: await email.salvarConfig(req.usuario.id, req.body || {}, req.ip) }));
  app.delete('/email/config', async (req) => ({ config: await email.removerConfig(req.usuario.id, req.ip) }));
  app.post('/email/config/testar', async (req) => {
    await limites.consumir(`email-teste:${req.usuario.id}`, 10, 10 * 60_000);
    return await email.testar(req.usuario.id, req.ip);
  });

  // Destinatários do cadastro, anexos, remetente e envios anteriores (sem IA: abre a tela na hora).
  app.get('/notas/:id/email', async (req) => await email.preparar(req.usuario.id, exigirPrestador(req), req.params.id));
  // Assunto e mensagem escritos pela IA da conta (ou pelo modelo simples).
  app.post('/notas/:id/email/texto', async (req) => {
    await limites.consumir(`email-texto:${req.usuario.id}`, 60, 3600_000);
    return await email.texto(req.usuario.id, exigirPrestador(req), req.params.id, req.body || {});
  });
  app.post('/notas/:id/email', async (req) => {
    // Teto por hora: o e-mail sai pelo servidor da própria conta, mas um envio em massa por engano não deve passar.
    await limites.consumir(`email-envio:${req.usuario.id}`, 120, 3600_000);
    return await email.enviarNota(req.usuario.id, exigirPrestador(req), req.params.id, req.body || {}, req.ip);
  });
}
