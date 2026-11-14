// Banco de dados: PostgreSQL. Na Vercel, o Neon (DATABASE_URL); nos testes, na demonstração e em
// desenvolvimento, o PGlite (Postgres em WebAssembly, em memória ou numa pasta).
//
// O código escreve SQL com "?" (convertido aqui para $1, $2…) e chama sempre com await:
//   await db.get(sql, ...p)  → primeira linha ou undefined
//   await db.all(sql, ...p)  → linhas
//   await db.run(sql, ...p)  → { changes }
//   await db.transacao(async () => { … })
// Dentro de db.transacao, toda chamada a db.* (inclusive de outras funções) vai pela mesma
// conexão, graças ao AsyncLocalStorage. A transação é SERIALIZABLE e repetida em conflito de
// serialização: o mesmo isolamento que o SQLite dava com BEGIN IMMEDIATE.
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const agora = () => new Date().toISOString();
export const novoId = () => randomUUID();

const ESQUEMA = () => readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

// "?" → "$n", sem tocar no que está entre aspas simples.
export function placeholders(sql) {
  let n = 0; let dentro = false; let out = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") dentro = !dentro;
    out += !dentro && c === '?' ? `$${++n}` : c;
  }
  return out;
}
// Booleanos viram 0/1 (as colunas são INTEGER, como no SQLite) e undefined vira NULL.
const valor = (v) => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v);
const params = (p) => p.map(valor);

// int8 (contagens, BIGSERIAL, epoch em ms) e numeric (somas) chegam como texto: viram número.
const PARSERS = { 20: (v) => Number(v), 1700: (v) => Number(v) };

async function abrirPglite(arquivo) {
  const { PGlite } = await import('@electric-sql/pglite');
  const pasta = !arquivo || arquivo === ':memory:' ? undefined : arquivo;
  const pg = await PGlite.create(pasta, { parsers: PARSERS });
  const exec = (cliente) => async (sql, p) => {
    const r = await cliente.query(placeholders(sql), params(p));
    return { rows: r.rows, changes: r.affectedRows ?? 0 };
  };
  let fila = Promise.resolve();
  return {
    tipo: 'pglite',
    consulta: exec(pg),
    // O PGlite tem uma conexão só: as transações entram em fila.
    async transacao(fn) {
      const anterior = fila;
      let liberar;
      fila = new Promise((ok) => { liberar = ok; });
      await anterior;
      try { return await pg.transaction(async (tx) => fn(exec(tx))); } finally { liberar(); }
    },
    executarScript: (sql) => pg.exec(sql),
    fechar: () => pg.close(),
  };
}

async function abrirPostgres(url) {
  const { default: pg } = await import('pg');
  for (const [oid, f] of Object.entries(PARSERS)) pg.types.setTypeParser(Number(oid), f);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.NOTAVEZ_DB_CONEXOES || 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ssl: /sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? undefined : { rejectUnauthorized: true },
  });
  const exec = (cliente) => async (sql, p) => {
    const r = await cliente.query(placeholders(sql), params(p));
    return { rows: r.rows, changes: r.rowCount ?? 0 };
  };
  return {
    tipo: 'postgres',
    consulta: exec(pool),
    async transacao(fn) {
      for (let tentativa = 0; ; tentativa++) {
        const cliente = await pool.connect();
        try {
          await cliente.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
          const r = await fn(exec(cliente));
          await cliente.query('COMMIT');
          return r;
        } catch (e) {
          await cliente.query('ROLLBACK').catch(() => {});
          // 40001 = conflito de serialização; 40P01 = deadlock: repete a transação inteira.
          if (['40001', '40P01'].includes(e?.code) && tentativa < 6) { await new Promise((ok) => setTimeout(ok, 15 * 2 ** tentativa)); continue; }
          throw e;
        } finally { cliente.release(); }
      }
    },
    executarScript: (sql) => pool.query(sql),
    fechar: () => pool.end(),
  };
}

// Cria as tabelas e colunas que faltam. O script é idempotente (CREATE … IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
//  - 'sempre': aplica o esquema inteiro ao abrir (servidor contínuo, PGlite, testes);
//  - 'se-faltar': só num banco vazio (Vercel: quem atualiza o esquema é o build de produção, scripts/migrar.mjs,
//    para que um deploy de pré-visualização nunca altere o banco da produção).
export async function aplicarEsquema(motor, modo = 'sempre') {
  if (modo === 'nunca') return false;
  if (modo === 'se-faltar') {
    const r = await motor.consulta("SELECT to_regclass('public.usuarios') AS t", []);
    if (r.rows[0]?.t) return false;
  }
  await motor.executarScript(ESQUEMA());
  return true;
}

// Usado no build da Vercel: aplica o esquema no banco de DATABASE_URL e fecha a conexão.
export async function migrar(url = process.env.DATABASE_URL) {
  const motor = await abrirPostgres(url);
  try { return await aplicarEsquema(motor, 'sempre'); } finally { await motor.fechar(); }
}

export async function abrirBanco(arquivo, { url = process.env.DATABASE_URL, esquema = process.env.VERCEL ? 'se-faltar' : 'sempre' } = {}) {
  const motor = url ? await abrirPostgres(url) : await abrirPglite(arquivo);
  await aplicarEsquema(motor, esquema === false ? 'nunca' : esquema === true ? 'sempre' : esquema);
  const contexto = new AsyncLocalStorage();
  const consulta = (sql, p) => (contexto.getStore() || motor.consulta)(sql, p);
  const db = {
    tipo: motor.tipo,
    get: async (sql, ...p) => (await consulta(sql, p)).rows[0],
    all: async (sql, ...p) => (await consulta(sql, p)).rows,
    run: async (sql, ...p) => ({ changes: (await consulta(sql, p)).changes }),
    // Transação aninhada reaproveita a de fora (como o SQLite fazia ao chamar dentro do mesmo BEGIN).
    transacao: (fn) => (contexto.getStore() ? fn() : motor.transacao((cliente) => contexto.run(cliente, fn))),
    executarScript: (sql) => motor.executarScript(sql),
    fechar: () => motor.fechar(),
  };
  return db;
}
