// Backup lógico do banco (Postgres/Neon ou PGlite): cada tabela vira um arquivo JSON numa pasta nova.
// Os campos sensíveis continuam cifrados (AES-256-GCM): o backup NUNCA inclui a chave mestra,
// que deve ser guardada separadamente. No Neon, o banco também tem restauração no tempo pelo painel.
//   node scripts/backup.mjs /backups/2026-11-14          (usa DATABASE_URL ou NOTAVEZ_DB)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const ignorar = new Set(['limites_requisicoes', 'limites_conta']); // dados temporários

async function tabelas(db) {
  return (await db.all("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"))
    .map((r) => r.t).filter((t) => !ignorar.has(t) && /^[a-z_]+$/.test(t));
}

export async function criarBackup(db, destino) {
  const pasta = resolve(destino);
  // Uma pasta nova por execução evita sobrescrever o único backup anterior.
  await mkdir(pasta, { mode: 0o700 });
  const arquivos = {};
  for (const t of await tabelas(db)) {
    const linhas = await db.all(`SELECT * FROM ${t}`);
    const conteudo = `${JSON.stringify(linhas)}\n`;
    await writeFile(join(pasta, `${t}.json`), conteudo, { mode: 0o600, flag: 'wx' });
    arquivos[t] = { linhas: linhas.length, sha256: createHash('sha256').update(conteudo).digest('hex') };
  }
  const manifesto = { formato: 2, criadoEm: new Date().toISOString(), banco: db.tipo, arquivos, chaveIncluida: false };
  await writeFile(join(pasta, 'manifesto.json'), `${JSON.stringify(manifesto, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return manifesto;
}

// Restaura num banco VAZIO (tabelas criadas pelo esquema), conferindo os hashes do manifesto.
// Ordem que respeita as chaves estrangeiras: usuários, empresas e só depois o resto.
const ORDEM = ['usuarios', 'prestadores'];
export async function restaurarBackup(db, origem) {
  const pasta = resolve(origem);
  const manifesto = JSON.parse(await readFile(join(pasta, 'manifesto.json'), 'utf8'));
  if (manifesto.formato !== 2) throw new Error('Formato de backup desconhecido.');
  const nomes = Object.keys(manifesto.arquivos).sort((a, b) => (ORDEM.indexOf(a) + 1 || 99) - (ORDEM.indexOf(b) + 1 || 99) || a.localeCompare(b));
  await db.transacao(async () => {
    for (const t of nomes) {
      if (!/^[a-z_]+$/.test(t)) throw new Error('Nome de tabela inválido no backup.');
      const conteudo = await readFile(join(pasta, `${t}.json`), 'utf8');
      if (createHash('sha256').update(conteudo).digest('hex') !== manifesto.arquivos[t].sha256) throw new Error(`Arquivo ${t}.json alterado ou corrompido.`);
      for (const linha of JSON.parse(conteudo)) {
        const colunas = Object.keys(linha).filter((c) => /^[a-z_]+$/.test(c));
        await db.run(`INSERT INTO ${t} (${colunas.join(', ')}) VALUES (${colunas.map(() => '?').join(', ')})`, ...colunas.map((c) => linha[c]));
      }
    }
  });
  // As sequências (BIGSERIAL) continuam depois do maior valor restaurado.
  for (const { t, c } of [{ t: 'chamadas_api', c: 'id' }, { t: 'auditoria', c: 'id' }, { t: 'notas', c: 'ordem' }, { t: 'aparelhos_confiaveis', c: 'ordem' }]) {
    if (manifesto.arquivos[t]?.linhas) await db.get(`SELECT setval(pg_get_serial_sequence('${t}', '${c}'), (SELECT max(${c}) FROM ${t}))`);
  }
  return manifesto;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [destino] = process.argv.slice(2);
  if (!destino) {
    console.error('Uso: node scripts/backup.mjs /backups/nova-pasta   (banco: DATABASE_URL ou NOTAVEZ_DB)');
    process.exitCode = 1;
  } else {
    const { abrirBanco } = await import('../src/db/banco.js');
    const db = await abrirBanco(process.env.NOTAVEZ_DB, { esquema: 'nunca' });
    try { const r = await criarBackup(db, destino); console.log(`Backup concluído: ${Object.keys(r.arquivos).length} tabelas. Guarde a chave mestra separadamente.`); }
    catch { console.error('Backup não concluído. Confira o banco, as permissões e se a pasta de destino é nova.'); process.exitCode = 1; }
    finally { await db.fechar(); }
  }
}
