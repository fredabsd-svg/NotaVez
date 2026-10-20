-- Banco de UMA conta do Nota Sem Stress (um arquivo SQLite por conta).
-- Nenhuma tabela daqui existe no catálogo central: os dados de uma conta não
-- dividem arquivo, tabela nem chave com os de outra.
-- *_cifrado/_cifrada: AES-256-GCM com a chave própria da conta (security/cripto.js,
-- criarCriptoConta). *_indice: HMAC com a chave de índice da conta.
-- Ficam em claro só códigos públicos (lista de serviços, IBGE), situações,
-- datas técnicas e identificadores internos.

CREATE TABLE IF NOT EXISTS meta (
  chave TEXT PRIMARY KEY,           -- usuario_id | encerrada
  valor TEXT NOT NULL
);

-- Perfil fiscal do prestador (emitente).
CREATE TABLE IF NOT EXISTS prestadores (
  id TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL,
  documento_cifrado TEXT,
  documento_indice TEXT,
  tipo_documento TEXT,              -- 'CNPJ' | 'CPF'
  nome_cifrado TEXT,
  municipio_ibge TEXT,
  op_simp_nac TEXT,                 -- 1 Não optante | 2 MEI | 3 ME/EPP
  reg_esp_trib TEXT DEFAULT '0',
  inscricao_municipal_cifrada TEXT,
  contato_cifrado TEXT,             -- {email, fone}
  serie_dps TEXT NOT NULL DEFAULT '1',
  versao INTEGER NOT NULL DEFAULT 1,
  config_fiscal TEXT,               -- parâmetros do regime (alíquotas e percentuais; sem dados pessoais)
  ambiente TEXT NOT NULL DEFAULT 'producao_restrita',
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS certificados (
  id TEXT PRIMARY KEY,
  prestador_id TEXT NOT NULL REFERENCES prestadores(id) ON DELETE CASCADE,
  pfx_cifrado TEXT NOT NULL,
  senha_cifrada TEXT NOT NULL,
  titular_cifrado TEXT,
  documento_cifrado TEXT,
  emissor TEXT,                     -- autoridade certificadora (pública)
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
  apelido_cifrado TEXT NOT NULL,
  c_trib_nac TEXT NOT NULL,
  c_trib_mun TEXT,
  c_nbs TEXT,
  descricao_cifrada TEXT NOT NULL,
  valor_padrao_cifrado TEXT,
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
  valor_cifrado TEXT,
  competencia_cifrada TEXT,
  ambiente TEXT,
  contexto_emitente_cifrado TEXT,   -- snapshot imutável do perfil aprovado
  processamento_token TEXT,
  processamento_ate TEXT,
  proxima_verificacao_em TEXT,
  verificacoes INTEGER NOT NULL DEFAULT 0,
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
CREATE INDEX IF NOT EXISTS ix_notas_verificacao ON notas(situacao, proxima_verificacao_em);
CREATE UNIQUE INDEX IF NOT EXISTS ux_notas_id_dps ON notas(ambiente, id_dps_indice) WHERE id_dps_indice IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_notas_chave ON notas(chave_indice) WHERE chave_indice IS NOT NULL;

-- Cada chamada à API oficial (sem dados pessoais).
CREATE TABLE IF NOT EXISTS chamadas_api (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nota_id TEXT,
  operacao TEXT NOT NULL,           -- envio | reenvio | consulta_dps | consulta_nfse | parametros_convenio
  http_status INTEGER,
  resultado TEXT NOT NULL,          -- emitida | rejeitada | incerta | nao_enviada | encontrada | nao_encontrada
  codigos TEXT,
  duracao_ms INTEGER,
  criado_em TEXT NOT NULL
);

-- Operações da conta (ids internos e códigos; o IP fica cifrado).
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
