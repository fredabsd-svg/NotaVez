# 10 · Backup e restauração de dados

Conta › **Backup e Restauração**. Cada conta gera, baixa e restaura uma cópia completa e cifrada dos próprios dados. A prioridade foi a **integridade**: nada é dado como pronto antes de conferido, e uma restauração que falha não muda nada.

## 1. Análise que orientou o desenho

| Pergunta | Resposta no Nota Sem Stress |
|---|---|
| Onde ficam os dados? | Num único PostgreSQL (Neon na Vercel; PGlite nos testes e no modo local). Não há arquivos fora do banco: o PDF (DANFSe) é gerado na hora a partir do XML oficial, e os certificados A1 ficam no banco. |
| O que é sensível? | Certificados (PFX e senha), CPF/CNPJ, dados de clientes, XML das notas, chave da API de IA e conversas: cifrados com AES-256-GCM e a **chave mestra do servidor** (`NOTAVEZ_MASTER_KEY`). As buscas por CPF/CNPJ/chave usam **índices cegos** (HMAC) derivados da mesma chave. |
| Quantos usuários? | Vários: contas separadas no mesmo banco. O backup é **por conta** e nunca toca em outra conta. |
| O que não pode voltar atrás? | A **numeração das DPS** (um número já usado na Receita não pode ser reusado) e o **histórico de auditoria**. |
| Limites da plataforma | Vercel: no máximo 4,5 MB por requisição e por resposta e 300 s por chamada. Plano Hobby: logs de 30 min. |
| Riscos de perda | Restauração parcial; arquivo corrompido ou adulterado; senha esquecida; backup que "parece" pronto mas não abre; chave mestra trocada (reinstalação), que tornaria inúteis cópias que dependessem dela; duas operações ao mesmo tempo; restauração que reduz a numeração das DPS. |

**Estratégia escolhida:** cópia lógica por conta, **portátil**. Os campos saem decifrados *dentro* do arquivo, e o arquivo inteiro é cifrado com uma senha escolhida pelo usuário. Na restauração, tudo é cifrado de novo com a chave do servidor que restaura e os índices de busca são recalculados. Assim o backup serve até para um servidor reinstalado com outra chave.

## 2. O que entra e o que não entra

**Entra** (tudo o que reconstrói o estado da conta): empresas e parâmetros fiscais; certificados das empresas e do escritório (procuração); clientes; serviços; notas (rascunhos, situação, DPS assinada, XML da NFS-e, erros e alertas); notas tomadas com o XML; posição da leitura no Ambiente de Dados Nacional (NSU); configuração do assistente de IA (inclusive a chave de API) e conversas; e-mail das notas (configuração de envio, inclusive a senha do SMTP, e o histórico dos e-mails enviados com cada nota); numeração das DPS dos emitentes da conta; auditoria.

**Não entra:** identidade e acesso (e-mail, senha, gov.br, sessões, aparelhos confiáveis, códigos de recuperação), caches públicos, limites de requisição e registros técnicos de chamadas à API oficial. A restauração **não troca** o login da conta.

O teste `o backup cobre todas as colunas das tabelas da conta` falha se alguém criar uma coluna nova sem regra de backup. Com isso, a geração de backup também passa a recusar (código `BACKUP_COBERTURA`), em vez de produzir uma cópia incompleta.

## 3. Arquivo `.nsbackup`

Um JSON com cabeçalho legível e conteúdo cifrado:

```
{ "tipo": "nota-sem-stress/backup", "formato": 1, "criadoEm": "...", "app": "0.1.0", "esquema": 2,
  "kdf": { "nome": "scrypt", "N": 32768, "r": 8, "p": 1, "sal": "..." },
  "cifra": { "nome": "aes-256-gcm", "iv": "..." }, "compressao": "gzip",
  "conteudo": { "bytes": ..., "comprimido": ..., "sha256": "..." },
  "verificador": "...", "tag": "...", "dados": "..." }
```

- **Chave:** scrypt(senha, sal), N = 2¹⁵ (32 MiB de memória por tentativa). A senha precisa ter **10 caracteres** ou mais e **nunca é guardada**.
- **Integridade em camadas:**
  1. A tag do AES-256-GCM autentica o conteúdo cifrado **e o cabeçalho inteiro**, que entra como AAD.
  2. O SHA-256 confere o conteúdo depois de descompactado.
  3. O manifesto interno traz quantidade de linhas e SHA-256 de cada tabela.
  4. O SHA-256 do arquivo inteiro é guardado no servidor e conferido no aparelho a cada download e envio.
- **Senha errada × arquivo corrompido:** o verificador (HMAC da chave derivada) distingue os dois casos sem decifrar nada.
- **Limites defensivos:** arquivo de até 150 MB e conteúdo descompactado de até 400 MB (proteção contra bomba de descompressão). Parâmetros de custo fora da faixa são recusados antes de derivar a chave (proteção contra negação de serviço).

## 4. Criar backup

1. Trava da conta: um backup ou uma restauração por vez. Se o processo cair, a trava se libera sozinha em 15 min.
2. Retrato **consistente**: a conta inteira é lida numa única transação SERIALIZABLE. Cada índice cego gravado é comparado com o recalculado, e divergências viram aviso.
3. O arquivo é gerado e cifrado.
4. **Verificação antes de dizer "pronto":** o servidor abre o arquivo como numa restauração (senha, tag, SHA-256, manifesto, tipos, referências e unicidade) e confere as contagens.
5. O arquivo é guardado em partes de cerca de 1,9 MB, cada parte cifrada **também** com a chave do servidor. Quem tiver acesso só ao banco nem consegue tentar adivinhar a senha fora do app. Depois o servidor **relê** as partes e confere o SHA-256.
6. O aparelho baixa as partes, confere o SHA-256 do arquivo montado e só então entrega ao navegador para salvar. Em seguida avisa o servidor, que registra "baixado e conferido".

Gerar backup não altera nenhum dado. Isso é provado em teste: a fotografia da conta antes e depois é a mesma.

## 5. Restaurar

1. O arquivo sobe em partes e o servidor confere tamanho e SHA-256 do arquivo inteiro.
2. **Conferir** (nada é alterado): senha, tag GCM, SHA-256, versão, manifesto, tipos, referências, unicidade e conflitos com **outras contas** do servidor. A tela mostra:
   - empresas e contagens do backup comparadas com as atuais;
   - notas que estão no app agora e não estão no backup;
   - empresas que sairiam da conta;
   - envios em aberto.
3. **Confirmação explícita:** marcar a caixa e digitar `RESTAURAR`.
4. O servidor confere tudo de novo e recusa se houver nota sendo enviada à Receita naquele momento.
5. **Backup de segurança** do estado atual, com a mesma senha, verificado e guardado **antes** de qualquer mudança. Se ele falhar, a restauração é cancelada.
6. Numa **única transação**:
   - apaga só os dados desta conta;
   - insere o backup (cifrando de novo com a chave do servidor e recalculando os índices);
   - leva a numeração das DPS só para cima (`GREATEST`);
   - **soma** a auditoria do backup à atual, sem apagar histórico;
   - **relê a conta e compara, tabela por tabela, com o backup**;
   - só então faz o COMMIT.

   Qualquer erro, divergência ou queda no meio desfaz tudo (rollback). Os dados atuais ficam exatamente como estavam.
7. Resultado com as contagens restauradas e o atalho para baixar o backup de segurança.

Regra obrigatória atendida: **nada é apagado antes de o arquivo ser validado e o backup de segurança estar guardado e conferido**, e a troca é atômica.

## 6. Histórico e retenção

O servidor guarda o **arquivo** dos 5 backups manuais mais recentes (configurável em `NOTAVEZ_BACKUPS_GUARDADOS`) e dos 3 últimos backups de segurança. Arquivos enviados para restaurar ficam guardados por 24 h. Os registros mais antigos continuam no histórico, sem o arquivo. A tela mostra data, versão, tamanho, SHA-256 e as marcas "conferido", "baixado" e "restaurado". Cada item do histórico pode ser baixado, restaurado ou excluído.

## 7. Segurança e confiabilidade

- **Escopo e acesso:** só a própria conta enxerga e usa os seus backups (outra conta recebe 404). Tudo exige sessão; operações de escrita exigem o cabeçalho anti-CSRF.
- **Limites de uso:** 10 backups por hora; 30 conferências ou restaurações por hora, para frear tentativas de adivinhar a senha.
- **Sigilo:** a senha vai só no corpo da requisição, que o servidor não registra em log, e não fica no banco nem na auditoria. O arquivo não contém nada sensível em claro (comprovado em teste).
- **Trava por conta:** impede operações simultâneas. Restaurações de contas diferentes não se misturam: o teste "conta A × conta B" comprova.
- **Conflito com outra conta:** se os dados do backup já existem em outra conta do servidor (a conta de origem ainda existe), a restauração é recusada antes de começar (`BACKUP_CONFLITO`).
- **Relacionamentos preservados:** os identificadores originais são mantidos, e as chaves estrangeiras e os índices únicos do banco continuam valendo dentro da transação.

## 8. Testes (`server/test/backup.test.js`)

| Exigência | Teste | O que comprova |
|---|---|---|
| 1. Backup de dados representativos | `1-3)` | Conta com 2 empresas (MEI com A1 e Simples por procuração), nota emitida na Receita simulada (DPS + NFS-e), rascunho, nota emitida fora do app, 2 tomadas (1 cancelada), posição do ADN, certificado do escritório, assistente com chave e conversa, auditoria. |
| 2. Restauração em ambiente isolado | `1-3)` e `2)` | **Outro processo, outro banco e outra chave mestra**, numa conta nova, com envio em partes pela API. No mesmo servidor, depois de apagar e alterar dados, tudo volta e o app emite uma nota nova. |
| 3. Comparação | `1-3)`, `2)`, `8)` | Fotografia **independente do código de backup**: tabela por tabela, campo por campo (decifrado), ordem das notas. Também: XML oficial idêntico (SHA-256), DANFSe gerado, índices de busca recalculados, cadastro repetido barrado, certificado utilizável e número de DPS novo acima do último usado. |
| 4. Arquivo corrompido | `4/7)` | Bit trocado no conteúdo; cabeçalho adulterado; arquivo pela metade; senha errada; arquivo que não é backup; SHA-256 declarado diferente; conteúdo alterado e cifrado de novo (manifesto não confere); referência quebrada; envio com parte faltando; restauração sem confirmação. |
| 5. Interrupção na restauração | `5/7)` e `5) queda REAL` | Falha simulada no meio da inserção das notas (depois de apagar e inserir as outras tabelas) e divergência injetada antes da conferência final: rollback total; depois, a trava está livre e o backup de segurança devolve o estado anterior. **Queda real (só com PostgreSQL):** um segundo processo do servidor para no meio da transação e é morto com `SIGKILL`. O PostgreSQL desfaz tudo, a conta fica idêntica à de antes, a trava da operação que caiu aparece e, vencida, a restauração seguinte funciona. |
| 6. Versões anteriores | `6)` | Backup sem as tabelas e colunas que vieram depois (como faria uma versão anterior: esquema 1, sem o e-mail das notas) restaura com os valores padrão. Esquema mais novo e formato mais novo são recusados sem mexer em nada. |
| 7. Preservação em falha | `4/7)`, `5/7)`, `7)` | A fotografia da conta é idêntica depois de cada tentativa recusada ou falha. Backup de A restaurado em B com A existindo: recusado, com A e B intactas. |
| 8. Grande volume | `8)` | 4.000 notas e 4.000 tomadas com XML, mais 1.000 clientes, em 2 empresas. Arquivo de 6,7 MB em 4 partes. Sem perda nem duplicação. Tempos na máquina de teste (PGlite, mesmo processo, sem rede): backup ≈ 1,7 s; restauração com backup de segurança ≈ 2,3 s. |
| 9. Permissões e sigilo | `9)` | Outra conta recebe 404 em todas as rotas; sem sessão, 401; sem anti-CSRF, 403; senha curta é recusada. Sem em claro no arquivo: senha do certificado, chave da IA, nome e CPF do cliente, CNPJ, XML, e-mail e senha do backup. Senha ausente do banco e da auditoria. Partes guardadas cifradas. Duas operações simultâneas: uma passa e a outra recebe 409. |
| — | `formato`, `cobertura`, `retenção`, `validação direta` | Ida e volta do formato, parâmetros maliciosos, cobertura de colunas, retenção de 5 arquivos, tabelas e campos inválidos. |

Bancos: a bateria inteira roda no PGlite (padrão de `npm test`) e foi rodada também num **PostgreSQL 16 real** (`DATABASE_URL=… node test/backup.test.js`): 13 de 13 aprovados, incluindo a queda real. Lá, o teste de volume levou ≈ 1,2 s para o backup e ≈ 1,6 s para restaurar.

Também verificado no navegador (Playwright, celular e computador): criar o backup na tela, baixar o arquivo, apagar dados, restaurar pela tela com o arquivo baixado (prévia, confirmação e resultado) e ver a senha errada recusada com mensagem clara.

## 9. Limitações conhecidas (não cobertas ou não comprovadas)

- **Senha perdida = backup perdido.** Não há como recuperar o conteúdo sem a senha; é a contrapartida do sigilo.
- **Tempo e memória na Vercel:** criar e restaurar acontecem numa única chamada de até 300 s. Os testes de volume rodaram num banco local; no Neon, a latência de rede aumenta o tempo. Contas muito grandes (dezenas de milhares de notas) podem chegar ao limite de tempo. Nesse caso a restauração **é desfeita** (não fica pela metade), mas não conclui. O arquivo aceita até 150 MB.
- **Queda real do processo:** comprovada com PostgreSQL 16 local (processo do app morto com `SIGKILL` com a transação aberta). Não houve teste derrubando uma conexão com o Neon de verdade; o comportamento esperado é o mesmo (transação não confirmada é desfeita pelo banco). Depois de uma queda, a conta fica travada para novo backup ou restauração por até 15 min (prazo da trava).
- **Dados só no aparelho:** rascunhos feitos sem internet e ainda não enviados ao servidor não entram no backup.
- **Restauração em outra conta** do mesmo servidor é recusada enquanto a conta de origem existir (identificadores iguais).
- **Banco ilegível:** se o estado atual da conta não puder ser lido (por exemplo, a chave mestra foi trocada e os dados antigos ficaram ilegíveis), o backup de segurança falha e a restauração é cancelada, por regra. Nesse cenário, use primeiro o backup bruto do servidor (`npm run backup`, em [docs/07](07-operacao-e-release.md)) e fale com o suporte.
- **Retenção no servidor:** os arquivos guardados no servidor são uma conveniência, não substituem a cópia baixada. Mantenha o arquivo fora do aparelho e longe da senha.
- **Formato 1 é o primeiro:** "versões anteriores" foram testadas simulando um backup sem as tabelas e colunas mais novas. Não existe ainda um formato antigo real para comparar.
