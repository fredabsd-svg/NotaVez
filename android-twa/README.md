# Preparação Android — Nota Sem Stress

Esta pasta prepara a TWA prevista no plano. **Não há APK, AAB, domínio de produção ou vínculo com a Play já validado.** O projeto Android só é gerado após configurar identidades explícitas. O servidor Node e o SQLite permanecem no backend hospedado; não são empacotados no Android.

## O que foi preparado

- `validate`: valida HTTPS, domínio DNS, applicationId, fingerprints SHA-256, versões e caminho externo do keystore.
- `generate`: produz `generated/twa-manifest.json`, `generated/.well-known/assetlinks.json` e registro da toolchain, sem acesso à rede ou SDK.
- `project`: produz esses mesmos arquivos e gera um projeto Gradle com Bubblewrap; baixa somente ícones e webmanifest da origem configurada. Exige keystore existente fora do checkout, inclusive ao resolver symlinks. Não cria chave, compila, instala ou publica.
- `check-project`: verifica a toolchain do projeto gerado, sem afirmar validade de um APK/AAB.
- `test`: cobre entradas inválidas, identidade compartilhada entre DAL/TWA, recusa de sobrescrita e geração real de um projeto com respostas HTTP simuladas e os ícones existentes. Não requer SDK nem acesso a um serviço fiscal.

## Instalação e configuração

```bash
cd android-twa
npm ci --ignore-scripts --no-audit --no-fund
npm test
cp android-config.example.json android-config.json
```

Preencha `android-config.json`. Os campos vazios do modelo são deliberados e falham na validação.

| Campo | Valor a obter do titular |
|---|---|
| `origin` | Origem HTTPS pública sob seu controle, somente esquema e domínio, sem caminho/porta |
| `packageId` | ApplicationId Android definitivo; não deve ser escolhido por este gerador |
| `sha256CertFingerprints` | Lista de SHA-256 **do certificado de assinatura do app distribuído pela Play**, no formato de 32 pares hexadecimais separados por `:` |
| `versionCode` | Inteiro positivo, maior que qualquer versão já enviada para esse applicationId |
| `versionName` | Nome explícito da versão, como `1.0.0` |
| `signingKey.path` | Caminho absoluto do keystore de upload, fora do repositório |
| `signingKey.alias` | Alias da chave de upload existente |

O gerador confere formato; não comprova posse do domínio ou que o fingerprint pertence ao certificado correto. A chave de upload e a assinatura da Play podem ser diferentes. Não inclua senha, chave privada, certificado A1, conta de serviço ou token no JSON. O modelo aceita exclusivamente os campos acima.

```bash
npm run validate
npm run generate
```

`generate` serve para preparar DAL e revisar configuração antes de ter o SDK. Para gerar também o projeto, use **em uma pasta de saída nova**:

```bash
npm run project -- --out generated-release
npm run check-project -- --out generated-release
```

Os comandos recusam uma saída já existente, evitando sobrescrever trabalho manual. Use `--config /caminho/config.json` para uma configuração externa. Arquivos gerados com identidades de teste devem ficar em diretórios temporários. A saída padrão `generated/` é ignorada pelo Git; `generated-release/` é apenas exemplo de nome de pasta nova e também deve ser mantida fora de commits até revisão.

## Toolchain fixada

| Componente | Versão |
|---|---|
| Bubblewrap CLI e Core | `1.25.0`, versões exatas + `package-lock.json` |
| JDK | Major `17` (registrar fornecedor e patch no ambiente de release) |
| Compile e target API | `36` |
| Build Tools | `36.1.0`, igual à versão utilizada pelo helper de assinatura do Bubblewrap 1.25.0 |
| Android Gradle Plugin | `8.9.1` |
| Gradle | `8.11.1`, distribuição com SHA-256 fixo |
| Android Browser Helper | Estável `2.6.2` do Bubblewrap, sem recursos alfa |

O script verifica API36, fixa Build Tools, troca JCenter por Maven Central e adiciona checksum à distribuição Gradle. O hash do wrapper JAR confere com o JAR fornecido pelo pacote npm fixado; não é apresentado como checksum do wrapper upstream 8.11.1. A geração não instala JDK/SDK nem aceita licenças automaticamente.

A reprodução do tooling npm está coberta pelo lockfile. **Build Android e resolução Maven ainda não foram executados.** Antes de congelar release, registrar JDK/SDK utilizados, gerar/revisar locks e metadados de verificação das dependências Gradle no projeto definitivo, e guardar SHA-256 do AAB. Esta preparação não promete builds idênticos em bytes.

## Próximas etapas e fontes

O roteiro de build, DAL e aparelho está em [docs/release.md](docs/release.md). O exemplo para o agente integrar CI está em [docs/ci.md](docs/ci.md). Nenhum comando nesta pasta envia artefatos à loja.

Fontes oficiais consultadas em 02/10/2026:

- [Bubblewrap CLI, configuração e comandos](https://github.com/GoogleChromeLabs/bubblewrap/blob/main/packages/cli/README.md).
- [Pacote oficial CLI 1.25.0](https://www.npmjs.com/package/@bubblewrap/cli/v/1.25.0) e código/template do Core instalado e fixado pelo lockfile.
- [TWA — guia Android](https://developer.android.com/develop/ui/views/layout/webapps/guide-trusted-web-activities-version2).
- [Digital Asset Links](https://developers.google.com/digital-asset-links/v1/getting-started).
- [Target API exigida pela Play](https://developer.android.com/google/play/requirements/target-sdk).
- [Compatibilidade Android API/AGP](https://developer.android.com/build/releases/about-agp).
- [Checksums Gradle](https://gradle.org/release-checksums/) e [verificação de dependências](https://docs.gradle.org/current/userguide/dependency_verification.html).
