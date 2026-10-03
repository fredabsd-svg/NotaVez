import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Um processo por arquivo mantém NODE_ENV/config/SQLite isolados e imprime
// os casos reais, inclusive em runtimes cujo --test encapsula a saída WASM.
const raiz = fileURLToPath(new URL('../', import.meta.url));
const arquivos = readdirSync(new URL('../test/', import.meta.url)).filter((f) => f.endsWith('.test.js')).sort();
for (const arquivo of arquivos) {
  console.log(`\nTestes: ${arquivo}`);
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', `test/${arquivo}`], { cwd: raiz, stdio: 'inherit', timeout: 120_000 });
  if (r.error || r.status !== 0) {
    console.error(`Falha em ${arquivo}${r.error ? `: ${r.error.message}` : ''}`);
    process.exit(1);
  }
}
console.log(`\n${arquivos.length} arquivos de teste concluídos.`);
