# Ativar "Entrar com o Google" e "Entrar com a Microsoft" (e-mail das notas)

Com esses botões, cada conta do app conecta o próprio e-mail em Conta › E-mail para enviar notas, sem guardar senha:

- **Google** (Gmail e Google Workspace): o envio é feito pela **Gmail API**, só com a permissão de enviar (`gmail.send`). O app não lê a caixa de e-mail.
- **Microsoft** (Outlook.com, Hotmail e Microsoft 365): o envio é feito pelo **Microsoft Graph** (`/me/sendMail`, permissão `Mail.Send`). Não usa SMTP, então funciona mesmo com o "SMTP autenticado" desligado no Microsoft 365, que é o padrão da Microsoft. A mensagem fica nos Itens Enviados do Outlook.

O responsável pelo servidor faz isto **uma vez**: registra o app no Google e na Microsoft e põe as credenciais na Vercel. Sem essas credenciais, os botões aparecem desativados e o envio por usuário e senha (SMTP) continua funcionando.

Endereços de retorno usados abaixo (troque pelo endereço do seu app, se for outro):

- Google: `https://nota-sem-stress.vercel.app/api/email/oauth/google/retorno`
- Microsoft: `https://nota-sem-stress.vercel.app/api/email/oauth/microsoft/retorno`

## 1. Google (Google Cloud)

1. Em console.cloud.google.com, crie um projeto (ex.: "Nota Sem Stress").
2. Em **APIs e serviços › Biblioteca**, procure **Gmail API** e clique em **Ativar**.
3. Em **Google Auth Platform** (antiga "Tela de consentimento OAuth"):
   - **Branding**: nome do app, e-mail de suporte e e-mail de contato.
   - **Público**: tipo **Externo**. Se só contas do seu Google Workspace vão usar, escolha **Interno**: assim não há verificação nem aviso.
   - **Acesso a dados**: adicione os escopos `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` e `https://www.googleapis.com/auth/gmail.send`.
4. Em **Clientes › Criar cliente**, escolha o tipo **Aplicativo da Web**. Em **URIs de redirecionamento autorizados**, informe o endereço de retorno do Google. Crie e copie o **ID do cliente** e a **Chave secreta do cliente**.
5. Com o público Externo, volte em **Público** e clique em **Publicar app** para colocá-lo "Em produção". No modo "Teste", o Google desfaz a autorização a cada 7 dias.

O escopo `gmail.send` é considerado sensível pelo Google. Enquanto o app não passar pela verificação do Google, quem conectar vê o aviso "O Google não verificou este app". Para seguir, toque em **Avançado › Acessar Nota Sem Stress**. Nesse modo o app aceita até 100 contas. Para tirar o aviso, peça a verificação em **Google Auth Platform › Verificação**.

## 2. Microsoft (Microsoft Entra)

1. Em entra.microsoft.com (ou portal.azure.com), entre com a conta de administrador do Microsoft 365. Abra **Registros de aplicativo** (App registrations; no menu do Microsoft Entra ID) e clique em **Novo registro**.
2. Preencha o registro:
   - Nome: "Nota Sem Stress".
   - Tipos de conta: **Contas em qualquer diretório organizacional e contas Microsoft pessoais**. Assim valem o Microsoft 365 de qualquer empresa e o Outlook.com/Hotmail.
   - URI de redirecionamento: plataforma **Web**, com o endereço de retorno da Microsoft.
3. Na **Visão geral**, copie o **ID do aplicativo (cliente)**.
4. Em **Certificados e segredos › Novo segredo do cliente**, crie o segredo e copie o **Valor** (não o "ID do segredo"). Anote a validade (no máximo 24 meses): antes de vencer, crie outro e troque na Vercel.
5. Em **Permissões de API › Adicionar uma permissão › Microsoft Graph › Permissões delegadas**, marque `Mail.Send`, `User.Read`, `offline_access`, `openid`, `email` e `profile`. Depois clique em **Conceder consentimento do administrador para <sua empresa>**.

No Microsoft 365 de **outra** empresa, o administrador daquela empresa pode precisar aprovar o app na primeira conexão (a Microsoft limita o consentimento de usuários a apps de editores não verificados).

## 3. Vercel

Em **Settings › Environment Variables** do projeto, ambiente **Production**:

| Variável | Valor |
| :--- | :--- |
| `NOTAVEZ_GOOGLE_CLIENT_ID` | ID do cliente (Google) |
| `NOTAVEZ_GOOGLE_CLIENT_SECRET` | Chave secreta do cliente (Google) |
| `NOTAVEZ_MICROSOFT_CLIENT_ID` | ID do aplicativo (cliente) (Microsoft) |
| `NOTAVEZ_MICROSOFT_CLIENT_SECRET` | Valor do segredo do cliente (Microsoft) |
| `NOTAVEZ_URL_PUBLICA` | `https://nota-sem-stress.vercel.app` (recomendado: fixa o endereço de retorno) |
| `NOTAVEZ_MICROSOFT_TENANT` | opcional. `common` é o padrão. Use `organizations` (só contas de empresa) ou o ID do diretório (só a sua empresa), conforme o tipo de conta escolhido no registro. |

Depois, em **Deployments**, faça **Redeploy** da produção para as variáveis valerem. Os botões passam a aparecer ativos em Conta › E-mail para enviar notas.

Pode configurar só um dos dois: o outro botão continua desativado.

## Como funciona e o que fica guardado

- O fluxo é OAuth 2.0 com PKCE. O pedido vale 10 minutos, é de uso único e fica ligado à conta que começou e a um cookie daquele navegador (SameSite=Lax, só no caminho `/api/email/oauth`). O retorno só é aceito com o mesmo cookie e o mesmo `state`.
- O app guarda só o **refresh token**, cifrado (AES-256-GCM) junto com a configuração de e-mail da conta. O access token fica só na memória. A Microsoft troca o refresh token a cada renovação, e o novo é gravado antes de enviar.
- **Desconectar** apaga a configuração. No Google, o acesso também é revogado na hora. Na Microsoft, a pessoa pode remover o app em myaccount.microsoft.com › Aplicativos e serviços.
- Se a autorização expirar ou for desfeita no provedor, o envio responde "conecte de novo" e nada é enviado.
- O backup da conta leva a conexão (cifrada com a senha do backup). Num servidor com outras credenciais, basta conectar de novo.
