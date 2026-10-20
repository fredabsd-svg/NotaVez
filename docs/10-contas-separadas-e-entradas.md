# 10. Banco separado por conta, criptografia e formas de entrar

## 10.1 Um banco por conta

Cada conta (cada pessoa ou empresa que usa o Nota Sem Stress) tem **o seu próprio arquivo de banco de dados**. Se dez pessoas usam o sistema, existem dez arquivos, e nenhum deles contém dados de outra conta.

```mermaid
flowchart LR
  subgraph Catálogo central — notavez.db
    U[usuarios: login + chave da conta envelopada]
    I[identidades: CPF/CNPJ comprovados - índice cego]
    S[sessoes]
    C[contadores_dps: numeração por emitente]
    P[contas_pendentes]
  end
  subgraph contas/
    A[(conta-A.db<br/>perfil, A1, clientes,<br/>serviços, notas)]
    B[(conta-B.db)]
    N[(conta-N.db)]
  end
  U -- chave da conta A --> A
  U -- chave da conta B --> B
  U -- chave da conta N --> N
```

| Fica no catálogo central | Fica no banco da conta |
|---|---|
| E-mail e hash da senha (scrypt); chave da conta **envelopada** | Perfil fiscal, certificado A1 (PFX e senha) |
| CPF/CNPJ comprovados por gov.br ou certificado (cifrados + índice cego) | Clientes, serviços salvos |
| Sessões (só o HMAC do token), recuperação de senha, limites | Rascunhos, notas, DPS e XML oficiais |
| Numeração da DPS por emitente (índice cego) | Registro de chamadas à Receita e auditoria da conta |
| Contas com nota de resultado incerto (só o id) | |

**Por que a numeração da DPS continua no catálogo:** duas contas do mesmo CNPJ (por exemplo, o MEI e o contador dele) precisam compartilhar a sequência. Se cada uma numerasse sozinha, a Receita rejeitaria por duplicidade (E0014). O contador guarda só um HMAC do CNPJ.

**Como o isolamento é garantido no código:**

- Cada requisição abre **apenas** o banco da conta da sessão (`req.conta`, em `server/src/app.js`). As rotas não recebem outro banco.
- O arquivo da conta guarda o id do dono (tabela `meta`). Abrir esse arquivo com a chave de outra conta é recusado.
- O nome do arquivo é o UUID da conta, validado (não há caminho montado com dados do usuário). Pasta com permissão 0700 e arquivos com 0600.
- O serviço de emissão (conexões mTLS com a Receita, travas contra envio duplo) também é separado por conta.

## 10.2 Criptografia

Cada conta tem uma **chave de dados própria** (256 bits, aleatória). É criptografia em envelope:

1. A chave da conta é cifrada (AES-256-GCM) pela chave de envelope, derivada (HKDF-SHA256) da chave mestra do servidor (`NOTAVEZ_MASTER_KEY`, que em produção deve vir de um cofre/KMS).
2. Os dados da conta são cifrados com AES-256-GCM usando chaves derivadas da chave da conta. Cada valor leva a identificação da conta como dado autenticado (AAD): um valor copiado para outra conta não abre.
3. As buscas exatas (CPF/CNPJ do cliente, chave de acesso, Id da DPS) usam HMAC com a chave de índice **da conta**. O mesmo CPF gera índices diferentes em contas diferentes.

Ficam cifrados no banco da conta: CPF/CNPJ, nome/razão social, inscrição municipal, contato, PFX e senha do A1, titular do certificado, dados dos clientes, apelido, descrição e valor dos serviços, rascunhos, valor e competência das notas, DPS e XML, chave de acesso, Id da DPS e o IP nos registros de auditoria. Ficam em claro apenas códigos públicos (lista nacional de serviços, IBGE, NBS), situações, datas técnicas e identificadores internos.

**Excluir a conta destrói a chave:** a exclusão apaga o usuário no catálogo, e com ele a chave da conta, antes de apagar o arquivo. A partir desse momento, qualquer cópia antiga do arquivo da conta (num backup, por exemplo) fica ilegível. Backups antigos **do catálogo** ainda trazem a chave envelopada, então a retenção dos backups continua importante (`docs/07`).

O que a criptografia **não** cobre: o banco em uso fica acessível ao processo do servidor (que tem a chave mestra). Proteja o servidor, o disco (criptografia de volume) e a chave mestra.

## 10.3 Formas de entrar

O site oficial da NFS-e (Emissor Nacional) aceita entrar com conta gov.br, com certificado digital ou com login e senha. O Nota Sem Stress oferece as três.

| Forma | Como funciona aqui | O que o app guarda |
|---|---|---|
| **E-mail e senha** | Conta própria do Nota Sem Stress | E-mail e hash scrypt da senha |
| **gov.br** | Login Único (OpenID Connect): o app redireciona para o gov.br, a pessoa entra **no site do gov.br** e volta. O app confere o id_token assinado (chaves públicas do gov.br), o emissor, o destinatário, a validade e o nonce, com PKCE | O CPF cifrado e um índice cego. **Nunca** a senha do gov.br (o app não a vê) nem os tokens do gov.br |
| **Certificado digital** (e-CPF ou e-CNPJ, A1 ou A3) | O navegador apresenta o certificado no TLS de um host próprio (ex.: `certificado.seudominio.com.br`). O proxy repassa o certificado com um segredo, e o app confere a cadeia até uma AC Raiz da ICP-Brasil, a validade, a política ICP-Brasil e o CPF/CNPJ | O CPF ou CNPJ cifrado e um índice cego. A chave privada nunca sai do aparelho/token |

- O mesmo CPF entra pelo gov.br ou pelo e-CPF na **mesma conta**. O CNPJ entra pelo e-CNPJ.
- Uma conta pode ter várias formas de entrar. Em **Perfil › Formas de entrar, proteção e exclusão da conta** é possível vincular gov.br e certificado a uma conta de e-mail, e vice-versa. Um CPF/CNPJ que já entra numa conta não pode ser vinculado a outra.
- Contas criadas por gov.br ou certificado não têm senha. Para excluir a conta ou remover uma forma de entrar, elas precisam de uma entrada feita há menos de 10 minutos.
- As etapas intermediárias (o `state` do gov.br, o pedido e o ticket do certificado) são de uso único, expiram em minutos e ficam presas ao navegador que começou, por um cookie próprio. Isso impede que um link de login aberto por outra pessoa seja concluído.

> **Importante (regra oficial):** entrar no Nota Sem Stress com gov.br ou certificado **não autoriza emitir notas pela API da Receita**. A API da NFS-e exige que cada DPS seja assinada e enviada com o certificado A1 do emitente (TLS mútuo). Por isso o A1 continua sendo enviado no Perfil.

## 10.4 Como ligar em produção

**gov.br**

1. Solicite a integração do serviço ao Login Único do gov.br (credenciamento), informando o endereço de retorno `https://SEU_DOMINIO/api/conta/govbr/retorno`. O gov.br fornece `client_id` e `client_secret`, primeiro no ambiente de homologação (*staging*).
2. Configure `NOTAVEZ_APP_ORIGEM`, `NOTAVEZ_GOVBR_CLIENT_ID`, `NOTAVEZ_GOVBR_CLIENT_SECRET` e `NOTAVEZ_GOVBR_AMBIENTE=staging`. Depois de testar, passe a `producao` com as credenciais de produção.

**Certificado digital**

1. Baixe do site do ITI (AC Raiz) as cadeias oficiais da ICP-Brasil, confira os hashes publicados e grave tudo num arquivo PEM (ex.: `/etc/notavez/icp-brasil.pem`), com as raízes e as ACs intermediárias. Atualize quando o ITI publicar novas cadeias.
2. Crie o host `certificado.SEU_DOMINIO` no DNS e use o bloco correspondente do `ops/Caddyfile`.
3. Gere um segredo com 32+ caracteres aleatórios e use o **mesmo** valor em `NOTAVEZ_CERT_PROXY_SEGREDO` (app) e no ambiente do Caddy.
4. Configure `NOTAVEZ_CERT_LOGIN_ORIGEM=https://certificado.SEU_DOMINIO` e `NOTAVEZ_ICP_CADEIAS`.

Sem essas variáveis, os botões de gov.br e certificado não aparecem, e o login por e-mail e senha continua funcionando normalmente.

## 10.5 Migração de instalações anteriores

Na primeira inicialização desta versão, um banco único antigo é migrado automaticamente:

1. cada usuário ganha uma chave de conta;
2. os dados dele são copiados para o novo arquivo da conta, trocando a cifra do servidor pela cifra da conta e recalculando os índices cegos;
3. só então os dados são retirados do catálogo e as tabelas antigas são apagadas.

Uma migração interrompida recomeça do zero para aquele usuário. Notas de resultado incerto continuam na verificação periódica. **Faça um backup antes de atualizar** (`npm run backup`).

## 10.6 Testes

- `test/login.test.js`, com simuladores locais do gov.br e de uma cadeia ICP-Brasil fictícia:
  - PKCE, state e nonce de uso único, navegador trocado e token adulterado, de outro destinatário ou vencido;
  - certificado fora da ICP-Brasil, falsificado, sem política, vencido ou de AC; proxy sem segredo;
  - ticket de uso único, mesmo CPF por gov.br e e-CPF, vinculação, CPF de outra conta;
  - reautenticação de contas sem senha e limites de tentativas.
- `test/integridade-fiscal.test.js`: migração do banco único para bancos por conta.
- `test/emissao.test.js`: o catálogo central não tem tabelas de dados; o cliente e a nota de uma conta não existem no banco da outra; um dado cifrado de uma conta não abre com a chave de outra; nada em claro (CPF, CNPJ, nomes, IP).
- `test/conta.test.js` e `test/operacao.test.js`: a exclusão destrói a chave e apaga só o arquivo do titular; o backup copia o catálogo e os bancos de todas as contas.
- Navegador: `npm run test:web`. A entrada por gov.br foi testada no Chromium com o simulador (vai ao gov.br, volta, cria a conta pelo CPF e abre o Perfil).

**Ainda não testado com os serviços reais:** o Login Único do gov.br (exige credenciamento) e um certificado ICP-Brasil real atrás do Caddy. Faça os dois testes na homologação antes de anunciar essas formas de entrar.
