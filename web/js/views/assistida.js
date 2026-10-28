// Emitir pelo Emissor Nacional (site oficial, com usuário e senha ou gov.br), para
// quem não tem certificado A1: o app mostra os dados na ordem das telas do site,
// com botão de copiar, e depois recebe o XML da NFS-e emitida.
import { h, aviso, icone, ICONES } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { rascunhoLocal, removerLocal } from '../store.js';
import { salvarAgora } from '../rascunho.js';
import { ir } from '../app.js';

async function copiar(texto, botao) {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    // Navegadores sem a API de área de transferência.
    const area = h('textarea', { style: 'position:fixed;opacity:0' });
    area.value = texto;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  botao.textContent = 'Copiado ✓';
  setTimeout(() => { botao.textContent = 'Copiar'; }, 1500);
}

// Lê o XML escolhido e envia; com notaId, o rascunho passa a ser a nota emitida.
export function botaoImportarXml({ notaId = null, texto = 'Enviar o XML da nota emitida', classe = 'btn btn-primario' } = {}) {
  const arquivo = h('input', { type: 'file', accept: '.xml,application/xml,text/xml', hidden: true });
  const botao = h('button', { class: classe, type: 'button', onclick: () => arquivo.click() }, icone(ICONES.baixar), texto);
  arquivo.addEventListener('change', async () => {
    const f = arquivo.files?.[0];
    arquivo.value = '';
    if (!f) return;
    botao.disabled = true;
    try {
      const { nota } = await api('POST', '/api/notas/importar', { xml: await f.text(), ...(notaId ? { notaId } : {}) });
      if (notaId) await removerLocal(notaId).catch(() => {});
      aviso(`NFS-e nº ${nota.nNfse || ''} guardada no histórico.`);
      ir(`/notas/${nota.id}`, { substituir: !!notaId });
    } catch (e) {
      if (e instanceof ErroApi && e.dados?.notaId) { aviso(e.message); ir(`/notas/${e.dados.notaId}`); return; }
      aviso(e instanceof ErroApi && e.status === 0 ? 'Sem internet: envie o XML quando tiver conexão.' : e.message, 9000);
    } finally { botao.disabled = false; }
  });
  return h('span', {}, botao, arquivo);
}

export async function tela({ id }) {
  try { await salvarAgora(id); } catch (e) {
    if (e instanceof ErroApi && e.status === 409) { aviso('Resolva o conflito no rascunho antes de continuar.'); ir(`/nota/${id}`, { substituir: true }); return null; }
    if (!(e instanceof ErroApi && e.status === 0)) throw e;
  }
  const local = await rascunhoLocal(id);
  if (!navigator.onLine || (local && !local.sincronizado)) {
    return {
      titulo: 'Emissor Nacional', voltar: true, aba: 'inicio',
      node: h('div', { class: 'cartao cartao-alerta', role: 'alert' }, h('p', {}, 'Conecte-se à internet e aguarde o rascunho salvar na conta para montar o roteiro.'),
        h('a', { class: 'btn', href: `#/nota/${id}` }, 'Voltar ao rascunho')),
    };
  }
  let d;
  try { d = await api('GET', `/api/notas/${id}/assistida`); } catch (e) {
    if (e instanceof ErroApi && e.dados?.notaId) { ir(`/notas/${id}`, { substituir: true }); return null; }
    throw e;
  }

  const secao = (s, i) => h('section', { class: 'cartao roteiro' },
    h('h2', {}, `${i + 2}. ${s.titulo}`),
    h('p', { class: 'suave' }, s.descricao),
    s.campos.length ? h('dl', { class: 'dados' }, s.campos.map((c) => h('div', {},
      h('dt', {}, c.rotulo),
      h('dd', { class: 'copiavel' },
        h('span', { style: 'white-space:pre-wrap' }, c.valor),
        c.copiar ? h('button', { class: 'btn btn-pequeno', type: 'button', 'aria-label': `Copiar ${c.rotulo}`, onclick: (e) => copiar(c.copiar, e.currentTarget) }, 'Copiar') : null),
      c.ajuda ? h('dd', { class: 'suave', style: 'font-weight:400' }, c.ajuda) : null))) : null);

  return {
    titulo: 'Emitir pelo Emissor Nacional', voltar: true, aba: 'inicio',
    node: h('div', {},
      h('p', {}, 'Sem certificado digital, quem emite é você, no site oficial da NFS-e, entrando com ', h('strong', {}, 'CPF/CNPJ e senha ou gov.br'),
        '. Aqui estão os dados desta nota na ordem das telas do Emissor Nacional, com botão de copiar. O Nota Sem Stress não pede nem guarda essa senha.'),
      d.homologacao ? h('p', { class: 'cartao cartao-alerta' }, h('strong', {}, 'Empresa no ambiente de testes: '), 'o link abre o Emissor Nacional de produção restrita, onde as notas não têm validade jurídica.') : null,
      d.avisos.length ? h('section', { class: 'cartao cartao-alerta', role: 'alert' },
        h('strong', {}, 'Confira antes de emitir'),
        h('ul', {}, d.avisos.map((a) => h('li', {}, a.mensagem, a.regra && /^E\d{4}$/.test(a.regra) ? h('span', { class: 'suave' }, ` (regra ${a.regra})`) : null))),
        h('p', { class: 'suave' }, 'O Emissor Nacional aplica as mesmas regras e deve recusar a nota com esses pontos.'),
        h('a', { class: 'btn btn-pequeno', href: `#/nota/${id}` }, 'Corrigir o rascunho')) : null,
      h('section', { class: 'cartao roteiro' },
        h('h2', {}, '1. Entre no Emissor Nacional'),
        h('p', {}, 'Abra o site oficial em outra aba, entre com usuário e senha ou gov.br e escolha "Emissão completa".'),
        d.emissorNacional ? h('a', { class: 'btn btn-primario', href: d.emissorNacional, target: '_blank', rel: 'noopener' }, icone(ICONES.abrir), 'Abrir o Emissor Nacional') : null),
      d.roteiro.filter((s) => s.campos.length).map(secao),
      h('section', { class: 'cartao roteiro' },
        h('h2', {}, `${d.roteiro.filter((s) => s.campos.length).length + 2}. Emita e traga o XML`),
        h('p', {}, 'Confira o resumo no site e emita. Na nota emitida, use ', h('strong', {}, 'Baixar XML'), ' e envie o arquivo aqui: a nota entra no histórico com o DANFSe em PDF e pode ser clonada no mês que vem.'),
        botaoImportarXml({ notaId: id }),
        h('p', { class: 'suave' }, 'Enquanto o XML não chegar, esta nota continua como rascunho no app.')),
      h('a', { class: 'btn btn-texto', href: `#/nota/${id}/revisao` }, 'Voltar à revisão')),
  };
}
