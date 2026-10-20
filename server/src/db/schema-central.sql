-- Catálogo central do Nota Sem Stress. Guarda só o que precisa ser comum a
-- todas as contas: login, sessões, a chave envelopada de cada conta e a
-- numeração da DPS por emitente. Perfil, certificado, clientes, serviços e
-- notas ficam num banco SQLite SEPARADO por conta (schema-conta.sql).
-- *_cifrado: AES-256-GCM com a chave do servidor; *_indice: HMAC (busca exata
-- sem guardar CPF/CNPJ em claro).

CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,                -- só nas contas com login por e-mail e senha
  senha_hash TEXT,                  -- scrypt; nulo nas contas criadas por gov.br ou certificado
  chave_conta TEXT,                 -- chave de dados da conta, envelopada pela chave mestra
  criado_em TEXT NOT NULL
);

-- Pessoa (CPF) ou empresa (CNPJ) comprovada por gov.br ou certificado digital.
-- Um CPF/CNPJ abre uma única conta; o mesmo CPF entra por gov.br ou por e-CPF.
CREATE TABLE IF NOT EXISTS identidades (
  id TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo_documento TEXT NOT NULL,     -- 'CPF' | 'CNPJ'
  documento_indice TEXT NOT NULL UNIQUE,
  documento_cifrado TEXT NOT NULL,
  metodos TEXT NOT NULL,            -- JSON: ["govbr", "certificado"]
  criado_em TEXT NOT NULL,
  ultimo_uso_em TEXT
);
CREATE INDEX IF NOT EXISTS ix_identidades_usuario ON identidades(usuario_id);

CREATE TABLE IF NOT EXISTS sessoes (
  token_hash TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em TEXT NOT NULL,
  expira_em TEXT NOT NULL,
  metodo TEXT                       -- senha | govbr | certificado
);

-- Etapas intermediárias de login (gov.br e certificado): uso único, curta duração.
CREATE TABLE IF NOT EXISTS logins_pendentes (
  id_hash TEXT PRIMARY KEY,
  tipo TEXT NOT NULL,
  navegador_hash TEXT,
  dados_cifrados TEXT,
  expira_em TEXT NOT NULL
);

-- Contas com nota de resultado incerto: a verificação periódica só abre essas.
CREATE TABLE IF NOT EXISTS contas_pendentes (
  usuario_id TEXT PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  desde TEXT NOT NULL
);

-- Numeração da DPS por EMITENTE (índice cego do CNPJ/CPF), ambiente e série.
-- Duas contas com o mesmo CNPJ compartilham a sequência (evita E0014). Nunca reutilizada.
CREATE TABLE IF NOT EXISTS contadores_dps (
  emitente_indice TEXT NOT NULL,
  ambiente TEXT NOT NULL,
  serie TEXT NOT NULL,
  ultimo INTEGER NOT NULL,
  PRIMARY KEY (emitente_indice, ambiente, serie)
);

-- Eventos de conta (cadastro, entrada, exclusão). O IP fica cifrado.
CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id TEXT,
  prestador_id TEXT,
  acao TEXT NOT NULL,
  entidade TEXT,
  entidade_id TEXT,
  detalhes TEXT,
  ip TEXT,
  criado_em TEXT NOT NULL
);

-- Cache das consultas à API de Parâmetros Municipais (dados públicos do município).
CREATE TABLE IF NOT EXISTS parametros_municipais_cache (
  chave TEXT PRIMARY KEY,           -- ex.: convenio:producao_restrita:3550308
  dados TEXT NOT NULL,
  obtido_em TEXT NOT NULL
);
