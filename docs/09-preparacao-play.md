# Preparação para a Google Play — 02/10/2026

As correções desta entrega preparam o código para homologação e testes Android. Não representam emissão oficial, implantação de backend, AAB assinado ou publicação na loja.

## Implementado

- Emissão com revisão vinculada à versão dos dados, controle de concorrência persistido, recuperação após interrupção e consulta no ambiente original da nota. Reenvio preserva a DPS assinada e exige certificado ainda ativo e válido.
- Rascunhos/cache offline separados por usuário e prestador; troca de conta interrompe sincronizações anteriores. Conflitos preservam alterações locais para resolução explícita. Dados legados sem titular ficam em quarentena.
- Recuperação de senha com token de uso único, revogação de sessões e entrega configurável; exclusão autenticada dentro e fora do app, com bloqueio para emissões ainda incertas. Páginas públicas de privacidade e exclusão.
- Limites persistidos, proxy confiável explícito, backup SQLite com verificação e modelos de operação HTTPS.
- Gerador Android TWA com configuração obrigatória do titular, Digital Asset Links, toolchain fixada e validação do projeto API 36.
- CI em Node 22 e 24; fluxo de navegador com integração fiscal simulada e CSP ativa.

## Evidências locais

Em 02/10/2026, a suíte do servidor concluiu os sete arquivos sem falhas; os sete testes do tooling Android passaram. O fluxo Chromium móvel passou por cadastro, perfil/A1 fictício, revisão e emissão simulada, download PDF/XML, isolamento A/B, exclusão e privacidade.

O ambiente local usou Node 24 e Chromium 153. O gerador Android produziu um projeto Gradle a partir de HTTP simulado; não houve compilação Android ou acesso fiscal real. Os testes do navegador não substituem aparelhos Android reais.

## Próximos marcos

| Ordem | Marco | Dependência/evidência necessária |
|---|---|---|
| 1 | Homologação fiscal oficial | A1 real autorizado; emissão, consulta, XML e DANFSe conferidos nos regimes anunciados |
| 2 | Backend de teste público | Domínio e HTTPS, chave em cofre, restauração ensaiada, monitoramento, recuperação de senha com entrega real |
| 3 | Identidade e transparência | Responsável e contato de privacidade, retenção definida, applicationId, assinatura Play e DAL do domínio |
| 4 | AAB no teste interno | SDK/JDK, build assinado, validação em aparelhos de teclado, navegação, offline, certificado e compartilhamento |
| 5 | Preparação do Console | Data safety coerente com o backend, acesso do revisor, classificação, textos e screenshots atuais; definir monetização |
| 6 | Teste fechado e produção | Confirmar data da conta pessoal e exigências aplicáveis no Console; concluir teste e solicitar acesso à produção |

A produção fiscal permanece bloqueada por configuração até homologar. Competências de 2027 exigem pacote fiscal próprio; cancelamento e substituição ainda não estão implementados. Não anunciar esses recursos como disponíveis.

Detalhes: [operação e liberação](07-operacao-e-release.md), [conta e privacidade](08-conta-e-privacidade.md), [Android](../android-twa/README.md) e [homologação](05-testes-homologacao.md).
