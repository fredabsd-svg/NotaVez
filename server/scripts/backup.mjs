import { DatabaseSync, backup } from 'node:sqlite';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export async function criarBackup(origem, destino) {
  const fonte = resolve(origem);
  const pasta = resolve(destino);
  // Uma pasta nova por execução evita sobrescrever o único backup anterior.
  await mkdir(pasta, { mode: 0o700 });
  const banco = new DatabaseSync(fonte, { readOnly: true });
  const arquivo = join(pasta, 'notavez.db');
  try {
    await backup(banco, arquivo);
  } finally { banco.close(); }
  await chmod(arquivo, 0o600);
  const check = new DatabaseSync(arquivo, { readOnly: true });
  try {
    const resultado = check.prepare('PRAGMA integrity_check').all();
    if (resultado.length !== 1 || resultado[0].integrity_check !== 'ok') throw new Error('Backup reprovado na verificação de integridade.');
  } finally { check.close(); }
  const bytes = await readFile(arquivo);
  const manifesto = { formato: 1, criadoEm: new Date().toISOString(), arquivo: 'notavez.db', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), chaveIncluida: false };
  await writeFile(join(pasta, 'manifesto.json'), JSON.stringify(manifesto, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return manifesto;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [origem, destino] = process.argv.slice(2);
  if (!origem || !destino) {
    console.error('Uso: node scripts/backup.mjs /dados/notavez.db /backups/nova-pasta');
    process.exitCode = 1;
  } else {
    try { const r = await criarBackup(origem, destino); console.log(`Backup íntegro: ${r.bytes} bytes. Guarde a chave mestra separadamente.`); }
    catch { console.error('Backup não concluído. Confira origem, permissões e se a pasta de destino é nova.'); process.exitCode = 1; }
  }
}
