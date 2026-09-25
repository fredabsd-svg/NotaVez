# 3. Modelo de dados e desenho da integração com a API

## 3.1 Arquitetura

```mermaid
flowchart LR
  subgraph Celular
    PWA[PWA NotaVez<br/>HTML/CSS/JS sem build<br/>IndexedDB: rascunhos offline]
  end
  subgraph Servidor NotaVez
    API[API REST Fastify<br/>contas · clientes · serviços · notas]
    REG[Pacotes de regras fiscais<br/>por regime e vigência]
    DPS[Gerador de DPS + XSD oficial<br/>+ assinatura XMLDSig]
    SEF[Cliente Sefin<br/>TLS mútuo com o A1]
    DB[(Banco: SQLite no MVP<br/>PostgreSQL em produção<br/>dados sensíveis cifrados)]
    JOB[Tarefa periódica:<br/>verifica pendentes]
  end
  RFB[Sefin Nacional / ADN<br/>produção restrita · produção]
  PWA -- HTTPS + cookie de sessão --> API
  API --> REG --> DPS --> SEF -- mTLS --> RFB
  API <--> DB
  JOB --> SEF
```

- **Separação:** o PWA (`web/`) é estático e pode ser servido por qualquer CDN; o servidor (`server/`) concentra contas, dados, regras e integração. No MVP o servidor também serve o PWA, para simplificar a implantação (mesma origem e cookie `SameSite=Strict`).
- **Regras atualizáveis:** o leiaute (XSD), as tabelas (Anexos A, B e I) e os endereços dos ambientes ficam em arquivos de dados. As regras de negócio ficam em **pacotes por regime e vigência** (`server/src/fiscal/regras/`). Novos regimes (ME/EPP) e novas vigências (IBS/CBS 2027) entram como novos pacotes, sem mudar telas nem o fluxo de emissão.

## 3.2 Modelo de dados

```mermaid
erDiagram
  usuarios ||--o{ sessoes : tem
  usuarios ||--o{ prestadores : "perfis fiscais"
  prestadores ||--o{ certificados : "A1 (1 ativo)"
  prestadores ||--o{ clientes : cadastra
  prestadores ||--o{ servicos : salva
  prestadores ||--o{ notas : emite
  notas ||--o{ chamadas_api : registra
  notas }o--o| notas : "origem_id (clonada de)"
  usuarios {
    text id PK
    text email UK
    text senha_hash "scrypt"
  }
  prestadores {
    text id PK
    text documento_cifrado "CNPJ"
    text documento_indice "HMAC"
    text municipio_ibge
    text op_simp_nac "1|2 MEI|3"
    text serie_dps "1..49999"
    text ambiente "producao_restrita|producao"
  }
  certificados {
    text pfx_cifrado "AES-256-GCM"
    text senha_cifrada
    text valido_ate
    text removido_em "apaga o material"
  }
  clientes {
    text dados_cifrados "tipo, doc, nome, e-mail, fone, endereço"
    text documento_indice "HMAC — busca exata e unicidade"
  }
  servicos {
    text apelido
    text c_trib_nac "lista nacional"
    text descricao
    text valor_padrao
  }
  notas {
    text situacao "rascunho|enviando|pendente|rejeitada|emitida"
    text rascunho_cifrado
    text n_dps
    text id_dps_cifrado
    text id_dps_indice UK
    text dps_xml_cifrado "exatamente como enviada"
    text chave_cifrada
    text chave_indice UK
    text nfse_xml_cifrado "XML oficial"
    text erros_json
    int tentativas
  }
  contadores_dps {
    text emitente_indice PK "por CNPJ, não por conta"
    text ambiente PK
    text serie PK
    int ultimo
  }
```

Tabelas adicionais: `auditoria` (operações sem dados pessoais) e `chamadas_api` (cada chamada à Receita: operação, HTTP, resultado, códigos, duração).

**Por que o Id da DPS e a chave de acesso são cifrados:** os dois contêm o CPF/CNPJ do emitente. Para buscas e unicidade usamos índices cegos (HMAC com chave derivada).

**Numeração da DPS:** o contador é por **emitente** (CNPJ), ambiente e série, e não por conta. Duas contas do mesmo CNPJ, por exemplo o MEI e o contador dele, compartilham a sequência e não geram a rejeição E0014. Um número nunca é reutilizado: rejeitada → próximo envio com número novo.

## 3.3 Máquina de estados da nota

```mermaid
stateDiagram-v2
  [*] --> rascunho: criar / clonar (novos ids, sem número, sem chave)
  rascunho --> rascunho: editar (autosave)
  rascunho --> enviando: Emitir (valida regras + XSD, reserva nº, assina)
  rejeitada --> enviando: corrigir e emitir (NOVO nº de DPS)
  enviando --> emitida: 2xx com chave de acesso
  enviando --> rejeitada: 4xx com erros da Receita
  enviando --> rascunho: não enviada (sem conexão, 401/403, 429)
  enviando --> pendente: timeout, erro de rede após conectar, 5xx, resposta incompleta
  enviando --> pendente: E0014 (duplicidade) → consulta imediata
  pendente --> emitida: GET /dps/{id} encontrou → GET /nfse/{chave}
  pendente --> pendente: não encontrada e espera < 60 s ou tentativas > 3
  pendente --> enviando: não encontrada → reenvia a MESMA DPS assinada
  emitida --> [*]
```

Garantias:

1. **"Emitida" só com a chave de acesso oficial.** Qualquer dúvida vira "pendente".
2. **Consultar antes de reenviar:** o reenvio só acontece depois que `GET /dps/{id}` responde "não encontrada", passado o tempo mínimo de espera (`NOTAVEZ_ESPERA_REENVIO_MS`, padrão 60 s).
3. **O reenvio é idempotente:** usa o **mesmo XML assinado** (mesmo Id). Se a primeira tentativa tiver sido processada nesse meio-tempo, a Receita responde E0014, e o NotaVez consulta e recupera a nota. Não há como gerar duas NFS-e para o mesmo rascunho.
4. **Travas:** transição de estado atômica (compare-and-set no banco) e trava por nota no processo, contra toque duplo.
5. **Clonar** copia só cliente, serviço, descrição, valor e local. Nunca copia número de DPS, Id, chave, XML ou situação. Competência, valor, descrição e tributação ficam marcados em `revisar` e bloqueiam a emissão até serem conferidos.

## 3.4 Sequência de emissão

```mermaid
sequenceDiagram
  participant U as PWA
  participant S as Servidor NotaVez
  participant R as Sefin Nacional
  U->>S: POST /api/notas/{id}/emitir
  S->>S: elegibilidade (perfil, MEI, certificado válido do mesmo CNPJ)
  S->>S: regras MEI (Anexo I) → erros em linguagem comum
  S->>S: reserva nDPS (por CNPJ) · monta DPS v1.01 · assina · valida XSD oficial
  S->>S: grava DPS assinada (cifrada) · situação = enviando
  S->>R: POST /nfse {dpsXmlGZipB64} (TLS mútuo com o A1)
  alt 201 com chaveAcesso
    R-->>S: chaveAcesso + nfseXmlGZipB64
    S-->>U: Emitida (chave, nº, XML)
  else 400 com erros
    R-->>S: erros[{codigo, descricao}]
    S-->>U: Rejeitada (mensagem + próximo passo + código)
  else timeout / 5xx
    S-->>U: Pendente de confirmação
    Note over S,R: depois (toque do usuário ou tarefa a cada 2 min)
    S->>R: GET /dps/{id}
    alt encontrada
      S->>R: GET /nfse/{chave}
      S-->>U: Emitida
    else 404 (após espera)
      S->>R: POST /nfse (mesma DPS assinada)
    end
  end
```

## 3.5 Detalhes da integração

| Tema | Implementação | Arquivo |
|---|---|---|
| Leiaute | DPS v1.01 montada na ordem do XSD; escape XML; `dhEmi` com fuso -03:00 recuado 60 s (E0008) | `server/src/fiscal/dps.js` |
| Validação | XSD oficial `esquemas-nfse-rtc-v1-01-20260727`, via `xmllint-wasm`, **antes do envio** | `server/src/fiscal/xsd.js` |
| Assinatura | XMLDSig enveloped sobre `infDPS` (Reference `#Id`), RSA-SHA256, digest SHA-256, C14N, `X509Certificate` no KeyInfo | `server/src/fiscal/assinatura.js` |
| Certificado | Leitura do PKCS#12, localização do OID 2.16.76.1.3.3 (CNPJ), checagem de validade, uso e cadeia ICP-Brasil | `server/src/fiscal/certificado.js` |
| Transporte | HTTPS com `key`/`cert` do A1 (convertido para PEM, compatível com PFX antigos), keep-alive, timeout configurável; corpo GZip + Base64 | `server/src/fiscal/sefin/cliente.js` |
| Classificação | Erros **antes da conexão TLS** = "não enviada"; depois da conexão = "incerta" | idem |
| Mensagens | Códigos oficiais → texto comum + próximo passo; códigos desconhecidos mostram a descrição oficial | `server/src/fiscal/mensagens.js` |
| Ambientes | URLs em JSON; homologação é o padrão; produção exige `NOTAVEZ_PRODUCAO_LIBERADA=1` | `server/src/fiscal/sefin/ambientes.json` |

## 3.6 Segurança e privacidade (LGPD)

- **Senha gov.br:** nunca é pedida nem armazenada.
- **Certificado A1:** chega por HTTPS com consentimento explícito e é verificado na hora (senha, CNPJ igual ao do perfil, validade, ICP-Brasil). Fica guardado com **AES-256-GCM**, junto com a senha, usando chave derivada (HKDF) da chave mestra `NOTAVEZ_MASTER_KEY`, que em produção deve vir de um **KMS/HSM**. Nunca volta para o aplicativo. "Remover" apaga o material criptográfico, não só marca como removido.
- **Dados de clientes:** CPF/CNPJ, nome, contato e endereço ficam cifrados. A busca por documento usa HMAC; a busca por nome é feita em memória, só com os clientes do próprio usuário. Nas listas, o CPF aparece mascarado.
- **Rascunho, DPS e XML:** cifrados em repouso. O teste automatizado confere que CPF, CNPJ e nome não aparecem em claro no banco.
- **Sessão:** cookie `HttpOnly`, `Secure` e `SameSite=Strict`; token aleatório de 256 bits guardado como HMAC. Proteção CSRF por cabeçalho `X-NotaVez` obrigatório nas alterações. Limite de 5 tentativas de login a cada 15 min.
- **Cabeçalhos:** CSP restritiva (`default-src 'self'`, sem scripts inline), HSTS, `X-Frame-Options: DENY`, `no-store` nas respostas da API.
- **No aparelho:** o service worker guarda só a "casca" do app, nunca respostas da API. Rascunhos e cópias de apoio ficam no IndexedDB e são apagados ao sair da conta.
- **Registro de operações:** `auditoria` (quem, o quê, quando, IP, sem dados pessoais) e `chamadas_api` (todas as chamadas à Receita).
- **Isolamento:** toda consulta filtra pelo prestador da sessão (testado).
