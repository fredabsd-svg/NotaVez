# Integração proposta de CI

Os testes do tooling Android são independentes do SDK e podem entrar no CI geral agora:

```yaml
- name: Install Android preparation tooling
  working-directory: android-twa
  run: npm ci --ignore-scripts --no-audit --no-fund
- name: Test Android config, DAL and Bubblewrap generator
  working-directory: android-twa
  run: npm test
```

O lockfile é separado do servidor. Usar Node22.13+; o teste do gerador roda sem tráfego externo e sem credenciais. Nada desta pasta requer `bypassCSP`.

## Futuro job Android manual

Integrar somente após concluir domínio, applicationId, certificados e configuração revisada. O job deve ser manual, em ambiente de release restrito, sem permissões de publicação:

1. Checkout de revisão aceita; instalar dependências pelo lockfile.
2. Provisionar JDK17 com fornecedor/patch registrados e SDK Platform36 + Build Tools36.1.0. Aceitar licenças no processo autorizado de provisionamento.
3. Materializar keystore em diretório temporário **fora** do checkout e configurar path/alias; senhas vêm de secrets. Remover a cópia temporária ao concluir, sem imprimir seu conteúdo.
4. Materializar JSON de configuração explícita aprovado; executar `validate`, `project`, `check-project` e `bubblewrap doctor`.
5. Carregar secrets `BUBBLEWRAP_KEYSTORE_PASSWORD` e `BUBBLEWRAP_KEY_PASSWORD`; rodar build. Não chamar `bubblewrap play publish`.
6. Inspecionar AAB/APK, assinatura, target API e manifesto mesclado, guardar hashes e artefatos privados com retenção definida.
7. Exigir revisão humana e homologação/QA do plano antes de usar qualquer canal da Play.

Antes de anunciar reprodução de release, congelar a resolução de dependências Gradle/Maven no projeto definitivo e revisar metadados de verificação. Não usar um sucesso dos testes Node como substituto para build Android ou validação em aparelho.
