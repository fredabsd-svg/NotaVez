import { criarApp } from './app.js';
import { config } from './config.js';

const app = await criarApp();
await app.listen({ port: config.porta, host: config.host });
console.log(`NotaVez em http://localhost:${config.porta} — ambiente padrão: ${config.ambientePadrao}${config.dev ? ' (desenvolvimento: dados em memória)' : ''}`);

// Verificação periódica de notas pendentes (consulta antes de reenviar).
const intervalo = setInterval(() => app.ctx.emissao.verificarPendentes().catch((e) => app.log.error(e)), 2 * 60_000);
for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, async () => { clearInterval(intervalo); await app.close(); process.exit(0); });
}
