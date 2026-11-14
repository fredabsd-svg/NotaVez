// "O que falta para emitir": lista objetiva de requisitos. Enquanto houver
// pendência, o usuário só pode preparar rascunhos.
import { municipio } from './tabelas.js';
import { cnpjValido } from '../util/documentos.js';
import { config } from '../config.js';

export function avaliarElegibilidade(prestador, certificado, { convenioEmissor = null } = {}, agora = new Date()) {
  const itens = [];
  const item = (id, ok, titulo, comoResolver, aviso = null) => itens.push({ id, ok, titulo, comoResolver: ok ? null : comoResolver, aviso });

  item('perfil', !!prestador && !!prestador.documento && !!prestador.municipioIbge && !!prestador.opSimpNac,
    'Dados fiscais da empresa preenchidos', 'Complete CNPJ, município e regime em Dados da empresa.');
  const cnpjOk = !!prestador && prestador.tipoDocumento === 'CNPJ' && cnpjValido(prestador.documento);
  item('cnpj', cnpjOk, 'CNPJ válido', 'Informe o CNPJ da empresa em Dados da empresa.');
  const regime = prestador?.opSimpNac;
  item('regime', ['1', '2', '3'].includes(regime), 'Regime tributário informado', 'Escolha em Dados da empresa: MEI, ME/EPP do Simples ou Lucro Presumido/Real.');
  item('municipio', !!municipio(prestador?.municipioIbge), 'Município do CNPJ informado',
    'Escolha em Dados da empresa o município do endereço do seu CNPJ (regras E0041/E0084).');
  if (regime === '1') {
    item('federais', !!prestador?.cstPisCofins && (prestador.cstPisCofins !== '01' || (!!prestador.aliqPis && !!prestador.aliqCofins))
      && !!prestador?.pTotTribFed && !!prestador?.pTotTribMun,
    'PIS/COFINS e tributos aproximados preenchidos', 'Em Dados da empresa, informe a situação e as alíquotas de PIS/COFINS e os percentuais aproximados de tributos.');
  }
  if (regime === '1' || regime === '3') {
    if (regime === '3') item('simples', ['1', '2', '3'].includes(String(prestador?.regApTribSN || '')) && !!prestador?.pTotTribSN,
      'Dados do Simples preenchidos', 'Em Dados da empresa, informe como você apura os tributos no Simples e o percentual aproximado de tributos (regra E0166).');
    // Convênio do município (E0037–E0039): informativo, nunca bloqueia. A LC 214/2025 obriga os municípios a aderir
    // ao padrão nacional e o Simples emite por ele em todos os municípios desde 01/11/2026 (Res. CGSN 191/2026);
    // se ainda assim a Receita recusar, nenhuma nota é gerada e a mensagem dela explica o que fazer.
    const c = convenioEmissor;
    const recusaIndicada = regime === '1' && (c?.situacao === 'inexistente' || (c?.situacao === 'ativo' && c.aderenteEmissorNacional === false));
    item('convenio', true, 'Município no Sistema Nacional da NFS-e', null,
      recusaIndicada ? 'A consulta à Receita indicou que o município ainda não liberou o emissor nacional para esta empresa. Você pode tentar emitir: se a Receita recusar (E0037/E0039), nenhuma nota é gerada e o app mostra o motivo.'
        : null);
  }

  const temCert = !!certificado;
  if (prestador?.usaProcuracao) {
    // Procuração eletrônica NFS-e: assina e conecta com o certificado do procurador da conta.
    item('certificado', temCert, 'Certificado do procurador (escritório) enviado',
      'Envie o certificado A1 do escritório ou do contador em Empresas › Certificado do escritório, ou volte a usar o certificado desta empresa.',
      temCert ? `Assina como procurador: ${certificado.titular || ''}. A procuração eletrônica (serviço NFS-e) desta empresa precisa estar vigente no Portal de Serviços da Receita; a Receita confere a cada envio.` : null);
    if (temCert) item('certificado_validade', new Date(certificado.validoAte) > agora, 'Certificado do procurador dentro da validade', 'Renove o certificado do escritório e envie o novo arquivo.');
  } else {
    item('certificado', temCert, 'Certificado digital A1 (e-CNPJ) enviado',
      'Envie o arquivo .pfx/.p12 do e-CNPJ A1 em Dados da empresa › Certificado, ou use o certificado do escritório por procuração eletrônica. Login gov.br não substitui o certificado na API.');
    if (temCert) {
      item('certificado_validade', new Date(certificado.validoAte) > agora, 'Certificado dentro da validade', 'Renove o certificado com sua autoridade certificadora e envie o novo arquivo.');
      item('certificado_cnpj', !!prestador && certificado.documento === prestador.documento, 'Certificado do mesmo CNPJ do perfil',
        'Sem procuração eletrônica, a nota precisa ser assinada pelo certificado do próprio CNPJ emitente (regra E0718).');
    }
  }
  const ambiente = prestador?.ambiente || config.ambientePadrao;
  item('ambiente', ambiente === 'producao_restrita' || config.producaoLiberada, 'Ambiente liberado',
    'A produção ainda não foi liberada neste servidor. Use o ambiente de testes (produção restrita).');

  return { podeEmitir: itens.every((i) => i.ok), ambiente, itens, pendencias: itens.filter((i) => !i.ok) };
}
