// "O que falta para emitir": lista objetiva de requisitos. Enquanto houver
// pendência, o usuário só pode preparar rascunhos.
import { municipio } from './tabelas.js';
import { cnpjValido } from '../util/documentos.js';
import { config } from '../config.js';

export function avaliarElegibilidade(prestador, certificado, { convenioEmissor = null } = {}, agora = new Date()) {
  const itens = [];
  const item = (id, ok, titulo, comoResolver, aviso = null) => itens.push({ id, ok, titulo, comoResolver: ok ? null : comoResolver, aviso });

  item('perfil', !!prestador && !!prestador.documento && !!prestador.municipioIbge && !!prestador.opSimpNac,
    'Perfil fiscal preenchido', 'Complete CNPJ, município e regime em Perfil.');
  const cnpjOk = !!prestador && prestador.tipoDocumento === 'CNPJ' && cnpjValido(prestador.documento);
  item('cnpj', cnpjOk, 'CNPJ válido', 'Informe o CNPJ da empresa em Perfil.');
  const regime = prestador?.opSimpNac;
  item('regime', regime === '2' || regime === '3', 'Regime com emissão disponível (MEI ou ME/EPP do Simples)',
    'Empresas fora do Simples (Lucro Presumido/Real) ainda não emitem pelo NotaVez; podem preparar rascunhos e emitir pelo Emissor Nacional.');
  item('municipio', !!municipio(prestador?.municipioIbge), 'Município do CNPJ informado',
    'Escolha em Perfil o município do endereço do seu CNPJ (regras E0041/E0084).');
  if (regime === '3') {
    item('simples', ['1', '2', '3'].includes(String(prestador?.regApTribSN || '')) && !!prestador?.pTotTribSN,
      'Dados do Simples preenchidos', 'Em Perfil, informe como você apura os tributos no Simples e o percentual aproximado de tributos (regra E0166).');
    // Não-MEI só emite pelo sistema nacional se o município do CNPJ for conveniado (E0037–E0039).
    const c = convenioEmissor;
    if (c?.situacao === 'inexistente' || (c?.situacao === 'ativo' && c.aderenteEmissorNacional === false)) {
      item('convenio', false, 'Município no Sistema Nacional da NFS-e',
        'O município do seu CNPJ não usa o Sistema Nacional para empresas do Simples (E0037/E0039). Emita pelo sistema da prefeitura; o NotaVez guarda seus rascunhos.');
    } else {
      item('convenio', true, 'Município no Sistema Nacional da NFS-e', null,
        c?.situacao === 'ativo' ? null : 'Ainda não confirmado: verificamos com o seu certificado antes de emitir.');
    }
  }

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
