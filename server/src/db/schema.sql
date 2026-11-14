-- Esquema do Nota Sem Stress em PostgreSQL (Neon na Vercel; PGlite nos testes e na demonstração).
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
  versao INTEGER NOT NULL DEFAULT 1,
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
-- Contagens por situação e totais por competência (Início e lista de notas) sem varrer a tabela.
CREATE INDEX IF NOT EXISTS ix_notas_prestador_situacao ON notas(prestador_id, situacao, competencia);
CREATE UNIQUE INDEX IF NOT EXISTS ux_notas_id_dps ON notas(ambiente, id_dps_indice) WHERE id_dps_indice IS NOT NULL;
-- A mesma NFS-e pode estar em mais de uma conta (dono e contador): única por empresa.
CREATE UNIQUE INDEX IF NOT EXISTS ux_notas_chave ON notas(prestador_id, chave_indice) WHERE chave_indice IS NOT NULL;

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
  id BIGSERIAL PRIMARY KEY,
  nota_id TEXT,
  operacao TEXT NOT NULL,           -- envio | reenvio | consulta_dps | consulta_nfse
  http_status INTEGER,
  resultado TEXT NOT NULL,          -- emitida | rejeitada | incerta | nao_enviada | encontrada | nao_encontrada
  codigos TEXT,
  duracao_ms INTEGER,
  criado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auditoria (
  id BIGSERIAL PRIMARY KEY,
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

-- NFS-e recebidas: a empresa é a TOMADORA. Baixadas do ADN (distribuição por NSU)
-- com o certificado da própria empresa; o XML oficial é guardado cifrado.
CREATE TABLE IF NOT EXISTS notas_tomadas (
  id TEXT PRIMARY KEY,
  prestador_id TEXT NOT NULL REFERENCES prestadores(id) ON DELETE CASCADE,
  ambiente TEXT NOT NULL,
  nsu BIGINT NOT NULL,
  chave_cifrada TEXT NOT NULL,
  chave_indice TEXT NOT NULL,
  resumo_cifrado TEXT NOT NULL,     -- {emitente, descricao, servico, municípios}
  n_nfse TEXT,
  competencia TEXT,
  emitida_em TEXT,
  valor TEXT,
  valor_liquido TEXT,
  iss_retido INTEGER NOT NULL DEFAULT 0,
  situacao TEXT NOT NULL DEFAULT 'normal',  -- normal | cancelada
  xml_cifrado TEXT NOT NULL,
  baixada_em TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tomadas_chave ON notas_tomadas(prestador_id, ambiente, chave_indice);
CREATE INDEX IF NOT EXISTS ix_tomadas_prestador ON notas_tomadas(prestador_id, ambiente, competencia);

-- Último NSU lido do ADN por empresa, ambiente e CNPJ consultado.
CREATE TABLE IF NOT EXISTS distribuicao_dfe (
  prestador_id TEXT NOT NULL REFERENCES prestadores(id) ON DELETE CASCADE,
  ambiente TEXT NOT NULL,
  documento_indice TEXT NOT NULL,
  ultimo_nsu BIGINT NOT NULL DEFAULT 0,
  sincronizado_em TEXT,
  -- Versão da leitura: 2 = a fila já foi lida guardando também as notas emitidas pela empresa.
  leitura INTEGER NOT NULL DEFAULT 2,
  -- Última recusa da Receita a esta consulta (ex.: procuração não vigente); some na consulta seguinte que der certo.
  falha_em TEXT,
  falha_cifrada TEXT,
  PRIMARY KEY (prestador_id, ambiente, documento_indice)
);

-- Certificado do procurador (escritório/contador) da conta: usado pelas empresas
-- que concederam procuração eletrônica NFS-e no Portal de Serviços da Receita.
CREATE TABLE IF NOT EXISTS certificados_procurador (
  id TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  pfx_cifrado TEXT NOT NULL,
  senha_cifrada TEXT NOT NULL,
  titular TEXT,
  tipo_documento TEXT,
  documento_cifrado TEXT,
  emissor TEXT,
  valido_de TEXT,
  valido_ate TEXT,
  criado_em TEXT NOT NULL,
  removido_em TEXT
);
CREATE INDEX IF NOT EXISTS ix_cert_procurador_usuario ON certificados_procurador(usuario_id, removido_em);

-- Assistente de IA: provedor, modelo e chave de API por conta (a chave fica cifrada e nunca volta ao app).
CREATE TABLE IF NOT EXISTS ia_config (
  usuario_id TEXT PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  provedor TEXT NOT NULL,
  modelo TEXT NOT NULL,
  chave_cifrada TEXT,
  base_url TEXT,
  esforco TEXT,
  emissao_autonoma INTEGER NOT NULL DEFAULT 0,
  atualizado_em TEXT NOT NULL
);

-- Conversas com o assistente (cifradas: citam clientes, CPF/CNPJ e valores).
CREATE TABLE IF NOT EXISTS ia_conversas (
  id TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  prestador_id TEXT,
  titulo_cifrado TEXT,
  mensagens_cifradas TEXT NOT NULL,
  pendentes_cifrados TEXT,
  versao INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ia_conversas_usuario ON ia_conversas(usuario_id, atualizado_em);

-- Colunas acrescentadas depois da primeira versão (idempotente: roda em bancos já criados).
ALTER TABLE notas ADD COLUMN IF NOT EXISTS ordem BIGSERIAL;             -- ordem de criação (desempate das listas)
ALTER TABLE notas ADD COLUMN IF NOT EXISTS canal TEXT;                  -- NULL = API pelo app; 'emissor_nacional' | 'sincronizada'
ALTER TABLE notas ADD COLUMN IF NOT EXISTS importada_conferida INTEGER NOT NULL DEFAULT 0;
ALTER TABLE prestadores ADD COLUMN IF NOT EXISTS usa_procuracao INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS tipo_documento TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS documento_cifrado TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS documento_indice TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS documento_verificado INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS nome TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS govbr_indice TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS documento_origem TEXT;   -- 'vinculo_govbr' = CPF veio de um gov.br vinculado depois
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS codigo_recuperacao_hash TEXT;
ALTER TABLE sessoes ADD COLUMN IF NOT EXISTS lembrar INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS ix_notas_verificacao ON notas(situacao, proxima_verificacao_em);
CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_documento ON usuarios(documento_indice) WHERE documento_indice IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_govbr ON usuarios(govbr_indice) WHERE govbr_indice IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_sessoes_usuario ON sessoes(usuario_id);

-- Recuperação de senha, limites de tentativa e aparelhos confiáveis (nada em claro: só hashes).
CREATE TABLE IF NOT EXISTS recuperacoes_senha (
  token_hash TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_recuperacoes_usuario ON recuperacoes_senha(usuario_id);
CREATE TABLE IF NOT EXISTS limites_conta (
  chave_hash TEXT PRIMARY KEY, quantidade INTEGER NOT NULL, ate_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS aparelhos_confiaveis (
  token_hash TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em TEXT NOT NULL,
  ordem BIGSERIAL
);
CREATE INDEX IF NOT EXISTS ix_aparelhos_usuario ON aparelhos_confiaveis(usuario_id);

-- Entrar com gov.br: fluxos OAuth em andamento.
CREATE TABLE IF NOT EXISTS govbr_fluxos (
  token_hash TEXT PRIMARY KEY, state TEXT NOT NULL, nonce TEXT NOT NULL, verificador TEXT NOT NULL,
  modo TEXT NOT NULL, usuario_id TEXT REFERENCES usuarios(id) ON DELETE CASCADE, expira_em TEXT NOT NULL
);

-- Limites de requisições (só hashes das chaves).
CREATE TABLE IF NOT EXISTS limites_requisicoes (
  chave TEXT PRIMARY KEY, quantidade INTEGER NOT NULL, expira_em BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_limites_expira ON limites_requisicoes(expira_em);
