# Operação e liberação Android

Este roteiro acompanha as correções da branch de preparação para a Play. Não comprova implantação, homologação oficial ou aprovação na loja.

## Hospedagem sem Docker

1. Use Node 22.16+ ou 24 LTS, um usuário de serviço dedicado e disco persistente. Instale dependências pelo lockfile (`cd server && npm ci --omit=dev --ignore-scripts`).
2. Configure domínio real e DNS; adapte `ops/Caddyfile` e `ops/notavez.service` à instalação. O modelo usa Caddy com HTTPS e backend restrito a `127.0.0.1:8080`.
3. Crie `/etc/notavez/notavez.env` a partir do exemplo com permissão 0600. Gere e armazene a chave mestra em cofre separado; não a inclua em commits, prints ou tickets. Não troque a chave de um banco existente sem migração de cifra/índices.
4. Configure apenas IPs/CIDRs de proxies controlados em `NOTAVEZ_PROXIES_CONFIAVEIS`; o padrão é não confiar em cabeçalhos encaminhados. Não exponha a porta 8080 diretamente. Adicione proteção de volume no ingress conforme carga real.
5. Preencha responsável, contato de privacidade, política de retenção e entrega de recuperação antes do teste público. Não há contatos de produção inventados no código.
6. Preserve `NOTAVEZ_PRODUCAO_LIBERADA=0` até emissão, consulta, XML e DANFSe aprovados em produção restrita para os regimes anunciados.

Os limites do aplicativo são persistidos em SQLite e sobrevivem ao restart, mas só são compartilhados entre processos que usam o mesmo arquivo. Não execute réplicas com bancos independentes. SQLite exige estratégia operacional compatível; este modelo inicial usa uma instância de serviço.

## Backup e exercício de restauração

`cd server && npm run backup -- /var/lib/notavez/notavez.db /destino/backup-NOVO`

A rotina usa a API de backup SQLite (inclui transações em WAL), verifica integridade e gera manifesto SHA-256. Exige uma pasta de destino nova. O backup contém dados pessoais/metadados e precisa de armazenamento cifrado e controle de acesso. A chave mestra não acompanha o arquivo: preserve-a separadamente com recuperação controlada.

Antes de liberar produção: parar o serviço de um ambiente isolado, restaurar uma cópia para disco novo, conferir hash e `PRAGMA integrity_check`, carregar a mesma chave e validar leitura de amostras cifradas. Nunca testar restauração substituindo o banco ativo. Definir frequência, retenção, RPO/RTO e expiração das cópias conforme a operação; não há prazo fictício configurado.

Exclusões precisam ser consideradas ao restaurar backup antigo: ele pode reintroduzir dados apagados. Restrinja a retenção de backups e mantenha procedimento seguro para reaplicar exclusões antes de reabrir acesso. A rotina de backup não torna esse procedimento automático.

## Monitoramento

- Verificar processo e `/api/saude` por monitor externo. Esse endpoint é liveness, não atestado de disponibilidade da Receita.
- Acompanhar quantidade/idade das notas em `pendente` e `enviando`, erros 5xx/429, disco e validade dos certificados. Logs não devem incluir tokens, senhas, XMLs ou conteúdo do certificado.
- A verificação periódica de pendentes deve continuar após restart; testar indisponibilidade oficial e recuperação antes do rollout.
- Monitorar backup e testar restauração periodicamente. Dimensionar alertas e destinatários antes da operação comercial.

## Android e Google Play

Veja `android-twa/README.md`. Domínio, package ID e fingerprint devem ser do titular. Sirva o DAL gerado configurando `NOTAVEZ_ASSETLINKS_FILE` no servidor; sem configuração a rota retorna 404, nunca HTML do PWA. O certificado de assinatura de distribuição pode diferir da chave de upload.

O pipeline executa testes Node em 22 e 24 e testes do gerador Android. Não produz AAB de release sem a configuração e credenciais necessárias. Não há chave privada no repositório.

Conta pessoal: confirmar data de criação; se criada após 13/11/2023, cumprir 12 participantes inscritos continuamente por 14 dias e solicitar acesso à produção. Validar API 36+, privacidade, exclusão, Data safety, conta do revisor, classificação, screenshots atuais e monetização no Console.

## Critérios de liberação

- Testes fiscais/offline/conta e CI aprovados; falhas reproduzidas cobertas por regressão.
- Teste oficial em produção restrita e documentos conferidos; competências de 2027 continuam bloqueadas até pacote fiscal próprio validado.
- Domínio/backend e configuração de privacidade completos, backup/restauração e suporte preparados.
- AAB assinado instalado pelo canal de teste da Play; DAL, voltar, teclado, offline, A1, PDF/XML e compartilhamento validados em aparelhos reais.
- Teste fechado, declarações e revisão Play concluídos. Cancelamento/substituição permanecem fora do escopo implementado.

Fontes de implementação: [Fastify trustProxy](https://fastify.dev/docs/latest/Reference/Server/), [SQLite backup Node 22](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html), [TWA](https://developer.chrome.com/docs/android/trusted-web-activity/quick-start), [teste pessoal Play](https://support.google.com/googleplay/android-developer/answer/14151465).
