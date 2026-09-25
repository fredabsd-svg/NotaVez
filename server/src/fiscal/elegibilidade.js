// "O que falta para emitir": lista objetiva de requisitos. Enquanto houver
// pendência, o usuário só pode preparar rascunhos.
import { municipio } from './tabelas.js';
import { cnpjValido } from '../util/documentos.js';
import { config } from '../config.js';

export function avaliarElegibilidade(prestador, certificado, agora = new Date()) {
  const itens = [];
  const item = (id, ok, titulo, comoResolver) => itens.push({ id, ok, titulo, comoResolver: ok ? null : comoResolver });

  item('perfil', !!prestador && !!prestador.documento && !!prestador.municipioIbge && !!prestador.opSimpNac,
    'Perfil fiscal preenchido', 'Complete CNPJ, município e regime em Perfil.');
  const cnpjOk = !!prestador && prestador.tipoDocumento === 'CNPJ' && cnpjValido(prestador.documento);
  item('cnpj', cnpjOk, 'CNPJ válido', 'Informe o CNPJ do seu MEI em Perfil.');
  item('mei', prestador?.opSimpNac === '2', 'Regime MEI',
    'Nesta versão a emissão direta é só para MEI. ME/EPP e outros regimes podem preparar rascunhos.');
  item('municipio', !!municipio(prestador?.municipioIbge), 'Município do CNPJ informado',
    'Escolha em Perfil o município do endereço do seu CNPJ (regra E0041).');

  const temCert = !!certificado;
  item('certificado', temCert, 'Certificado digital A1 (e-CNPJ) enviado',
    'Envie o arquivo .pfx/.p12 do seu e-CNPJ A1 em Perfil › Certificado. Login gov.br não substitui o certificado na API.');
  if (temCert) {
    item('certificado_validade', new Date(certificado.validoAte) > agora, 'Certificado dentro da validade', 'Renove o certificado com sua autoridade certificadora e envie o novo arquivo.');
    item('certificado_cnpj', !!prestador && certificado.documento === prestador.documento, 'Certificado do mesmo CNPJ do perfil',
      'A nota precisa ser assinada pelo certificado do próprio CNPJ emitente (regra E0718).');
  }
  const ambiente = prestador?.ambiente || config.ambientePadrao;
  item('ambiente', ambiente === 'producao_restrita' || config.producaoLiberada, 'Ambiente liberado',
    'A produção ainda não foi liberada neste servidor. Use o ambiente de testes (produção restrita).');

  return { podeEmitir: itens.every((i) => i.ok), ambiente, itens, pendencias: itens.filter((i) => !i.ok) };
}
