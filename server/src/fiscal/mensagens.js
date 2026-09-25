// Tradução dos códigos oficiais (ANEXO_I, abas RN_RECEPCAO_DPS e RN DPS_NFS-e)
// para linguagem comum, com o próximo passo. Códigos sem tradução mostram a
// descrição oficial — nunca escondemos o motivo real.
const T = {
  E0006: ['O ambiente (teste/produção) da nota não confere com o servidor da Receita.', 'Avise o suporte do NotaVez.'],
  E0008: ['O horário da nota ficou à frente do horário da Receita.', 'Tente de novo em alguns minutos.'],
  E0010: ['A série da nota não é permitida para aplicativos próprios.', 'Ajuste a série no seu perfil (1 a 49999).'],
  E0014: ['Já existe uma nota com esta numeração.', 'Não emita de novo: vamos consultar a nota existente.'],
  E0015: ['A data da competência é posterior à data de emissão.', 'Escolha a data em que o serviço foi prestado (hoje ou antes).'],
  E0041: ['O município do perfil não é o do endereço do seu CNPJ de MEI.', 'Corrija o município no perfil.'],
  E0080: ['O CNPJ do emitente é inválido.', 'Confira o CNPJ do perfil.'],
  E0082: ['A Receita não encontrou o seu CNPJ na data da competência.', 'Confira o CNPJ e a data da competência.'],
  E0121: ['A nota foi enviada com o seu nome, e a Receita não aceita.', 'Avise o suporte do NotaVez.'],
  E0174: ['Para MEI, o regime especial deve ser "Nenhum".', 'Avise o suporte do NotaVez.'],
  E0188: ['O CNPJ do cliente é inválido.', 'Corrija o CNPJ no cadastro do cliente.'],
  E0190: ['A Receita não encontrou o CNPJ do cliente.', 'Confira o CNPJ no cadastro do cliente.'],
  E0202: ['O cliente não pode ser o seu próprio CNPJ.', 'Escolha outro cliente.'],
  E0206: ['O CPF do cliente é inválido.', 'Corrija o CPF no cadastro do cliente.'],
  E0207: ['A Receita não encontrou o CPF do cliente.', 'Confira o CPF no cadastro do cliente.'],
  E0235: ['Cliente com CNPJ precisa de endereço completo.', 'Complete o endereço no cadastro do cliente.'],
  E0240: ['O CEP do cliente não pertence ao município informado.', 'Corrija o CEP ou o município do cliente.'],
  E0310: ['O código do serviço não existe na lista nacional.', 'Escolha outro serviço.'],
  E0583: ['MEI não pode ter ISS retido.', 'Avise o suporte do NotaVez.'],
  E0600: ['MEI não informa alíquota de ISS.', 'Avise o suporte do NotaVez.'],
  E0676: ['MEI não informa tributos federais na nota.', 'Avise o suporte do NotaVez.'],
  E0710: ['MEI não informa percentual do Simples Nacional.', 'Avise o suporte do NotaVez.'],
  E0714: ['A assinatura digital da nota não confere.', 'Reenvie o certificado digital no perfil.'],
  E0715: ['O certificado digital está vencido, revogado ou com cadeia inválida.', 'Renove ou reenvie o certificado A1.'],
  E0716: ['O certificado digital está fora do padrão aceito (ICP-Brasil com CNPJ/CPF).', 'Use um e-CNPJ A1 ICP-Brasil.'],
  E0717: ['A nota foi enviada sem assinatura.', 'Avise o suporte do NotaVez.'],
  E0718: ['A nota precisa ser assinada com o certificado do próprio emitente.', 'Envie o certificado A1 do CNPJ do perfil.'],
  E1200: ['O certificado de conexão foi recusado pela Receita.', 'Confira se é um e-CNPJ A1 ICP-Brasil válido.'],
  E1203: ['O certificado digital está vencido.', 'Renove o certificado A1.'],
  E1205: ['A cadeia do certificado não foi reconhecida.', 'Use um certificado ICP-Brasil.'],
  E1207: ['O certificado digital foi revogado.', 'Emita um novo certificado A1.'],
  E1208: ['O certificado não é ICP-Brasil.', 'Use um certificado ICP-Brasil.'],
  E1209: ['O certificado não tem CNPJ ou CPF.', 'Use um e-CNPJ A1.'],
  E1235: ['A nota não passou na validação de formato da Receita.', 'Avise o suporte do NotaVez.'],
};

export function explicar(m) {
  const t = T[m.codigo];
  return {
    codigo: m.codigo,
    oficial: m.descricao,
    complemento: m.complemento ?? null,
    mensagem: t ? t[0] : (m.descricao || 'A Receita recusou a nota.'),
    proximoPasso: t ? t[1] : 'Revise os dados da nota. Se o problema continuar, fale com o suporte.',
  };
}

export const MOTIVOS_NAO_ENVIADA = {
  conexao: 'Não conseguimos conectar com a Receita. Nada foi enviado.',
  autorizacao: 'A Receita não autorizou a conexão com o seu certificado. Nada foi emitido.',
  limite: 'A Receita pediu para aguardar antes de novos envios. Nada foi emitido.',
  requisicao: 'A Receita não aceitou o envio. Nada foi emitido.',
};
