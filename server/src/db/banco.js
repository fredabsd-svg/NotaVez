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
  ['prestadores', 'versao', 'INTEGER NOT NULL DEFAULT 1'],
  ['notas', 'contexto_emitente_cifrado', 'TEXT'],
  ['notas', 'processamento_token', 'TEXT'],
  ['notas', 'processamento_ate', 'TEXT'],
  ['notas', 'proxima_verificacao_em', 'TEXT'],
  ['notas', 'verificacoes', 'INTEGER NOT NULL DEFAULT 0'],
];
function migrar(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [tabela, coluna, tipo] of COLUNAS_NOVAS) {
      const existe = db.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === coluna);
      if (!existe) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
    }
    // Recria também em bancos existentes: o antigo índice ignorava o ambiente.
    db.exec(`DROP INDEX IF EXISTS ux_notas_id_dps;
      CREATE UNIQUE INDEX ux_notas_id_dps ON notas(ambiente, id_dps_indice) WHERE id_dps_indice IS NOT NULL;
      CREATE INDEX IF NOT EXISTS ix_notas_verificacao ON notas(situacao, proxima_verificacao_em);`);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); db.close(); throw e; }
}
