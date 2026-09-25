# 5. Testes de emissão e rejeição

> **Situação em 25/09/2026:** os testes automatizados (18) e o fluxo completo no navegador **passam** contra a Receita **simulada**. Os testes no **ambiente oficial de homologação (produção restrita) ainda não foram executados**, por dois motivos: faltava um certificado A1 real e a rede desta sessão não permite TLS mútuo (ver `docs/01`, seção 1.7). O roteiro abaixo está pronto para ser executado.

## 5.1 Testes automatizados (`cd server && npm test`)

Resultado da última execução: **18 aprovados, 0 falhas**.

**Unidade** (`test/unidade.test.js`):

- CPF e CNPJ, incluindo o CNPJ alfanumérico (exemplo oficial `12.ABC.345/01DE-35`).
- Valores em formato brasileiro (`1.234,56`).
- Id da DPS com 45 posições (TSIdDPS), para CNPJ e CPF.
- **A DPS do MEI passa no XSD oficial** e respeita E0121, E0600, E0583, E0710, E0174 e E0676.
- As regras MEI barram antes do envio: E0015, E0235, E0206, E0202, E0310, serviço com grupo "obra" e descrição acima de 1.000 caracteres.
- Escolha do pacote de regras: MEI 2026 aceito; ME/EPP e competência de 2027 bloqueados com explicação.
- Certificado A1: leitura, CNPJ no OID ICP-Brasil, senha errada, certificado vencido, CNPJ diferente do perfil; **assinatura XMLDSig verificada**, adulteração detectada e DPS assinada válida no XSD.
- Tradução das mensagens da Receita.

**Ponta a ponta** (`test/emissao.test.js`, API real + Sefin simulada com TLS mútuo que confere assinatura e XSD):

| Cenário | Resultado esperado e verificado |
|---|---|
| Sem certificado | Só rascunho; emitir → 403 com a lista de pendências; **nada chega à Sefin** |
| Perfil ME/EPP | Emissão bloqueada; rascunho permitido |
| Fluxo completo | cadastrar cliente → salvar serviço → rascunho (valor padrão do serviço) → validar → **emitida** com chave de 50 dígitos → XML oficial → nota emitida não pode ser editada nem reenviada → **clonar**: novo id, sem chave, sem DPS, `origemId`, campos a revisar → emitir sem conferir = 422 → conferir → emitida com **novo número de DPS e nova chave** |
| Rejeição oficial (E0082) | Situação **rejeitada**, sem chave, mensagem e próximo passo; ao corrigir, reenvia com **novo número** |
| Resposta perdida após processar | **Pendente**; "emitir de novo" bloqueado (409); verificar → consulta DPS → **emitida**; **um único POST** |
| Sem resposta e não processada | Pendente → consulta (404) → **reenvio byte a byte idêntico** → emitida |
| Erro 500 da Sefin | Pendente → consulta/reenvio → emitida |
| Rascunho criado sem internet | Sincroniza com o mesmo id; envio repetido é idempotente |
| Segurança | 401 sem login; 403 sem cabeçalho anti-CSRF; outra conta não vê notas nem clientes (404); **CPF, CNPJ e nome não aparecem em claro no banco**; limite de tentativas de login (429) |
| Certificado de outro CNPJ | Recusado com explicação |

**Interface no navegador** (`server/scripts/fluxo-navegador.mjs`, Chromium a 390×844, modo demonstração): percorre as 19 telas do `docs/02` (cadastro, perfil, certificado, cliente, serviço, nova nota, revisão, emitida, clonada, rejeitada, pendente → confirmada, histórico, detalhe, rascunho sem internet, instalação) sem erros de JavaScript.

## 5.2 Roteiro no ambiente oficial de produção restrita

Pré-requisitos:

1. Certificado **A1 ICP-Brasil e-CNPJ de um MEI** (arquivo `.pfx`/`.p12`) e a respectiva senha.
2. Máquina com **acesso direto** a `sefin.producaorestrita.nfse.gov.br` (sem proxy que termine o TLS).
3. Código IBGE do município do CNPJ (Anexo A ou `server/src/data/municipios.json`).

Execução:

```bash
cd server && npm install
NOTAVEZ_CERT_PFX=/caminho/certificado.pfx \
NOTAVEZ_CERT_SENHA='senha' \
NOTAVEZ_MUNICIPIO_IBGE=3550308 \
NOTAVEZ_TOMADOR_CPF=52998224725 NOTAVEZ_TOMADOR_NOME='Tomador Teste' \
npm run homologacao
```

O script usa sempre `tpAmb = 2` (sem validade jurídica), a série 900 e números de DPS derivados do horário, para não colidir com execuções anteriores. Ele grava o XML e um relatório `.md` em `server/homologacao-saida/`.

| Caso | Esperado |
|---|---|
| 1. Emissão válida (MEI, serviço 010101, R$ 10,00) | `emitida` com chave de acesso |
| 2. `GET /dps/{id}` | `encontrada`, mesma chave |
| 3. `GET /nfse/{chave}` | XML com `cStat` (107 = NFS-e MEI) |
| 4. Reenvio da mesma DPS | **E0014** (duplicidade) — comprova a proteção contra nota em dobro |
| 5. DPS de MEI com alíquota | **Rejeição E0600** |
| 6. Competência futura | **Rejeição E0015** |

Depois, repetir pelo app. Para isso, ligar o servidor com `NOTAVEZ_MASTER_KEY` definida, enviar o certificado em Perfil e emitir uma nota. Anotar o resultado e o relatório no pull request.

### O que confirmar na primeira execução real

- Se a produção restrita aceita o certificado de um contribuinte no `POST /nfse` (ambiguidade entre os manuais, `docs/01` §1.3).
- A URL-base (`/SefinNacional` ou `/API/SefinNacional`) e os nomes dos campos JSON. Ajustar em `server/src/fiscal/sefin/ambientes.json` e em `cliente.js`, se preciso.
- A C14N aceita na assinatura (padrão: C14N inclusiva; alternativa via `NOTAVEZ_C14N=http://www.w3.org/2001/10/xml-exc-c14n#`).
- A URL da Consulta Pública na produção restrita.

## 5.3 Critérios de pronto do MVP

| Critério | Situação |
|---|---|
| Usuário elegível cadastra cliente | ✅ testado (API e navegador) |
| Salva um serviço | ✅ testado |
| **Emite uma NFS-e no ambiente oficial de testes** | ⏳ **pendente**: exige certificado real e rede com TLS mútuo (roteiro 5.2) |
| Consulta o resultado | ✅ testado com a Sefin simulada (consulta DPS/NFS-e) |
| Clona uma nota como novo rascunho | ✅ testado (novos ids, revisão obrigatória) |
| Distingue rascunho, envio pendente, rejeição e emissão confirmada | ✅ testado (máquina de estados + telas) |

O MVP só deve ser considerado **pronto** depois que o roteiro 5.2 passar no ambiente oficial.
