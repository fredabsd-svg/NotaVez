// Certificado do escritório (procurador): um A1 para emitir e baixar notas
// tomadas de todas as empresas que concederam procuração eletrônica NFS-e.
import { h, aviso, data, copiarTexto } from '../ui.js';
import { api } from '../api.js';
import { formularioCertificado } from './perfil.js';

export async function tela() {
  const { certificado: c, empresasPorProcuracao, empresas } = await api('GET', '/api/procurador');
  const form = formularioCertificado({
    url: '/api/procurador/certificado', ajuda: 'Formato .pfx ou .p12: e-CNPJ do escritório ou e-CPF do contador.',
    textoBotao: c ? 'Trocar certificado do escritório' : 'Enviar certificado do escritório',
    consentimentoTexto: 'Autorizo o Nota Sem Stress a guardar este certificado de forma criptografada e a usá-lo somente para assinar, transmitir e consultar as notas das empresas que eu marcar como "por procuração". Posso remover a qualquer momento.',
    aoEnviar: () => { aviso('Certificado do escritório guardado com segurança.'); location.reload(); },
  });
  const documento = c?.documentoFormatado?.replace(/\W/g, '');
  return {
    titulo: 'Certificado do escritório', voltar: true, aba: 'empresas',
    node: h('div', {},
      h('p', {}, 'Desde 1º/11/2026 a Receita aceita ', h('strong', {}, 'procuração eletrônica NFS-e'), ': com ela, o escritório ou o contador usa ',
        h('strong', {}, 'o próprio certificado'), ' para emitir notas e baixar as notas tomadas das empresas clientes, sem precisar do certificado de cada uma.'),
      c ? h('section', { class: 'cartao cartao-ok' },
        h('strong', {}, 'Certificado do escritório ativo'), h('p', {}, c.titular),
        h('p', { class: 'suave' }, `${c.documentoFormatado} · válido até ${data(c.validoAte)} · ${c.emissor}`),
        h('p', { class: 'suave' }, `${empresasPorProcuracao} de ${empresas} empresa(s) usando este certificado.`),
        h('button', { class: 'btn btn-texto btn-perigo', type: 'button', onclick: async () => {
          if (!confirm('Remover o certificado do escritório? As empresas por procuração param de emitir até você enviar outro.')) return;
          await api('DELETE', '/api/procurador/certificado', {});
          location.reload();
        } }, 'Remover certificado do escritório'))
        : null,
      h('h3', {}, 'Como cada empresa concede a procuração'),
      h('ol', { class: 'passos' },
        h('li', {}, 'O responsável pela empresa entra no ', h('a', { href: 'https://servicos.receitafederal.gov.br/', target: '_blank', rel: 'noopener' }, 'Portal de Serviços da Receita Federal'), ' e escolhe ', h('strong', {}, '"Nova Autorização"'), '.'),
        h('li', {}, 'Informa como procurador o ', c ? h('strong', {}, `${c.tipoDocumento} ${c.documentoFormatado}`) : 'CPF ou CNPJ do certificado do escritório', ' e o período de vigência.'),
        h('li', {}, 'Escolhe o serviço ', h('strong', {}, 'NFS-e'), ', confirma e assina a autorização.'),
        h('li', {}, 'Aqui no app, em ', h('strong', {}, 'Dados da empresa › Certificado digital'), ', marque "Certificado do escritório (procuração eletrônica)".')),
      c ? h('button', { class: 'btn btn-pequeno', type: 'button', onclick: (e) => copiarTexto(documento, e.currentTarget) }, `Copiar ${c.tipoDocumento} do procurador`) : null,
      h('p', { class: 'suave' }, 'O app não consegue conferir a procuração antes: a Receita confere a cada envio. Se ela não estiver vigente, a nota é recusada e nada é emitido.'),
      h('h3', {}, c ? 'Trocar o certificado' : 'Enviar o certificado do escritório'),
      c ? h('details', {}, h('summary', {}, 'Trocar certificado do escritório'), form) : form),
  };
}
