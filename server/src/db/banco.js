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
  // Acesso como no Portal da NFS-e: CPF/CNPJ como usuário e vínculo com o gov.br.
  ['usuarios', 'tipo_documento', 'TEXT'],
  ['usuarios', 'documento_cifrado', 'TEXT'],
  ['usuarios', 'documento_indice', 'TEXT'],
  ['usuarios', 'documento_verificado', 'INTEGER NOT NULL DEFAULT 0'],
  ['usuarios', 'nome', 'TEXT'],
  ['usuarios', 'govbr_indice', 'TEXT'],
  // 'vinculo_govbr' = o CPF-usuário veio de um gov.br vinculado depois (não foi digitado pelo titular).
  ['usuarios', 'documento_origem', 'TEXT'],
  // Código de recuperação (só o hash): troca a senha sem depender de e-mail.
  ['usuarios', 'codigo_recuperacao_hash', 'TEXT'],
  // "Manter conectado neste aparelho": sessão longa renovada a cada uso.
  ['sessoes', 'lembrar', 'INTEGER NOT NULL DEFAULT 1'],
  // Por onde a nota foi emitida: NULL = API pelo app; 'emissor_nacional' = XML importado.
  ['notas', 'canal', 'TEXT'],
  // 1 = a empresa assina com o certificado do procurador da conta (procuração eletrônica NFS-e).
  ['prestadores', 'usa_procuracao', 'INTEGER NOT NULL DEFAULT 0'],
  // XML importado conferido com a Receita (versão oficial obtida pela API) ou só enviado pela pessoa.
  ['notas', 'importada_conferida', 'INTEGER NOT NULL DEFAULT 0'],
  // Leitura do ADN: bancos antigos ficam com 1 (a fila foi lida só para as notas tomadas) e são
  // relidos uma vez desde o início, para trazer também as notas que a empresa emitiu fora do app.
  ['distribuicao_dfe', 'leitura', 'INTEGER NOT NULL DEFAULT 1'],
  // Última recusa da Receita à consulta do ADN (motivo cifrado: pode citar o CNPJ).
  ['distribuicao_dfe', 'falha_em', 'TEXT'],
  ['distribuicao_dfe', 'falha_cifrada', 'TEXT'],
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
      CREATE INDEX IF NOT EXISTS ix_notas_verificacao ON notas(situacao, proxima_verificacao_em);
      DROP INDEX IF EXISTS ux_notas_chave;
      CREATE UNIQUE INDEX ux_notas_chave ON notas(prestador_id, chave_indice) WHERE chave_indice IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_documento ON usuarios(documento_indice) WHERE documento_indice IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_govbr ON usuarios(govbr_indice) WHERE govbr_indice IS NOT NULL;`);
    // Bancos antigos guardavam o CN inteiro ("NOME:CPF") em claro: fica só o nome.
    for (const tabela of ['certificados', 'certificados_procurador']) {
      for (const r of db.prepare(`SELECT id, titular FROM ${tabela} WHERE titular LIKE '%:%'`).all()) {
        db.prepare(`UPDATE ${tabela} SET titular = ? WHERE id = ?`).run(String(r.titular).replace(/:[0-9A-Z]{11,14}$/i, '').trim() || null, r.id);
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); db.close(); throw e; }
}
