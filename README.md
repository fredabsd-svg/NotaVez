# NotaVez — NFS-e pelo celular

Web app instalável (PWA) para emitir a **NFS-e do Padrão Nacional** pelo celular: cadastro de clientes, serviços salvos, rascunhos (também sem internet), emissão com revisão, histórico e **"Clonar última nota"**. Emissão direta para **MEI**, **ME/EPP do Simples Nacional** e **Lucro Presumido/Real** (estes dois em município conveniado ao Sistema Nacional). Para não optantes, a nota já sai com PIS/COFINS, retenções federais e o grupo **IBS/CBS** exigido pelo Ato Conjunto RFB/CGIBS nº 4/2026.

> ⚠️ **Situação:** o MVP funciona de ponta a ponta contra uma Receita **simulada**, e 34 testes automatizados passam. **Ainda falta a primeira emissão no ambiente oficial de homologação**, que depende de um certificado A1 real (`docs/05`).

## Entregas

1. [Requisitos oficiais verificados e impedimentos](docs/01-requisitos-oficiais.md)
2. [Fluxo do usuário e protótipo das telas](docs/02-fluxo-e-prototipo.md)
3. [Modelo de dados e desenho da integração com a API](docs/03-dados-e-integracao.md)
4. **MVP funcional do PWA:** este repositório (`web/` + `server/`)
5. [Testes de emissão e rejeição (homologação)](docs/05-testes-homologacao.md)
6. [Plano para App Store e Google Play](docs/06-plano-apps-nativos.md)

## Como rodar

Requisitos: Node.js 22.13 ou mais recente (usa `node:sqlite`).

```bash
cd server
npm install
npm test          # 34 testes: regras MEI, ME/EPP e Presumido/Real, IBS/CBS, XSD oficial, assinatura, emissão, segurança
npm run demo      # app em http://localhost:8080 com a Receita SIMULADA (aviso fixo na tela)
```

O `npm run demo` mostra no terminal um CNPJ e um certificado **fictício** para testar o app inteiro.

### Produção (homologação primeiro)

```bash
export NOTAVEZ_MASTER_KEY=$(npm run -s gerar-chave)   # guarde num cofre/KMS; protege certificados e dados
export NOTAVEZ_DB=/dados/notavez.db
npm start                                             # ambiente padrão: produção restrita (testes da Receita)
# Só depois de homologar:
export NOTAVEZ_PRODUCAO_LIBERADA=1
```

Sirva atrás de HTTPS (proxy reverso). Variáveis úteis: `PORT`, `NOTAVEZ_TIMEOUT_SEFIN_MS` (30000), `NOTAVEZ_ESPERA_REENVIO_MS` (60000), `NOTAVEZ_C14N`, `NOTAVEZ_SERVIR_WEB=0` (para servir o PWA por uma CDN separada).

Teste no ambiente oficial: `npm run homologacao` (ver `docs/05`).

## Estrutura

```
web/                      PWA (HTML/CSS/JS sem etapa de build)
  js/views/               telas: início, clientes, serviços, nova nota, revisão, resultado, histórico, perfil, instalar
  js/store.js             IndexedDB: rascunhos offline e tabelas oficiais para busca sem internet
  sw.js                   service worker (só a "casca" do app; nunca dados da API)
server/
  src/fiscal/
    regras/               pacotes de regras por regime e vigência (MEI-2026, ME-EPP-2026, NAO-OPTANTE-2026)
    ibscbs.js             grupo IBS/CBS (opções oficiais dos Anexos VII e VIII)
    dps.js                gerador da DPS v1.01
    xsd/ + xsd.js         esquemas XSD oficiais e validação local
    assinatura.js         XMLDSig (RSA-SHA256)
    certificado.js        leitura e checagem do A1 ICP-Brasil
    sefin/                cliente mTLS + endereços dos ambientes
    emissao.js            máquina de estados: emitida | rejeitada | pendente (consulta antes de reenviar)
    mensagens.js          códigos oficiais → linguagem comum
  src/data/               tabelas geradas dos Anexos A, B e I (scripts/atualizar_tabelas.py)
  src/db/                 esquema e repositório (dados sensíveis cifrados)
  test/                   testes + Sefin simulada
  scripts/                demo, homologação, captura do protótipo, atualização de tabelas
docs/                     entregas 1 a 6 e imagens do protótipo
```

## Regras que o produto nunca quebra

- Só mostra **"Emitida"** com a chave de acesso devolvida pela Receita.
- Rascunho, simulação e envio pendente **nunca** aparecem como nota emitida.
- Resposta incerta → **consulta a Receita antes** de qualquer reenvio; o reenvio usa a **mesma DPS assinada**.
- Clonar gera **novos identificadores**: nunca reaproveita número, chave ou situação, e exige revisar competência, valor, descrição e tributação.
- **Não pede nem guarda a senha gov.br.** A emissão pela API exige o certificado A1 do próprio CNPJ.
