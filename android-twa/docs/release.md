# Roteiro de build e validação no Android

## Pendências que impedem release

1. Confirmar domínio HTTPS de frontend e API na mesma origem, applicationId e titular.
2. Definir Play App Signing e chave de upload, guardar a chave e suas senhas fora do Git e obter o SHA-256 da **assinatura de distribuição**.
3. Configurar o JSON local, gerar DAL/projeto e servir DAL na origem real.
4. Compilar e verificar APK/AAB com SDK36, instalar em aparelho e pelo canal interno da Play. Homologação fiscal, privacidade, exclusão, segurança operacional e critérios do plano seguem como gates independentes.

## SDK e JDK existentes

Preparar JDK17 e Android command-line tools em ambiente autorizado de release. Registrar suas versões. Defina `JAVA_HOME` e `ANDROID_HOME` para instalações reais. O SDK Manager abaixo pode solicitar aceite de licenças; fazê-lo conscientemente no ambiente de build:

```bash
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.1.0"
```

Não usar `latest` para Bubblewrap ou para o Gradle. Não baixar automaticamente SDK/JDK ao rodar testes. Após ter as instalações, configure Bubblewrap para usá-las:

```bash
cd android-twa
./node_modules/.bin/bubblewrap updateConfig --jdkPath="$JAVA_HOME" --androidSdkPath="$ANDROID_HOME"
./node_modules/.bin/bubblewrap doctor
```

Se a CLI solicitar uma instalação automática no primeiro uso, escolha a instalação existente. A geração via `npm run project` usa o Core diretamente e não faz esse bootstrap.

## Projeto e build

```bash
npm run validate
npm run project
npm run check-project
cd generated/project
../../node_modules/.bin/bubblewrap build
```

A CLI solicita as senhas interativamente. Para CI, os nomes suportados são `BUBBLEWRAP_KEYSTORE_PASSWORD` e `BUBBLEWRAP_KEY_PASSWORD`, carregados por um secret manager. Não passá-las em argumentos do shell, não ativar `set -x` e não armazená-las no checkout. Verificar a existência/alias do keystore usando `keytool` antes do build.

O projeto recebe `manifest-checksum.txt` no formato usado pelo Bubblewrap para detectar mudanças; isso evita a regeneração automática que removeria ajustes da toolchain. Se alterar o manifesto ou executar `bubblewrap update`, gerar novamente a partir da configuração aprovada e rodar `check-project`. Rejeitar qualquer build que tenha sido regenerado sem reaplicar/revisar esses ajustes.

Quando o build ocorrer, saídas esperadas: `app-release-signed.apk` e `app-release-bundle.aab` em `generated/project/`. **Esses arquivos não existem nesta entrega.** Guardar artefatos e relatório de hashes com acesso restrito. Revisar o manifesto mesclado, `applicationId`, versionCode, target36, assinatura e dependências do AAB com ferramentas Android/bundletool oficiais. Bibliotecas nativas eventualmente acrescentadas precisam de verificação 16KB; não usar presença de SQLite no servidor como evidência sobre o Android.

## Digital Asset Links

Copiar a saída `generated/.well-known/assetlinks.json` para a configuração do serviço web. O agente do backend integra a forma de servir o arquivo. Não alterar a identidade manualmente no DAL sem atualizar a configuração de origem.

- URL: `https://DOMINIO_CONFIRMADO/.well-known/assetlinks.json`.
- Resposta pública `200`, `Content-Type: application/json`, sem autenticação nem redirecionamento.
- `package_name` igual ao applicationId final.
- Fingerprint da Play assinado para esse app. Para APK local, só adicionar fingerprint de uma chave local deliberadamente autorizada; remover chaves de debug da origem de produção.
- Se houver rotação de certificado, manter os fingerprints exigidos para os dispositivos/canais aplicáveis conforme a Play, até concluir a migração.

Testar a URL e a relação usando a [API oficial Digital Asset Links](https://developers.google.com/digital-asset-links/v1/getting-started), além da instalação real. O gerador valida o arquivo, não sua publicação. O DAL não deve dar acesso a origens extras sem revisão.

## Aparelho e canal interno

- Instalar APK e testar abertura, retorno, teclado, rotação, links, downloads/compartilhamento, offline, login/logout, conta A/B e recuperação de sessão.
- Instalar **pela Play** no canal interno, confirmando assinatura de distribuição e abertura como TWA, sem barra de endereço no domínio confiável. Testar fallback quando o navegador TWA não estiver disponível.
- Verificar comportamento em Android16/API36, acesso do revisor com dados fictícios isolados e todos os requisitos funcionais do plano.
- Registrar evidências sanitizadas. Envio à Play, convite a testadores e publicação dependem de autorização específica; esta preparação não os executa.
