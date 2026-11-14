// Aplica o esquema do banco (idempotente) no Postgres de DATABASE_URL. Roda no build da Vercel.
// Pré-visualizações podem estar ligadas ao mesmo banco da produção: só o deploy de produção (ou um build
// fora da Vercel) migra. Com um banco separado para Preview, NOTAVEZ_MIGRAR_PREVIEW=1 (só em Preview) libera.
import { migrar } from '../src/db/banco.js';

if (process.env.VERCEL && process.env.VERCEL_ENV !== 'production' && process.env.NOTAVEZ_MIGRAR_PREVIEW !== '1') {
  console.log('[migrar] pré-visualização: esquema não aplicado.');
} else if (!process.env.DATABASE_URL) {
  console.log('[migrar] DATABASE_URL não definida: nada a fazer (sem banco, o app usa o Postgres embutido).');
} else {
  try {
    await migrar();
    console.log('[migrar] esquema do banco conferido e atualizado.');
  } catch (e) {
    console.error(`[migrar] falhou: ${e?.message || e}`);
    process.exitCode = 1;
  }
}
