import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { criptoCentral } from '../security/cripto.js';

export const agora = () => new Date().toISOString();
export const novoId = () => randomUUID();

const ESQUEMA_CENTRAL = readFileSync(new URL('./schema-central.sql', import.meta.url), 'utf8');
const ESQUEMA_CONTA = readFileSync(new URL('./schema-conta.sql', import.meta.url), 'utf8');

function envolver(db, cripto) {
  return {
    raw: db,
    cripto,
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
    fechar: () => { if (db.isOpen) db.close(); },
  };
}

function conectar(arquivo) {
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
  return db;
}

/** Catálogo central: login, sessões, chaves envelopadas e numeração da DPS. */
export function abrirCentral(arquivo) {
  const db = conectar(arquivo);
  prepararCentral(db);
  return envolver(db, criptoCentral);
}

/** Banco de UMA conta, já com a criptografia presa à chave dessa conta. */
export function abrirBancoConta(arquivo, cripto) {
  const db = conectar(arquivo);
  db.exec(ESQUEMA_CONTA);
  const dono = db.prepare("SELECT valor FROM meta WHERE chave = 'usuario_id'").get();
  if (dono && dono.valor !== cripto.usuarioId) { db.close(); throw new Error('Este banco pertence a outra conta.'); }
  if (!dono) db.prepare("INSERT INTO meta (chave, valor) VALUES ('usuario_id', ?)").run(cripto.usuarioId);
  return envolver(db, cripto);
}

// Ajustes em catálogos criados por versões anteriores (banco único).
function prepararCentral(db) {
  const colunas = (t) => db.prepare(`PRAGMA table_info(${t})`).all();
  const usuarios = colunas('usuarios');
  // Versões anteriores exigiam e-mail e senha e não tinham a chave da conta:
  // recria a tabela (o SQLite não remove NOT NULL com ALTER TABLE).
  if (usuarios.length && (!usuarios.some((c) => c.name === 'chave_conta') || usuarios.find((c) => c.name === 'email')?.notnull)) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE usuarios_v2 (id TEXT PRIMARY KEY, email TEXT UNIQUE, senha_hash TEXT, chave_conta TEXT, criado_em TEXT NOT NULL);
        INSERT INTO usuarios_v2 (id, email, senha_hash, criado_em) SELECT id, email, senha_hash, criado_em FROM usuarios;
        DROP TABLE usuarios; ALTER TABLE usuarios_v2 RENAME TO usuarios;`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); db.close(); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); }
  }
  if (colunas('sessoes').length && !colunas('sessoes').some((c) => c.name === 'metodo')) db.exec('ALTER TABLE sessoes ADD COLUMN metodo TEXT');
  db.exec(ESQUEMA_CENTRAL);
}

/** Tabelas do antigo banco único que ainda tenham dados (migração para bancos por conta). */
export function tabelasLegadas(central) {
  const existe = (t) => !!central.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t);
  return ['prestadores', 'certificados', 'clientes', 'servicos', 'notas', 'chamadas_api'].filter(existe);
}
