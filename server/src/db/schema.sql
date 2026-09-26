-- Esquema do NotaVez (SQLite no MVP; compatível com migração para PostgreSQL).
-- Campos *_cifrado usam AES-256-GCM (security/cripto.js). *_indice são HMACs
-- para busca exata sem expor CPF/CNPJ.

CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  criado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessoes (
  token_hash TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em TEXT NOT NULL,
  expira_em TEXT NOT NULL
);

-- Perfil fiscal do prestador (emitente). Um usuário pode ter mais de um no futuro
-- (ex.: escritório contábil), por isso a separação.
CREATE TABLE IF NOT EXISTS prestadores (
  id TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  documento_cifrado TEXT,
  documento_indice TEXT,
  tipo_documento TEXT,              -- 'CNPJ' | 'CPF'
  nome TEXT,
  municipio_ibge TEXT,
  op_simp_nac TEXT,                 -- 1 Não optante | 2 MEI | 3 ME/EPP
  reg_esp_trib TEXT DEFAULT '0',
  inscricao_municipal TEXT,
  contato_cifrado TEXT,             -- {email, fone}
  serie_dps TEXT NOT NULL DEFAULT '1',
  config_fiscal TEXT,               -- parâmetros do regime (ME/EPP: regApTribSN, pTotTribSN, aliqIssSN; não optante: PIS/COFINS, pTotTrib, aliqIss)
  ambiente TEXT NOT NULL DEFAULT 'producao_restrita',
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_prestadores_usuario ON prestadores(usuario_id);

CREATE TABLE IF NOT EXISTS certificados (
  id TEXT PRIMARY KEY,
  prestador_id TEXT NOT NULL REFERENCES prestadores(id) ON DELETE CASCADE,
  pfx_cifrado TEXT NOT NULL,
  senha_cifrada TEXT NOT NULL,
  titular TEXT,
  documento_cifrado TEXT,
  emissor TEXT,
  valido_de TEXT,
  valido_ate TEXT,
  criado_em TEXT NOT NULL,
  removido_em TEXT
);

CREATE TABLE IF NOT EXISTS clientes (
  id TEXT PRIMARY KEY,
  prestador_id TEXT NOT NULL REFERENCES prestadores(id) ON DELETE CASCADE,
  dados_cifrados TEXT NOT NULL,     -- {tipo, documento, nome, email, fone, endereco, im}
  documento_indice TEXT,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  usado_em TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_clientes_documento ON clientes(prestador_id, documento_indice);

CREATE TABLE IF NOT EXISTS servicos (
  id TEXT PRIMARY KEY,
  prestador_id TEXT NOT NULL REFERENCES prestadores(id) ON DELETE CASCADE,
  apelido TEXT NOT NULL,
  c_trib_nac TEXT NOT NULL,
  c_trib_mun TEXT,
  c_nbs TEXT,
  descricao TEXT NOT NULL,
  valor_padrao TEXT,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  usado_em TEXT
);

-- Uma "nota" nasce como rascunho e só vira NFS-e com confirmação oficial.
-- situacao: rascunho | enviando | pendente | rejeitada | emitida
CREATE TABLE IF NOT EXISTS notas (
  id TEXT PRIMARY KEY,
  prestador_id TEXT NOT NULL REFERENCES prestadores(id) ON DELETE CASCADE,
  situacao TEXT NOT NULL,
  origem_id TEXT,                   -- nota clonada (apenas referência)
  rascunho_cifrado TEXT NOT NULL,   -- dados preenchidos pelo usuário
  valor TEXT,
  competencia TEXT,
  ambiente TEXT,
  serie TEXT,
  n_dps TEXT,
  id_dps_cifrado TEXT,              -- o Id da DPS e a chave contêm o CNPJ/CPF do emitente
  id_dps_indice TEXT,
  dps_xml_cifrado TEXT,             -- DPS assinada exatamente como enviada
  chave_cifrada TEXT,
  chave_indice TEXT,
  n_nfse TEXT,
  nfse_xml_cifrado TEXT,            -- XML oficial devolvido pela Sefin
  erros_json TEXT,
  alertas_json TEXT,
  tentativas INTEGER NOT NULL DEFAULT 0,
  ultimo_envio_em TEXT,
  emitida_em TEXT,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  versao INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_notas_prestador ON notas(prestador_id, atualizado_em);
CREATE UNIQUE INDEX IF NOT EXISTS ux_notas_id_dps ON notas(id_dps_indice) WHERE id_dps_indice IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_notas_chave ON notas(chave_indice) WHERE chave_indice IS NOT NULL;

-- Numeração da DPS por EMITENTE (índice cego do CNPJ/CPF), ambiente e série.
-- Duas contas com o mesmo CNPJ compartilham a sequência (evita E0014). Nunca reutilizada.
CREATE TABLE IF NOT EXISTS contadores_dps (
  emitente_indice TEXT NOT NULL,
  ambiente TEXT NOT NULL,
  serie TEXT NOT NULL,
  ultimo INTEGER NOT NULL,
  PRIMARY KEY (emitente_indice, ambiente, serie)
);

-- Cada chamada à API oficial (sem dados pessoais).
CREATE TABLE IF NOT EXISTS chamadas_api (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nota_id TEXT,
  operacao TEXT NOT NULL,           -- envio | reenvio | consulta_dps | consulta_nfse
  http_status INTEGER,
  resultado TEXT NOT NULL,          -- emitida | rejeitada | incerta | nao_enviada | encontrada | nao_encontrada
  codigos TEXT,
  duracao_ms INTEGER,
  criado_em TEXT NOT NULL
);

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
  chave TEXT PRIMARY KEY,           -- ex.: convenio:3550308
  dados TEXT NOT NULL,
  obtido_em TEXT NOT NULL
);
