import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const agora = () => new Date().toISOString();
export const novoId = () => randomUUID();

export function abrirBanco(arquivo) {
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  migrar(db);
  return {
    raw: db,
    get: (sql, ...p) => db.prepare(sql).get(...p),
    all: (sql, ...p) => db.prepare(sql).all(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
    // Transação síncrona: node:sqlite é síncrono, então não há intercalação.
    transacao(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    fechar: () => db.close(),
  };
}

// Migrações aditivas para bancos criados por versões anteriores.
const COLUNAS_NOVAS = [
  ['prestadores', 'config_fiscal', 'TEXT'],
];
function migrar(db) {
  for (const [tabela, coluna, tipo] of COLUNAS_NOVAS) {
    const existe = db.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === coluna);
    if (!existe) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
  }
}
