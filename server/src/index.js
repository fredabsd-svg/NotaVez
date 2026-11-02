// No próprio computador (npm run dev), os dados ficam em arquivo na pasta do usuário, com chave e
// cópias de segurança automáticas — nada some ao reiniciar. Em servidor, defina NOTAVEZ_DB e
// NOTAVEZ_MASTER_KEY; NOTAVEZ_BACKUP_PASTA liga as cópias automáticas também lá.
const { prepararDadosLocais, iniciarBackupsAutomaticos } = await import('./dados-locais.js');
const local = process.env.NOTAVEZ_DEV === '1' && !process.env.NOTAVEZ_DB && process.env.NODE_ENV !== 'test' ? prepararDadosLocais('dev') : null;
const { criarApp } = await import('./app.js');
const { config } = await import('./config.js');

const app = await criarApp();
await app.listen({ port: config.porta, host: config.host });
const pastaBackups = local?.backups || process.env.NOTAVEZ_BACKUP_PASTA;
if (pastaBackups) await iniciarBackupsAutomaticos({ banco: config.bancoArquivo, pastaBackups });
console.log(`Nota Sem Stress em http://localhost:${config.porta} — ambiente padrão: ${config.ambientePadrao}`
  + `\n  Dados: ${config.bancoArquivo}${pastaBackups ? `\n  Cópias de segurança automáticas: ${pastaBackups} (restaurar: npm run restaurar)` : ''}`);

// Verificação periódica de notas pendentes (consulta antes de reenviar).
const intervalo = setInterval(() => app.ctx.emissao.verificarPendentes().catch((e) => app.log.error(e)), 2 * 60_000);
for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, async () => { clearInterval(intervalo); await app.close(); process.exit(0); });
}
