// Restaurar uma cópia de segurança do uso local (npm run demo / npm run dev).
//   npm run restaurar                       → lista as cópias disponíveis
//   npm run restaurar -- demo <cópia>       → volta o banco da demonstração para aquela cópia
//   npm run restaurar -- dev <cópia>
// O app precisa estar FECHADO. O banco atual não é apagado: fica guardado como ".antes-da-restauracao".
import { existsSync, readdirSync, readFileSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pastaDadosLocais } from '../src/dados-locais.js';

const [modo, copia] = process.argv.slice(2);
const modos = modo ? [modo] : ['demo', 'dev'];
const listar = (m) => { const p = join(pastaDadosLocais(m), 'backups'); return existsSync(p) ? readdirSync(p).filter((n) => existsSync(join(p, n, 'manifesto.json'))).sort() : []; };

if (!copia) {
  for (const m of modos) {
    const lista = listar(m);
    console.log(`\n${m}: ${pastaDadosLocais(m)}`);
    if (!lista.length) console.log('  (nenhuma cópia ainda)');
    for (const n of lista.slice(-15)) {
      const man = JSON.parse(readFileSync(join(pastaDadosLocais(m), 'backups', n, 'manifesto.json'), 'utf8'));
      console.log(`  ${n}   ${new Date(man.criadoEm).toLocaleString('pt-BR')}   ${Math.round(man.bytes / 1024)} KB`);
    }
  }
  console.log('\nPara restaurar: feche o app e rode  npm run restaurar -- <demo|dev> <nome da cópia>\n');
  process.exit(0);
}

if (!['demo', 'dev'].includes(modo)) { console.error('Use demo ou dev. Ex.: npm run restaurar -- demo 2026-11-02-15-30-00'); process.exit(1); }
const pasta = pastaDadosLocais(modo);
const origem = join(pasta, 'backups', copia);
const banco = join(pasta, `notavez-${modo}.db`);
if (!existsSync(join(origem, 'manifesto.json'))) { console.error(`Cópia não encontrada: ${origem}\nRode "npm run restaurar" para ver a lista.`); process.exit(1); }

// App aberto usando o banco: restaurar por baixo dele corromperia os dados.
const porta = process.env.PORT || 8080;
const aberto = await fetch(`http://127.0.0.1:${porta}/api/saude`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
if (aberto) { console.error(`O app está aberto (porta ${porta}). Feche a janela do npm run ${modo} (Ctrl+C) e rode de novo.`); process.exit(1); }

const manifesto = JSON.parse(readFileSync(join(origem, 'manifesto.json'), 'utf8'));
const bytes = readFileSync(join(origem, manifesto.arquivo));
if (createHash('sha256').update(bytes).digest('hex') !== manifesto.sha256) { console.error('A cópia está danificada (conferência SHA-256 falhou). Escolha outra.'); process.exit(1); }
const teste = new DatabaseSync(join(origem, manifesto.arquivo), { readOnly: true });
const ok = teste.prepare('PRAGMA integrity_check').all()[0]?.integrity_check === 'ok';
teste.close();
if (!ok) { console.error('A cópia não passou na verificação de integridade. Escolha outra.'); process.exit(1); }

const guardado = `${banco}.antes-da-restauracao-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
if (existsSync(banco)) {
  // Grava no arquivo principal o que ainda está no diário (WAL), para a cópia guardada sair completa.
  const atual = new DatabaseSync(banco);
  try { atual.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { atual.close(); }
  renameSync(banco, guardado);
}
for (const extra of ['-wal', '-shm']) rmSync(`${banco}${extra}`, { force: true });
copyFileSync(join(origem, manifesto.arquivo), banco);
console.log(`Restaurado: ${copia} (${new Date(manifesto.criadoEm).toLocaleString('pt-BR')}).`);
if (existsSync(guardado)) console.log(`O banco anterior foi guardado em: ${guardado}`);
console.log(`Agora abra o app de novo: npm run ${modo}`);
