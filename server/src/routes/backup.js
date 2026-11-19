// Backup e restauração da conta (Conta › Backup e Restauração). Tudo exige sessão e só enxerga a própria conta.
// Arquivos grandes andam em partes de ~1,9 MB (o limite da Vercel é 4,5 MB por requisição).
import { criarServicoBackup } from '../backup/servico.js';

export async function rotasBackup(app, { sondasBackup } = {}) {
  const { db, limites, emissao } = app.ctx;
  const backup = criarServicoBackup({ db, emissao }, { sondas: sondasBackup || {} });
  const u = (req) => req.usuario.id;

  app.get('/', async (req) => await backup.listar(u(req)));

  // Senha só no corpo (nunca na URL); o logger do servidor não registra corpos.
  app.post('/', async (req) => {
    await limites.consumir(`backup-criar:${u(req)}`, 10, 3600_000);
    return await backup.criar(u(req), req.body?.senha, req.ip);
  });

  app.get('/:id/partes/:n', async (req, reply) => {
    await limites.consumir(`backup-partes:${u(req)}`, 3000, 3600_000);
    const texto = await backup.parte(u(req), req.params.id, req.params.n);
    return reply.header('Content-Type', 'application/octet-stream').header('Cache-Control', 'no-store').send(texto);
  });

  app.post('/:id/baixado', async (req) => ({ backup: await backup.marcarBaixado(u(req), req.params.id, req.body?.sha256, req.ip) }));

  app.post('/envios', async (req) => {
    await limites.consumir(`backup-envio:${u(req)}`, 30, 3600_000);
    return { backup: await backup.iniciarEnvio(u(req), req.body || {}) };
  });

  app.put('/:id/partes/:n', { bodyLimit: 2_600_000 }, async (req) => {
    await limites.consumir(`backup-partes:${u(req)}`, 3000, 3600_000);
    return await backup.receberParte(u(req), req.params.id, req.params.n, req.body?.dados);
  });

  // Conferir e restaurar derivam a chave da senha (scrypt): teto por conta contra tentativa de adivinhar a senha.
  app.post('/:id/conferir', async (req) => {
    await limites.consumir(`backup-senha:${u(req)}`, 30, 3600_000);
    return await backup.conferir(u(req), req.params.id, req.body?.senha);
  });

  app.post('/:id/restaurar', async (req) => {
    await limites.consumir(`backup-senha:${u(req)}`, 30, 3600_000);
    return await backup.restaurar(u(req), req.params.id, req.body?.senha, req.body?.confirmacao, req.ip);
  });

  app.delete('/:id', async (req) => await backup.excluir(u(req), req.params.id));
}
