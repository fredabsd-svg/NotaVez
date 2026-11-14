// Assistente de IA: configuração do provedor, conversas e confirmação de emissão.
import { PROVEDORES, provedorPublico } from '../ia/provedores.js';
import { criarServicoIa } from '../ia/servico.js';

export async function rotasIa(app, { chamarIa, listarModelosIa } = {}) {
  const { limites } = app.ctx;
  const ia = criarServicoIa(app.ctx, { ...(chamarIa ? { chamar: chamarIa } : {}), ...(listarModelosIa ? { listar: listarModelosIa } : {}), log: app.log });

  app.get('/provedores', async () => ({ provedores: Object.entries(PROVEDORES).map(([id, p]) => provedorPublico(id, p)) }));

  app.get('/config', async (req) => ({ config: await ia.configPublica(req.usuario.id) }));
  app.put('/config', async (req) => ({ config: await ia.salvarConfig(req.usuario.id, req.body || {}, req.ip) }));
  app.delete('/config', async (req) => { await ia.removerConfig(req.usuario.id, req.ip); return { config: await ia.configPublica(req.usuario.id) }; });
  // Lista os modelos do provedor com a chave informada (ou a guardada). POST: a chave vai no corpo, nunca na URL.
  app.post('/modelos', async (req) => {
    await limites.consumir(`ia-modelos:${req.usuario.id}`, 30, 10 * 60_000);
    return await ia.modelosDisponiveis(req.usuario.id, req.body || {});
  });
  app.put('/config/modelo', async (req) => ({ config: await ia.trocarModelo(req.usuario.id, req.body?.modelo, req.ip) }));
  app.post('/config/testar', async (req) => {
    await limites.consumir(`ia-teste:${req.usuario.id}`, 10, 10 * 60_000);
    return await ia.testarConfig(req.usuario.id);
  });

  // Revisão, pela IA da conta, das empresas preparadas no cadastro em lote (antes de salvar).
  app.post('/revisar-empresas', { bodyLimit: 2_000_000 }, async (req) => {
    await limites.consumir(`ia-lote:${req.usuario.id}`, 60, 3600_000);
    return await ia.revisarEmpresas(req.usuario.id, req.body?.empresas);
  });

  app.get('/conversas', async (req) => ({ conversas: await ia.listarConversas(req.usuario.id) }));
  app.post('/conversas', async (req) => ({ conversa: await ia.conversa(req.usuario.id, await ia.criarConversa(req.usuario.id, req.prestador?.id)) }));
  app.get('/conversas/:id', async (req) => ({ conversa: await ia.conversa(req.usuario.id, req.params.id) }));
  app.delete('/conversas/:id', async (req) => ({ ok: await ia.removerConversa(req.usuario.id, req.params.id) }));

  // Corpo maior que o padrão (1 MB): a mensagem pode trazer até 3 MB de arquivos em base64.
  app.post('/conversas/:id/mensagens', { bodyLimit: 4_400_000 }, async (req) => {
    // Cada mensagem pode virar várias chamadas pagas ao provedor: teto por hora, por conta.
    await limites.consumir(`ia:${req.usuario.id}`, 200, 3600_000);
    return await ia.enviarMensagem({ usuario: req.usuario, empresa: req.prestador, conversaId: req.params.id, texto: req.body?.texto, anexos: req.body?.anexos, ip: req.ip });
  });

  app.post('/conversas/:id/emissao', async (req) => await ia.decidirEmissao({
    usuario: req.usuario, conversaId: req.params.id, notaId: req.body?.notaId, emitir: req.body?.emitir === true, ip: req.ip, limites,
  }));
}
