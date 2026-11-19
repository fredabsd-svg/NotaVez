# E-mail das notas ao cliente

Na nota emitida, **Enviar ao cliente** abre a tela de envio por e-mail:

- **Para**: vem do cadastro do cliente (ou do e-mail que veio na própria NFS-e). Dá para trocar ou incluir outros, separados por vírgula (até 10 destinatários). Se o cliente não tem e-mail no cadastro, a tela oferece salvar o e-mail digitado no cadastro dele.
- **Anexos**: o DANFSe (PDF, gerado do XML oficial, com as mesmas marcas d'água das outras telas) e o XML oficial da NFS-e. Os dois vêm marcados.
- **Assunto e mensagem**: saem do **modelo da conta** (veja abaixo), preenchido com os dados do XML oficial. A IA configurada na conta escreve só o tipo do serviço (ex.: "serviços contábeis") a partir da descrição da nota. Os dois campos são editáveis, e "Ajustar o texto com a IA" muda o texto atual conforme um pedido ("mencione que o boleto vai em outro e-mail"), mantendo o resto.
- **Receber uma cópia**: a cópia vai em cópia oculta para o e-mail que envia.
- Antes de enviar, a tela avisa se a mensagem (talvez editada) deixou de citar o número da nota, a competência, o valor ou a retenção. É só um aviso.
- Depois do envio, a nota mostra "Enviada por e-mail em ... para ...", e a tela de envio lista os envios anteriores.

Notas canceladas, rascunhos e notas de outra conta não podem ser enviados.

## O texto do e-mail (modelo)

O modelo padrão segue o jeito de escrever pedido pelo usuário:

```
{saudacao},

A nota fiscal nº {numero}, referente aos {servicos} de {competencia}, segue emitida. O valor do serviço é de {valor}, {retencao}.

{anexos}

Agradeço pela confiança e pela parceria.
```

Exemplo do resultado: "Bom dia, / A nota fiscal nº 15, referente aos serviços contábeis de novembro de 2026, segue emitida. O valor do serviço é de R$ 400,00, sem retenção de impostos. / Os arquivos em PDF (DANFSe) e XML da NFS-e acompanham este e-mail. / Agradeço pela confiança e pela parceria." O assunto padrão é "Nota fiscal nº {numero} - {competencia}".

Campos disponíveis:
- `{saudacao}`: Bom dia, Boa tarde ou Boa noite, pela hora de Brasília.
- `{numero}`, `{competencia}` ("novembro de 2026"), `{mes_ano}` ("11/2026") e `{valor}`.
- `{retencao}`: "sem retenção de impostos" ou "com retenção de ISS de R$ 30,00 e IRRF de R$ 22,50, ficando o valor líquido em R$ 1.447,50". Vale ISS retido pelo tomador ou intermediário, IRRF, INSS e PIS/COFINS/CSLL conforme `tpRetPisCofins`.
- `{valor_liquido}`.
- `{anexos}`: frase dos anexos marcados. Sem anexos, a linha some.
- `{cliente}` e `{empresa}`, com o nome sem caixa alta.
- `{servicos}`: escrito pela IA ("serviços contábeis", "serviços de desenvolvimento de site"); sem IA, "serviços".

Cada conta troca o seu em Conta › E-mail para enviar notas › **Texto do e-mail** (campo desconhecido é recusado; "Voltar ao modelo padrão" restaura). Nota de teste (homologação) ganha uma observação no fim.

A IA da conta recebe só a descrição do serviço da nota e a do código de serviço, sem valores, nomes nem e-mails. A resposta é conferida: precisa ser uma expressão curta começando por "serviços", senão fica "serviços". No ajuste pedido pela pessoa (`server/src/email/nota.js`, `SISTEMA_AJUSTE`), a IA recebe o texto atual, o pedido e os fatos da nota. Ela deve mudar só o que foi pedido, sem alterar número, competência, valor, retenção e anexos, e sem inventar dados. Se a resposta vier fora do formato, o texto fica como estava.

## Configuração (Conta › E-mail para enviar notas)

Vale para todas as empresas da conta. Há duas formas:

- **Entrar com o Google / Entrar com a Microsoft** (recomendado): a pessoa autoriza o app só a enviar e-mails, sem senha guardada. O envio vai pela Gmail API ou pelo Microsoft Graph, por isso funciona mesmo com o "SMTP autenticado" desligado no Microsoft 365. Para os botões aparecerem, o servidor precisa das credenciais dos apps registrados no Google e na Microsoft: veja o [guia de ativação](12-entrar-com-google-microsoft.md). Pela Microsoft, o nome que aparece para o cliente é o da própria conta.
- **Usuário e senha (SMTP)**: a tela traz os dados de Gmail/Google Workspace, Outlook.com, Microsoft 365, Zoho, Hostinger, Locaweb, Yahoo, iCloud e Brevo, ou "Outro servidor".

- Gmail, Outlook, Yahoo, iCloud e Zoho com verificação em duas etapas pedem uma **senha de app** (não a senha normal da conta).
- Microsoft 365: o administrador precisa liberar o "SMTP autenticado" para a caixa.
- Ao salvar, o app manda um e-mail de teste para o próprio remetente.
- Nome do remetente em branco: o e-mail sai com o nome da empresa da nota (ex.: "Estudio Web Ltda" <contato@...>). "Respostas vão para" é opcional (Reply-To).

## Segurança

- Conta conectada: só o refresh token fica guardado, cifrado. O pedido de conexão é de uso único, vale 10 minutos e fica ligado à conta e ao navegador (cookie + `state` + PKCE). Desconectar revoga o acesso no Google.
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
