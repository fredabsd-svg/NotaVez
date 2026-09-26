# 1. Requisitos oficiais verificados e impedimentos encontrados

> Pesquisa feita em **25/09/2026**. Cada item cita o documento oficial de onde veio. O que não veio de fonte oficial está marcado como **não verificado**.

## 1.1 Fontes consultadas (Portal Nacional da NFS-e)

| Documento | Versão / data | Onde |
|---|---|---|
| Documentação atual (produção) | página consultada em 25/09/2026 | gov.br/nfse › Biblioteca › Documentação técnica › Documentação Atual |
| APIs – Produção Restrita e Produção | página consultada em 25/09/2026 | gov.br/nfse › … › APIs - Prod. Restrita e Produção |
| API – Manual de Contribuintes – Emissor Público | v1.2 (out/2025; histórico v1.0 de 17/03/2025) | Documentação atual |
| API – Manual de Contribuintes – APIs do ADN | v1.0 (12/02/2026) | Documentação atual |
| ANEXO_I-SEFIN_ADN-DPS_NFSe (leiautes e regras de negócio) | v1.01-20260209 | Documentação atual e Produção restrita |
| ANEXO_A (municípios IBGE / países) | v1.00-20251210 | Documentação atual |
| ANEXO_B (lista nacional de serviços / NBS) | v1.01-20260122 | Documentação atual |
| Esquemas XSD | produção: v1.01-20260209 · produção restrita: **esquemas-nfse-rtc-v1-01-20260727** (usado pelo NotaVez) | Documentação atual / Produção restrita |
| Nota Técnica 008 (especificações do DANFSe) | v1.02 (14/07/2026) | Documentação técnica › RTC |
| Notas Técnicas 004 (v2.00, 10/12/2025), 005 e 007 (07/02/2026) — leiaute RTC (IBS/CBS) | — | Documentação técnica › RTC |
| Anexo VI (leiautes e RN do RTC, v1.03.00 — NT 007), Anexo VII (cIndOp, v1.02.00), Anexo VIII (item × NBS × cIndOp × cClassTrib, v1.01.00) | — | Documentação técnica › RTC |
| Notícia SE/CGNFS-e "CGNFS-e orienta sobre os prazos para destaque de IBS/CBS" (Ato Conjunto RFB/CGIBS nº 4/2026) | consultada em 26/09/2026 | gov.br/nfse › Notícias |
| Notícia "CGSN prorroga a obrigatoriedade de emissão… pelo Emissor Nacional" (Resolução CGSN nº 191/2026) | consultada em 26/09/2026 | gov.br/nfse › Notícias |
| Atualizações e Implantações | entradas de 13/03 a 10/08/2026 | Documentação técnica |

Os arquivos oficiais de que o código depende estão versionados no repositório: XSD em `server/src/fiscal/xsd/`; tabelas geradas dos Anexos A, B e I em `server/src/data/` (script `server/scripts/atualizar_tabelas.py`).

## 1.2 Como funciona a emissão pela API (Emissor Público Nacional / Sefin Nacional)

Fonte: *Manual de Contribuintes – Emissor Público*, seções 1.3 a 1.5.

| Método | Endpoint | Uso no NotaVez |
|---|---|---|
| `POST /nfse` | Recebe a DPS assinada. Processamento **síncrono**: devolve o XML da NFS-e ou os motivos da rejeição | Emissão |
| `GET /nfse/{chaveAcesso}` | Consulta a NFS-e pela chave de acesso | Obter o XML oficial |
| `GET /dps/{id}` | Devolve a chave de acesso gerada a partir de uma DPS. **Só responde se o certificado da conexão for de um ator da nota** (prestador, tomador ou intermediário) | Consulta **antes** de reenviar um envio com resposta incerta |
| `HEAD /dps/{id}` | Informa se a DPS gerou NFS-e (qualquer certificado válido) | Alternativa para a consulta |
| `POST/GET /nfse/{chave}/eventos` | Eventos (cancelamento, substituição…) | Versão futura |
| `GET /parametros_municipais/...` | Alíquotas, benefícios e retenções municipais | Necessário para atender ME/EPP (futuro) |

Ambientes (página *APIs – Prod. Restrita e Produção*):

| | Produção restrita (homologação/testes) | Produção |
|---|---|---|
| Sefin Nacional (Swagger) | `https://sefin.producaorestrita.nfse.gov.br/API/SefinNacional/docs/index` | `https://sefin.nfse.gov.br/SefinNacional/docs/index` |
| ADN / DANFSe / Parâmetros | `https://adn.producaorestrita.nfse.gov.br/...` | `https://adn.nfse.gov.br/...` |

Regra E0006: o campo `tpAmb` (1 = produção, 2 = homologação) precisa corresponder ao ambiente chamado.

## 1.3 Credenciamento, acesso e certificado

1. **Os manuais não preveem cadastro nem credencial própria (chave de API) para o contribuinte.** A identificação e a autorização vêm do **certificado digital usado na conexão TLS** (TLS mútuo). As regras da aba `RN_RECEPCAO_DPS` (Anexo I) validam o *certificado de transmissão*:
   - E1200 inválido (exige versão 3, não pode ser certificado de AC, precisa de *Autenticação Cliente*);
   - E1203 vencido; E1205 cadeia não cadastrada na RFB; E1206 LCR; E1207 revogado;
   - **E1208 raiz diferente de ICP-Brasil**; **E1209 sem a extensão de CNPJ/CPF (OID 2.16.76.1.3.3)**.
   - Na prática: ao conectar nos servidores da produção restrita, o servidor **pediu certificado de cliente** já na negociação TLS.
2. **Assinatura da DPS** (aba `RN DPS_NFS-e`, regras 642 a 646):
   - E0717: a assinatura é **obrigatória** no envio pela API;
   - E0714: a assinatura precisa ser válida; E0715/E0716: certificado ICP-Brasil, versão 3, com *Assinatura Digital* e *Não Recusa*, e com o OID de CNPJ (2.16.76.1.3.3) ou de CPF (2.16.76.1.3.1);
   - **E0718: "A assinatura deve ser feita com o certificado digital do emitente da DPS".**
3. **O login gov.br NÃO autoriza o uso da API.** Nenhum documento da API prevê autenticação por gov.br: a API autentica pelo certificado ICP-Brasil. O login gov.br dá acesso ao **Emissor Nacional** (site e app oficiais), não a aplicativos de terceiros. O NotaVez **nunca pede nem guarda senha gov.br**.
4. **Ambiguidade encontrada:** o manual do Emissor Público (item 1.6) diz que o Swagger da produção restrita é "destinada a testes por parte dos municípios conveniados"; já o manual do ADN (item 1.2) diz "destinada a testes por parte dos contribuintes". **É preciso confirmar na primeira rodada de homologação** se a produção restrita aceita o certificado de um contribuinte no `POST /nfse` (roteiro em `docs/05`).

## 1.4 Leiaute e regras que afetam o MEI

Leiaute da DPS v1.01 (`DPS_v1.01.xsd`). O produto aplica estas regras **antes do envio** (`server/src/fiscal/regras/mei-2026.js`):

| Regra | Exigência | O que o NotaVez faz |
|---|---|---|
| E0121 | Com `tpEmit = 1`, **não** informar o nome do prestador | Omite `prest/xNome` |
| E0174 / E0162 | MEI: `regEspTrib = 0`; sem `regApTribSN` | Valores fixos no pacote de regras |
| E0583 | MEI: sem retenção de ISS (`tpRetISSQN = 1`) | Valor fixo |
| E0600 | MEI: **não** informar alíquota (`pAliq`) | Omite o campo |
| E0676 | MEI: sem tributos federais | Omite `tribFed` |
| E0710 / E1302 | MEI: sem `pTotTribSN` nem valores além dos permitidos | Usa `totTrib/indTotTrib = 0` |
| E0015 | Competência ≤ data de emissão | Bloqueia datas futuras |
| E0041 | Município emissor = município do CNPJ do MEI | O perfil pede o "município do seu CNPJ" |
| E0010 | Faixa de série: **00001 a 49999 = aplicativo próprio** (50000–69999 móvel, 70000–79999 web, 80000–89999 transcrição) | Série padrão 1, limitada a 1–49999 |
| E0014 | Série + número + município + CNPJ já usados ⇒ rejeição | Numeração por CNPJ, nunca reutilizada |
| E0080 / E0188 / E0206 | Dígitos verificadores de CNPJ/CPF (emitente e cliente) | Validação local, inclusive do **CNPJ alfanumérico** (em produção desde 10/08/2026) |
| E0235 | Cliente identificado por CNPJ ⇒ endereço nacional obrigatório | Exige o endereço |
| Anexo I (MUN.INCID) | Serviços cujo ISS é devido no local da prestação ou no endereço do cliente | Mostra o "local da prestação" ou exige endereço só quando necessário |
| Anexo I (grupos obra/atvEvento) | 32 serviços exigem dados de obra ou de evento | Bloqueia esses serviços e indica o Emissor Nacional |
| Leiaute | `xDescServ` com até 1.000 caracteres | Conta os caracteres e bloqueia o excesso |
| E1228 / E1229 / E1225 | Sem prefixo de namespace, UTF-8, GZip + Base64 | Garantido pelo gerador |
| IBS/CBS | "Para optantes dos Simples Nacional, os grupos IBSCBS só serão obrigatórios a partir de 2027" (Anexo I, leiaute) | Omite os grupos até 31/12/2026; **competências de 2027 em diante ficam bloqueadas** até a atualização das regras |

### 1.4.1 Regras para ME/EPP do Simples Nacional (`opSimpNac = 3`)

Pacote `server/src/fiscal/regras/me-epp-2026.js`, conferido regra a regra na aba `RN DPS_NFS-e` do Anexo I:

| Regra | Exigência | O que o NotaVez faz |
|---|---|---|
| E0166 / E0162 | `regApTribSN` obrigatório para ME/EPP: 1 = federais e ISS pelo Simples; 2 = federais pelo Simples e ISS fora; 3 = tudo fora do Simples | O perfil pergunta, em linguagem comum, como a empresa paga os tributos |
| E0175 | Com `regApTribSN = 1`, `regEspTrib = 0` | Valor fixo |
| E0712 | ME/EPP **não** pode usar `indTotTrib` | Envia `totTrib/pTotTribSN` (percentual aproximado do Simples, informado no perfil e ajustável por nota) |
| E0621 / E0628 | `regApTribSN = 1` **com** ISS retido ⇒ alíquota obrigatória, **mínimo 1,8%** | A alíquota aparece só quando o cliente retém; o padrão vem do perfil |
| E0625 / E0631 | `regApTribSN = 1` **sem** retenção ⇒ alíquota proibida | Não envia a alíquota |
| E0635 | `regApTribSN = 2/3` e município de incidência **conveniado** ⇒ alíquota proibida (a Sefin usa a parametrização municipal) | Consulta o convênio; se ativo, não envia a alíquota |
| E0640 | `regApTribSN = 2/3` e município de incidência **não** conveniado ⇒ alíquota obrigatória | Pede a alíquota do município |
| E0595 | Alíquota nunca acima de 5% | Bloqueia |
| E0204 | Retenção exige tomador identificado | Bloqueia |
| E0667 | Retenção por tomador **pessoa física** só se o município autorizar | Nesta versão, retenção só com cliente CNPJ |
| E0037 / E0038 / E0039 | Fora do MEI, o município emissor precisa ser conveniado, ativo e usar os emissores nacionais | Consulta o convênio (API de Parâmetros Municipais) e, se não houver, explica que a nota deve ser emitida no sistema da prefeitura |
| E0116 / E0120 / E0119 | Inscrição municipal: obrigatória se houver cadastro complementar (CNC) no município; proibida se não houver | O perfil explica quando preencher; as mensagens de rejeição orientam |

Município de incidência (para E0635/E0640 e E0617/E0619): calculado pela regra do Anexo I (MUN.INCID_INFO.SERV.): estabelecimento do prestador, local da prestação ou endereço do tomador, conforme o serviço.

### 1.4.2 Regras para Lucro Presumido e Lucro Real (não optante, `opSimpNac = 1`)

No leiaute da NFS-e, Presumido e Real são o mesmo regime ("Não Optante"); as diferenças estão nos valores de PIS/COFINS. Pacote `server/src/fiscal/regras/nao-optante-2026.js`:

| Regra | Exigência | O que o NotaVez faz |
|---|---|---|
| E0617 / E0619 | Alíquota do ISS proibida com convênio do município de incidência ativo; obrigatória sem convênio | Consulta o convênio; usa a alíquota da nota ou a do perfil |
| E0162 | Sem `regApTribSN` | Não envia |
| E0713 | Sem `indTotTrib` e `pTotTribSN` | Envia `pTotTrib` (federal/estadual/municipal, Lei 12.741/2012) do perfil |
| E0678, E0684, E0690, E0694, E0696, E0682 | PIS/COFINS da apuração própria: CST, base, alíquotas e valores = base × alíquota (tolerância de R$ 0,01, arredondamento bancário — NT 007); CST 00/08/09 sem base | Monta o grupo `piscofins` com CST e alíquotas do perfil (01, 06, 08 ou 09) |
| NT 007 + E0698, E0720, E0724 | **Retenções de PIS, COFINS e CSLL somadas em `vRetCSLL`**, com `tpRetPisCofins` (0 e 3–9; 1 e 2 serão suprimidos); `vPis`/`vCofins` nunca recebem valores retidos | Caixas "PIS/COFINS/CSLL retidos" + valor somado; calcula o código de retenção |
| E0699, E0700, E0701 | CP, IRRF e CSLL retidos > 0 e < valor do serviço | Valida; só para cliente CNPJ |
| E0595, E0204, E0667 | Alíquota ≤ 5%; retenção de ISS exige tomador identificado, CPF só com autorização municipal | Como no ME/EPP |

### 1.4.3 IBS/CBS na DPS (não optantes)

- **Obrigatoriedade:** a NT 004 (10/12/2025) suspendeu a validação de obrigatoriedade dos grupos IBS/CBS ("facultativos"). A orientação da SE/CGNFS-e sobre o **Ato Conjunto RFB/CGIBS nº 4/2026** fixa: serviços da LC 116 em geral a partir de **01/10/2026**; subitens 1.03, 1.05, 1.09 e 16.01, plataformas digitais, bens imateriais, condomínios e locações a partir de **01/12/2026**; optantes do Simples que optarem pelo destaque em set/2026, a partir de **01/01/2027**. **Até 31/12/2026 a ausência não gera rejeição, mas deixa o documento em desconformidade, sujeito a sanções.** Por isso o NotaVez informa o grupo em **todas** as notas de não optante (permitido desde 01/01/2026, regra E0850).
- **Na DPS o grupo é declarativo:** `finNFSe` (0), `indFinal` (uso ou consumo pessoal, art. 57 da LC 214/2025), `cIndOp`, `indDest` (0 = destinatário é o tomador) e `gIBSCBS` (CST + `cClassTrib`). Base, alíquotas e valores são calculados pela Sefin (calculadora oficial). A NBS passa a ser obrigatória (E0322), e os 3 primeiros dígitos do `cClassTrib` devem ser o CST (E0959).
- **Tabelas oficiais:** as opções vêm do Anexo VIII (980 NBS em 203 itens da LC 116, lidas com as células mescladas expandidas) e só incluem `cIndOp` existentes no Anexo VII (o Anexo VIII cita um código, 050104, que não consta no Anexo VII e foi descartado).
- **Não suportado nesta versão, com bloqueio e explicação:** operações com imóveis (`cIndOp` 020101/020201/020301 exigem o grupo `imovel` — Anexo VI, regras 591–593); tomador/destinatário diferente ou no exterior; grupos `gTribRegular` e `gDif` (dependem de indicadores da tabela de cClassTrib que não estão nos anexos da NFS-e — se a classificação escolhida exigir, a Sefin rejeita com E0965/E0972 e o app explica).

**Regras municipais:** várias regras (E0016, E0037–E0039, E0119, E0312, E0314) valem "**exceto quando o emitente da DPS for MEI**". Por isso o MEI pode emitir pelo sistema nacional mesmo em municípios sem convênio ou sem parametrização. Para os demais prestadores essas regras valem integralmente: convênio, CNC/inscrição municipal, alíquotas, benefícios e retenções via `parametros_municipais`. Por isso, fora do MEI, o NotaVez consulta o convênio municipal antes de emitir e só libera a emissão em município conveniado.

## 1.5 DANFSe e documentos

- **API do DANFSe desativada:** "Desativação da API do DANFSe do ADN (versão 1.0)" em **03/08/2026** (*Atualizações e Implantações*). A NT 008 determina que o DANFSe seja gerado pelo software emissor, seguindo o modelo que ela especifica.
- O QR Code do DANFSe aponta para `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=<chave>` (NT 008, item 2.4.3). O DANFSe de produção restrita deve trazer "NFS-e SEM VALIDADE JURÍDICA".
- **No MVP:** depois da confirmação oficial, o NotaVez mostra a **chave de acesso**, oferece o **XML oficial da NFS-e** (como devolvido pela Sefin) e o link da **Consulta Pública**, onde o portal gera o DANFSe. A geração do DANFSe dentro do NotaVez, conforme a NT 008, está no roteiro.

## 1.6 Perfis que podem emitir diretamente pelo NotaVez

| Perfil | Emite direto? | Por quê | O que o app faz |
|---|---|---|---|
| **MEI com e-CNPJ A1 (ICP-Brasil) do próprio CNPJ, dentro da validade** | **Sim** | Atende E1200–E1209 e E0714–E0718 | Emite em homologação; a produção depende de liberação no servidor |
| MEI só com login gov.br | Não | A API não aceita gov.br; exige certificado ICP-Brasil | Rascunhos + lista "o que falta" + orientação para usar o Emissor Nacional |
| MEI com certificado A3 (cartão ou token) | Não (MVP) | O servidor não tem acesso ao token físico | Rascunhos. Futuro: certificado em nuvem (PSC) com assinatura remota |
| MEI só com o e-CPF do titular | Não suportado | A E0718 exige o certificado do emitente; não há garantia de aceite de e-CPF para emitente CNPJ | Recusa o envio do certificado e explica o motivo |
| Contador ou procurador emitindo por um cliente | Não suportado | A assinatura tem de ser do emitente (E0718); a API não tem mecanismo de delegação | Futuro: vários perfis por conta, cada um com o seu certificado |
| **ME/EPP do Simples com e-CNPJ A1**, em município **conveniado** ao Sistema Nacional | **Sim** | Regras 1.4.1; convênio consultado na API de Parâmetros Municipais | Emite; retenção de ISS só com cliente CNPJ |
| ME/EPP em município **não** conveniado | Não | E0037–E0039: fora do MEI, o sistema nacional só atende municípios conveniados | Rascunhos + orientação para o sistema da prefeitura |
| **Lucro Presumido / Lucro Real** (não optante) com e-CNPJ A1, em município conveniado | **Sim** | Regras 1.4.2 e 1.4.3 | Emite com PIS/COFINS, retenções federais e grupo IBS/CBS |
| Não optante com serviço que exige dados de imóvel, obra ou evento | Não | Grupos ainda não suportados | Rascunho + orientação para o Emissor Nacional |

## 1.7 Impedimentos encontrados (na data de hoje)

1. **Não havia certificado real disponível nesta sessão.** Por isso os testes no ambiente oficial **não foram executados**. O script está pronto (`npm run homologacao`, ver `docs/05`).
2. **A rede desta sessão** passa por um proxy que termina a conexão TLS: as chamadas a `sefin.producaorestrita.nfse.gov.br` voltaram **HTTP 503**, o que torna o TLS mútuo impossível daqui. É preciso rodar a partir de um servidor com saída direta para a internet.
3. **O Swagger da Sefin exige certificado.** Por isso a URL-base exata (`/SefinNacional` ou `/API/SefinNacional`) e os nomes dos campos JSON (`dpsXmlGZipB64`, `chaveAcesso`, `nfseXmlGZipB64`, `erros[{codigo, descricao, complemento}]`) foram **conferidos em bibliotecas de código aberto** que implementam a API, e não no Swagger. Tudo é ajustável em `server/src/fiscal/sefin/ambientes.json` e no cliente, sem mexer no restante do código.
4. **URL da Consulta Pública na produção restrita:** não confirmada (a conexão foi reiniciada). A URL de produção foi confirmada (HTTP 200).
5. **Produção restrita para contribuintes:** ver a ambiguidade do item 1.3 (4).
6. **API de Parâmetros Municipais:** o host (`adn…/parametrizacao`) está na página oficial de APIs, mas as rotas (`/{municipio}/convenio`, `/{municipio}/{servico}/{competencia}/aliquota`) e o formato das respostas vieram de bibliotecas de código aberto: o Swagger exige certificado. Estão configuráveis em `ambientes.json`. Se a consulta falhar, o NotaVez **não supõe nada**: para ISS fora do Simples, pede para tentar de novo; nos demais casos, a Sefin valida o convênio no envio.
7. **2027:** grupos IBS/CBS obrigatórios para o Simples, CBS plena e fim do PIS/COFINS para os demais: competências de 2027 ficam bloqueadas até um novo pacote de regras.
7a. **E0680 × E0677:** o Anexo VI (NT 007) diz que a base do PIS/COFINS deve ser "menor que" o valor do serviço (E0680), enquanto a E0677 diz "menor **ou igual**". O NotaVez usa base = valor do serviço (caso usual); confirmar na homologação.
7b. **Simples Nacional:** a obrigatoriedade do Emissor Nacional para optantes foi adiada para **01/11/2026** (Resolução CGSN nº 191/2026).
8. **NT 009 (leiaute 1.04):** publicada, mas ainda sem vigência segundo a página oficial; acompanhar.
9. Informações encontradas **fora das fontes oficiais e não verificadas** (por exemplo, prazos de obrigatoriedade do Emissor Nacional para o Simples e tolerância do IBS/CBS até 31/12/2026 para não optantes) **não** foram usadas em nenhuma decisão do produto.
