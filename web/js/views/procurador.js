// Certificado do escritório (procurador): um A1 para emitir e baixar notas
// tomadas de todas as empresas que concederam procuração eletrônica NFS-e.
import { h, aviso, data, copiarTexto, plural } from '../ui.js';
import { api } from '../api.js';
import { formularioCertificado } from './perfil.js';

// Quais empresas da conta usam o certificado do escritório: marcar e salvar, todas de uma vez.
function empresasPorProcuracaoEmLote(lista) {
  const caixas = new Map();
  const itens = lista.map((e) => {
    const cx = h('input', { type: 'checkbox', checked: !!e.porProcuracao });
    caixas.set(e.id, cx);
    return h('li', {}, h('label', {}, cx, h('span', { class: 'item-corpo' },
      h('span', { class: 'item-titulo' }, e.nome || 'Empresa sem nome'),
      h('span', { class: 'item-sub' }, [e.documentoFormatado, e.regime, e.certificadoProprio ? 'tem certificado próprio' : 'sem certificado próprio'].filter(Boolean).join(' · ')))));
  });
  const status = h('p', { class: 'suave', role: 'status' });
  const contar = () => { status.textContent = `${[...caixas.values()].filter((c) => c.checked).length} de ${plural(lista.length, 'empresa marcada', 'empresas marcadas')}.`; };
  for (const cx of caixas.values()) cx.addEventListener('change', contar);
  contar();
  const salvar = h('button', { class: 'btn btn-primario', type: 'button', onclick: async () => {
    const ligar = lista.filter((e) => !e.porProcuracao && caixas.get(e.id).checked).map((e) => e.id);
    const desligar = lista.filter((e) => e.porProcuracao && !caixas.get(e.id).checked).map((e) => e.id);
    if (!ligar.length && !desligar.length) { aviso('Nada mudou: as empresas já estão como marcado.'); return; }
    if (desligar.length && !confirm(`Desligar a procuração de ${plural(desligar.length, 'empresa', 'empresas')}? Elas voltam a precisar do próprio certificado para emitir.`)) return;
    salvar.disabled = true;
    try {
      if (ligar.length) await api('PUT', '/api/procurador/empresas', { empresas: ligar, ativa: true });
      if (desligar.length) await api('PUT', '/api/procurador/empresas', { empresas: desligar, ativa: false });
      aviso(`Procuração atualizada em ${plural(ligar.length + desligar.length, 'empresa', 'empresas')}.`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (e) { aviso(e.message, 7000); salvar.disabled = false; }
  } }, 'Salvar empresas por procuração');
  return h('section', { 'aria-labelledby': 'h-lote' },
    h('h3', { id: 'h-lote' }, 'Empresas atendidas por procuração'),
    h('p', { class: 'suave' }, 'Marque as empresas que concederam a procuração eletrônica NFS-e ao escritório: elas passam a emitir e a ter as notas buscadas com o certificado acima. A Receita confere a procuração a cada envio.'),
    h('button', { class: 'btn btn-pequeno', type: 'button', onclick: () => { for (const e of lista) if (!e.certificadoProprio) caixas.get(e.id).checked = true; contar(); } }, 'Marcar todas sem certificado próprio'),
    h('ul', { class: 'lista-marcar' }, itens),
    status, salvar);
}

export async function tela() {
  const { certificado: c, empresasPorProcuracao, empresas } = await api('GET', '/api/procurador');
  const lista = c && empresas ? (await api('GET', '/api/empresas')).empresas : [];
  const form = formularioCertificado({
    url: '/api/procurador/certificado', ajuda: 'Formato .pfx ou .p12: e-CNPJ do escritório ou e-CPF do contador.',
    textoBotao: c ? 'Trocar certificado do escritório' : 'Enviar certificado do escritório',
    consentimentoTexto: 'Autorizo o Nota Sem Stress a guardar este certificado de forma criptografada e a usá-lo somente para assinar, transmitir e consultar as notas das empresas que eu marcar como "por procuração", inclusive para buscar na Receita, de tempos em tempos e de forma automática, as notas emitidas e recebidas por elas. Posso remover a qualquer momento.',
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
        h('p', { class: 'suave' }, `${empresasPorProcuracao} de ${plural(empresas, 'empresa usa', 'empresas usam')} este certificado.`),
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
        h('li', {}, 'Aqui no app, marque a empresa em ', h('strong', {}, '"Empresas atendidas por procuração"'), ', logo abaixo (ou em Dados da empresa › Certificado digital).')),
      c ? h('button', { class: 'btn btn-pequeno', type: 'button', onclick: (e) => copiarTexto(documento, e.currentTarget) }, `Copiar ${c.tipoDocumento} do procurador`) : null,
      lista.length ? empresasPorProcuracaoEmLote(lista) : null,
      h('p', { class: 'suave' }, 'O app não consegue conferir a procuração antes: a Receita confere a cada envio. Se ela não estiver vigente, a nota é recusada e nada é emitido.'),
      h('h3', {}, c ? 'Trocar o certificado' : 'Enviar o certificado do escritório'),
      c ? h('details', {}, h('summary', {}, 'Trocar certificado do escritório'), form) : form),
  };
}
