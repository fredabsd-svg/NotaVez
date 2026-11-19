# E-mail das notas ao cliente

Na nota emitida, **Enviar ao cliente** abre a tela de envio por e-mail:

- **Para**: vem do cadastro do cliente (ou do e-mail que veio na própria NFS-e). Dá para trocar ou incluir outros, separados por vírgula (até 10 destinatários). Se o cliente não tem e-mail no cadastro, a tela oferece salvar o e-mail digitado no cadastro dele.
- **Anexos**: o DANFSe (PDF, gerado do XML oficial, com as mesmas marcas d'água das outras telas) e o XML oficial da NFS-e. Os dois vêm marcados.
- **Assunto e mensagem**: escritos pela IA configurada na conta (Assistente › Configurar). Os dois campos são editáveis. "Pedir outro texto" gera uma versão diferente, opcionalmente com uma preferência ("mais formal", "mais curto"...). Sem IA configurada, ou se o provedor falhar, entra um modelo simples com os mesmos dados.
- **Receber uma cópia**: a cópia vai em cópia oculta para o e-mail que envia.
- Antes de enviar, a tela avisa se a mensagem (talvez editada) deixou de citar o número da nota, a competência, o valor ou a retenção. É só um aviso.
- Depois do envio, a nota mostra "Enviada por e-mail em ... para ...", e a tela de envio lista os envios anteriores.

Notas canceladas, rascunhos e notas de outra conta não podem ser enviados.

## O texto escrito pela IA

O modelo recebe **só os fatos tirados do XML oficial** da NFS-e (nunca o que foi digitado no rascunho): número, competência, data de emissão, valor do serviço, descrição, nome da empresa e do cliente, retenções (ISS retido pelo tomador ou pelo intermediário, IRRF, INSS, PIS/COFINS/CSLL conforme `tpRetPisCofins`) com o total retido e o valor líquido, os anexos marcados e o aviso de nota de teste (homologação) ou simulação. O e-mail do cliente não vai para a IA.

O system prompt (`server/src/email/nota.js`, `SISTEMA_EMAIL`) pede um e-mail humano, curto e cordial, que traga sempre o número, a competência, o valor, se houve ou não retenção (e quais, com valores e o líquido), os anexos e um agradecimento breve. Ele proíbe inventar informações (vencimento, dados bancários, prazos), expressões de e-mail automático ("Espero que este e-mail o encontre bem", "Prezado cliente", "Não hesite em entrar em contato"...), emojis, markdown e travessão longo. A resposta vem em JSON (`assunto`, `corpo`); o servidor limpa marcas que escapem e, se o formato vier errado, usa o modelo simples com um aviso.

## Configuração (Conta › E-mail para enviar notas)

O e-mail sai pelo SMTP **da própria conta** (vale para todas as empresas da conta). A tela traz os dados de Gmail/Google Workspace, Outlook.com, Microsoft 365, Zoho, Hostinger, Locaweb, Yahoo, iCloud e Brevo, ou "Outro servidor".

- Gmail, Outlook, Yahoo, iCloud e Zoho com verificação em duas etapas pedem uma **senha de app** (não a senha normal da conta).
- Microsoft 365: o administrador precisa liberar o "SMTP autenticado" para a caixa.
- Ao salvar, o app manda um e-mail de teste para o próprio remetente.
- Nome do remetente em branco: o e-mail sai com o nome da empresa da nota (ex.: "Estudio Web Ltda" <contato@...>). "Respostas vão para" é opcional (Reply-To).

## Segurança

- A configuração inteira (servidor, usuário, senha, remetente) fica **cifrada** (AES-256-GCM) na tabela `email_config`; a senha nunca volta para a tela. O histórico de envios (`notas_emails`) guarda destinatários e assunto cifrados. A auditoria registra só quantidades e anexos.
- Conexão sempre protegida: SSL/TLS desde o início (porta 465) ou STARTTLS obrigatório (587); nada de senha ou conteúdo sem TLS. O certificado do servidor é conferido pelo nome.
- O servidor informado pelo usuário é resolvido e **endereços internos** (rede local, nuvem, loopback, reservados) são recusados; a conexão vai ao IP conferido. Portas aceitas: 25, 465, 587 e 2525.
- Cabeçalhos sem quebra de linha (sem injeção de destinatários); endereços validados.
- Limites por conta: 120 envios e 60 textos da IA por hora, 10 testes a cada 10 minutos.
- A configuração e o histórico entram no backup da conta (esquema 2).

## Limitações

- O e-mail é enviado pelo provedor da conta: limites diários de envio, filtros de spam e exigências do provedor (SPF/DKIM do domínio, senha de app) valem normalmente. O app não acompanha a entrega depois que o servidor de e-mail aceita a mensagem.
- Sem e-mail configurado, a tela oferece "Abrir no meu e-mail" (mailto, sem anexos) e, no celular, "Compartilhar" com o PDF e o XML.
- O envio é um por nota (não há envio em lote).
