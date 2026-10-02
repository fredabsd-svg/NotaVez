# Conta, privacidade e recuperação — F07

## Contrato HTTP

Alterações exigem `X-NotaVez: 1`, mesma origem e cookie HttpOnly. A API tem no-store.

| Endpoint | Acesso | Corpo / retorno |
| --- | --- | --- |
| GET `/api/conta` | sessão | `{usuarioId, prestadorId: string|null, email, temPerfil}` |
| DELETE `/api/conta` | sessão + senha atual | `{senha}`; `200 {ok:true}`; `401` senha incorreta; `409 CONTA_COM_EMISSAO_PENDENTE` com `notaId` |
| POST `/api/conta/recuperar` | público | `{email}`; mensagem genérica; `503` sem entrega; não retorna token |
| POST `/api/conta/redefinir` | público | `{token, senha}`; revoga sessões/tokens; `422` inválido, expirado ou usado |
| GET `/api/conta/transparencia` | público | `{responsavel, contatoPrivacidade, retencao, configurada}` |

`criarAutenticacao` instala `recuperacoes_senha` e `limites_conta` também nos bancos existentes. Tokens contêm 32 bytes aleatórios e apenas HMAC é persistido, TTL padrão 30 minutos (opção `recuperacaoTtlMs`, até 24 horas). Nova solicitação invalida token anterior. Limites por identidade/IP persistem no SQLite e expiram em 15 minutos. A chave mestra precisa ser estável entre processos/reinícios.

## Entrega e publicação exigem configuração real

`criarEntregaRecuperacao` em `security/recuperacao-entrega.js` envia POST JSON `{email, token, expiraEm}` por webhook HTTPS com Bearer, sem redirects. Testes usam transporte simulado; nenhuma mensagem real foi enviada.

- `NOTAVEZ_RECUPERACAO_WEBHOOK`: endpoint HTTPS do serviço de entrega escolhido.
- `NOTAVEZ_RECUPERACAO_WEBHOOK_TOKEN`: segredo Bearer fora do código/logs.
- `NOTAVEZ_RESPONSAVEL`: identificação real do responsável.
- `NOTAVEZ_CONTATO_PRIVACIDADE`: contato real para solicitações.
- `NOTAVEZ_RETENCAO`: texto revisado sobre backups e retenções efetivas: fundamento, dados, duração, eliminação e reaplicação de exclusões ao restaurar.

O serviço deve enviar ao e-mail cadastrado um link na origem controlada: `/recuperar-conta.html#token=TOKEN`. Não há domínio, remetente ou fornecedor padrão presumido. O fragmento é removido da barra ao carregar; não colocar token na query string. Proteger webhook/payload e evitar logs de tokens. Sem HTTPS/autenticação a inicialização falha. Sem adaptador o endpoint informa indisponibilidade.

Falha de entrega invalida token e mantém resposta genérica para não revelar existência da conta. `relatarFalhaEntrega` opcional em `criarAutenticacao` permite alerta sem identificadores/segredos. O operador precisa monitorar/testar entrega completa antes do lançamento.

## Exclusão e integridade fiscal

A transação SQLite rejeita contas com notas `enviando`/`pendente` antes de remover dados. O claim fiscal exige nota, versão, perfil e certificado existentes antes da chamada externa. Se exclusão vence preparação anterior ao claim, emissão não transmite; se claim vence, exclusão fica bloqueada. Não apagar notas incertas para liberar o fluxo.

São apagados usuário, sessões, tokens, prestadores, A1 (incluindo removidos logicamente), clientes, serviços, notas/rascunhos/XML, chamadas e auditorias associados. Clientes mTLS em memória dos prestadores excluídos são fechados, preservando outras contas. Limites antiabuso não guardam ID/IP em claro e expiram em 15 minutos. Reservas `contadores_dps` são compartilhadas por emitente/ambiente/série, preservadas para impedir reutilização; não contêm XML, PFX ou e-mail. Cache municipal público permanece.

Excluir no banco ativo não cancela documentos oficiais nem alcança downloads, compartilhamentos ou aparelhos desconectados. App/página removem dados locais do titular neste navegador quando possível e explicam falha IndexedDB. Sessões revogadas bloqueiam acessos ao servidor. Dados antigos sem dono ficam em quarentena e não são atribuídos/sincronizados; limpar armazenamento do site remove essas cópias.

Restauração de backups não pode reativar contas excluídas. Não existe agendador/registro externo de exclusões ou política de backups implementado neste escopo; o operador precisa estabelecer o processo real antes de prometer duração/retenção. Não existe prazo fiscal universal codificado.

## Páginas

`/excluir-conta.html` efetua login com e-mail/senha informados e exclusão sem app instalado; `/recuperar-conta.html` solicita/redefine senha; `/privacidade.html` mostra dados, finalidades, proteção, destinatários, exclusão e configuração real. `#/conta` no Perfil dispara evento de encerramento/limpeza após exclusão.

Privacidade indica incompletude quando falta responsável, contato ou retenção. Identificar/revisar também fornecedores de hospedagem/entrega e preencher Data safety antes da publicação. Metadados do servidor e IndexedDB local não são todos cifrados; não declarar criptografia integral.

## Verificações

`node --disable-warning=ExperimentalWarning test/conta.test.js` cobre reautenticação, bloqueio fiscal, cascatas/chamadas/auditoria, preservação de outra conta, páginas públicas, tokens secretos uso único/expirados, revogação, invalidação de tokens anteriores, entrega falha, limites persistentes e transporte autenticado sem redirects. Não faz chamadas oficiais nem envia e-mails reais.
