// Backup consistente do catálogo central e do banco de cada conta.
// Cada arquivo é copiado pela API de backup do SQLite (captura o WAL), conferido
// com integrity_check e registrado no manifesto com SHA-256. A chave mestra NÃO
// entra no backup: guarde-a separadamente (cofre/KMS). Sem ela, nada abre.
import { DatabaseSync, backup } from 'node:sqlite';
import { chmod, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const UUID_DB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db$/;

async function copiar(origem, destino) {
  const banco = new DatabaseSync(origem, { readOnly: true });
  try { await backup(banco, destino); } finally { banco.close(); }
  await chmod(destino, 0o600);
  const check = new DatabaseSync(destino, { readOnly: true });
  try {
    const resultado = check.prepare('PRAGMA integrity_check').all();
    if (resultado.length !== 1 || resultado[0].integrity_check !== 'ok') throw new Error('Backup reprovado na verificação de integridade.');
  } finally { check.close(); }
  const bytes = await readFile(destino);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function criarBackup(origem, destino, { pastaContas = process.env.NOTAVEZ_CONTAS_DIR || join(dirname(resolve(origem)), 'contas') } = {}) {
  const fonte = resolve(origem);
  const pasta = resolve(destino);
  // Uma pasta nova por execução evita sobrescrever o único backup anterior.
  await mkdir(pasta, { mode: 0o700 });
  const arquivos = [{ arquivo: 'notavez.db', ...(await copiar(fonte, join(pasta, 'notavez.db'))) }];
  if (existsSync(pastaContas)) {
    await mkdir(join(pasta, 'contas'), { mode: 0o700 });
    for (const nome of (await readdir(pastaContas)).filter((f) => UUID_DB.test(f)).sort()) {
      arquivos.push({ arquivo: `contas/${nome}`, ...(await copiar(join(pastaContas, nome), join(pasta, 'contas', nome))) });
    }
  }
  const manifesto = { formato: 2, criadoEm: new Date().toISOString(), arquivo: 'notavez.db', arquivos,
    bytes: arquivos.reduce((s, a) => s + a.bytes, 0), sha256: arquivos[0].sha256, chaveIncluida: false };
  await writeFile(join(pasta, 'manifesto.json'), JSON.stringify(manifesto, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return manifesto;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [origem, destino] = process.argv.slice(2);
  if (!origem || !destino) {
    console.error('Uso: node scripts/backup.mjs /dados/notavez.db /backups/nova-pasta   (inclui /dados/contas/*.db)');
    process.exitCode = 1;
  } else {
    try { const r = await criarBackup(origem, destino); console.log(`Backup íntegro: ${r.arquivos.length} arquivo(s), ${r.bytes} bytes. Guarde a chave mestra separadamente.`); }
    catch { console.error('Backup não concluído. Confira origem, permissões e se a pasta de destino é nova.'); process.exitCode = 1; }
  }
}
