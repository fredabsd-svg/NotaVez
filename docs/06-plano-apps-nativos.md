# 6. Plano para os aplicativos da App Store e do Google Play

## 6.1 Princípio

O servidor é a fonte da verdade: contas, clientes, serviços, notas, regras fiscais, certificado e integração com a Receita. Os aplicativos nativos são **novos clientes da mesma API**, usando os mesmos dados. Nada de regra fiscal nem de assinatura vai para dentro do app. Assim a lógica não se duplica, e uma atualização de leiaute ou de regra não depende de revisão das lojas.

## 6.2 Caminho recomendado

| Fase | O que entrega | Prazo estimado |
|---|---|---|
| **0. PWA (atual)** | Instalável pela tela inicial em Android e iPhone | pronto |
| **1. Android via TWA** (Trusted Web Activity / Bubblewrap) | O próprio PWA publicado no Google Play, com Digital Asset Links. Custo baixo e mesma base de código | 1–2 semanas |
| **2. App multiplataforma** (React Native/Expo **ou** Capacitor) | Publicação na App Store e no Google Play, com recursos nativos | 6–10 semanas |

Na fase 2, recomendamos o **Capacitor** se o objetivo for reaproveitar as telas web atuais com o menor custo. Recomendamos o **React Native** se a experiência nativa for prioridade (listas longas, gestos, desempenho em aparelhos simples). A Apple tende a recusar apps que são só um site embrulhado (diretriz 4.2), então a versão iOS precisa de recursos nativos reais, listados abaixo.

## 6.3 Recursos nativos que justificam o app

- **Notificações push** para "Nota emitida", "Pendente confirmada" e "Certificado vence em 30 dias" (APNs/FCM; o servidor dispara a partir da tarefa de pendentes).
- **Login biométrico** (Face ID / digital) para abrir o app, com o token de sessão no **Keychain / Android Keystore**.
- **Compartilhar** XML e DANFSe pela folha nativa (WhatsApp, e-mail) e salvar em Arquivos.
- **Ler QR Code do DANFSe** para consultar notas recebidas.
- **Contatos:** importar cliente da agenda (só nome, telefone e e-mail; o documento continua sendo digitado).
- **Widget** "Emitir nota" / "Clonar última".
- **Offline robusto:** SQLite local para rascunhos, com a mesma regra de hoje: só "emitida" com confirmação do servidor.

## 6.4 Ajustes no servidor (pequenos)

1. **Autenticação por token para apps:** hoje a sessão é um cookie `SameSite=Strict`. Para o app: OAuth 2.0 com PKCE, ou token de acesso curto + refresh token rotativo, guardado no Keychain/Keystore. O CSRF por cabeçalho continua valendo para o PWA.
2. **Versionamento da API** (`/api/v1`) e campo `versaoMinimaApp` em `/api/saude`, para forçar atualização quando uma regra oficial exigir.
3. **Registro de dispositivos** para push (`dispositivos`: usuário, plataforma, token, criado_em).
4. **Atestado do app** (Play Integrity / App Attest) nas rotas sensíveis (envio de certificado e emissão).
5. **Sincronização:** o endpoint `POST /api/notas` com id gerado no aparelho já é idempotente, e serve igual ao app.

## 6.5 Certificado digital nos apps

- O fluxo continua o mesmo: o arquivo A1 vai **uma única vez** ao servidor, cifrado em trânsito, e **não fica guardado no aparelho**.
- iOS: o usuário escolhe o `.pfx` com o seletor de documentos (Arquivos/iCloud). Android: Storage Access Framework.
- **Futuro:** certificados em nuvem (PSC credenciado ICP-Brasil) com assinatura remota autorizada no próprio celular. Isso habilita o público com A3 e elimina o envio do arquivo. Exige integrar a API do PSC no servidor (o módulo `assinatura.js` já isola a assinatura).

## 6.6 Lojas: requisitos e riscos

| Tema | Ação |
|---|---|
| Política de privacidade e LGPD | Página pública; descrição dos dados de clientes e do certificado; exclusão de conta dentro do app (exigência das duas lojas) |
| "Privacy Nutrition Label" (Apple) / "Data safety" (Google) | Declarar: e-mail, dados financeiros (valores), documentos de clientes, certificado; criptografia em trânsito e em repouso |
| Revisão da Apple | Conta de teste em **modo demonstração** (Receita simulada, com a faixa de aviso). Nunca apresentar uma simulação como nota real |
| Categoria | Finanças / Negócios; classificação livre |
| Nome e marca | Não usar marcas do governo nem sugerir que é aplicativo oficial da Receita |
| Pagamentos | Se houver assinatura paga: compra dentro do app (iOS) ou plano B2B faturado fora da loja, conforme as regras vigentes |

## 6.7 Evolução do produto que o app aproveita

- Pacotes de **2027** (IBS/CBS para o Simples, CBS plena, fim do PIS/COFINS) e grupos IBS/CBS ainda não suportados (imóvel, tributação regular, diferimento). MEI, ME/EPP e Lucro Presumido/Real já emitem.
- Marca d'água "CANCELADA"/"SUBSTITUÍDA" no DANFSe (o gerador já aceita a marca; falta o evento). O DANFSe local conforme a NT 008 já está pronto.
- **Eventos:** cancelamento (evento 101101) e substituição.
- **Contadores:** vários perfis fiscais por conta, cada um com o seu certificado. O modelo `usuarios → prestadores` já está pronto para isso.
