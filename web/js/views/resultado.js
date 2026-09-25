import { h, moeda, data, dataHora, chaveFormatada, aviso, icone, ICONES, situacaoSelo } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { ir, estado } from '../app.js';

async function compartilhar(n) {
  const url = n.documentos?.consultaPublica;
  const texto = `NFS-e nº ${n.nNfse || ''} — ${moeda(n.valor)}\nChave de acesso: ${n.chaveAcesso}${url ? `\nConsulte e baixe o DANFSe: ${url}` : ''}`;
  try {
    let arquivos;
    if (n.documentos?.xml) {
      const r = await fetch(`/api/notas/${n.id}/xml`, { credentials: 'same-origin' });
      if (r.ok) arquivos = [new File([await r.blob()], `NFSe-${n.chaveAcesso}.xml`, { type: 'application/xml' })];
    }
    if (arquivos && navigator.canShare?.({ files: arquivos })) await navigator.share({ title: 'NFS-e', text: texto, files: arquivos });
    else if (navigator.share) await navigator.share({ title: 'NFS-e', text: texto, url: url || undefined });
    else { await navigator.clipboard.writeText(texto); aviso('Dados da nota copiados.'); }
  } catch (e) {
    if (e?.name !== 'AbortError') aviso('Não foi possível compartilhar.');
  }
}

function blocoEmitida(n) {
  return [
    h('dl', { class: 'dados cartao' },
      h('div', {}, h('dt', {}, 'Número da NFS-e'), h('dd', {}, n.nNfse || '—')),
      h('div', {}, h('dt', {}, 'Chave de acesso'), h('dd', { class: 'chave' }, chaveFormatada(n.chaveAcesso)),
        h('button', { class: 'btn btn-pequeno btn-texto', type: 'button', onclick: async () => { await navigator.clipboard?.writeText(n.chaveAcesso); aviso('Chave copiada.'); } }, icone(ICONES.copiar), 'Copiar chave')),
      h('div', {}, h('dt', {}, 'Emitida em'), h('dd', {}, dataHora(n.emitidaEm))),
      h('div', {}, h('dt', {}, 'Cliente'), h('dd', {}, n.clienteNome || '—')),
      h('div', {}, h('dt', {}, 'Valor'), h('dd', {}, moeda(n.valor)))),
    n.homologacao ? h('p', { class: 'cartao cartao-alerta' }, 'Emitida no ambiente de testes: sem validade jurídica.') : null,
    h('h3', {}, 'Documentos oficiais'),
    h('button', { class: 'btn btn-primario', type: 'button', onclick: () => compartilhar(n) }, icone(ICONES.compartilhar), 'Compartilhar'),
    n.documentos?.xml !== undefined ? h('a', { class: 'btn', href: `/api/notas/${n.id}/xml`, download: `NFSe-${n.chaveAcesso}.xml` }, icone(ICONES.baixar), 'Baixar XML da NFS-e') : null,
    n.documentos?.consultaPublica ? h('a', { class: 'btn', href: n.documentos.consultaPublica, target: '_blank', rel: 'noopener' }, icone(ICONES.abrir), 'DANFSe na Consulta Pública') : null,
    h('p', { class: 'suave' }, 'O DANFSe (versão para imprimir) é gerado pelo portal oficial a partir da chave de acesso.'),
  ];
}

function montar(n, { detalhe = false } = {}) {
  const icones = { emitida: '✓', rejeitada: '✕', pendente: '…', enviando: '…', rascunho: '!' };
  const titulos = {
    emitida: estado.demo ? 'Emitida (simulação)' : 'Emitida',
    rejeitada: 'Rejeitada',
    pendente: 'Pendente de confirmação',
    enviando: 'Pendente de confirmação',
    rascunho: n.erros?.some((e) => e.codigo === 'NAO_ENVIADA') ? 'Não enviada' : 'Rascunho',
  };
  const orientacao = {
    emitida: 'A Receita confirmou a sua NFS-e. Compartilhe com o cliente.',
    rejeitada: 'A Receita recusou. Nenhuma nota fiscal foi emitida. Veja o motivo, corrija e envie de novo.',
    pendente: 'A Receita não confirmou a tempo. A nota pode ter sido emitida ou não. NÃO emita de novo: vamos consultar a Receita antes de qualquer reenvio.',
    enviando: 'Aguardando a resposta da Receita. Não emita de novo.',
    rascunho: n.erros?.some((e) => e.codigo === 'NAO_ENVIADA') ? 'Nada foi enviado à Receita. Esta nota ainda não foi emitida.' : 'Esta nota ainda não foi emitida.',
  };
  const acoes = [];
  if (n.situacao === 'emitida') acoes.push(...blocoEmitida(n));
  if (n.situacao === 'rejeitada' || n.situacao === 'rascunho') {
    if (n.erros?.length) {
      acoes.push(h('div', { class: 'cartao cartao-erro' }, h('ul', { class: 'lista' }, n.erros.map((e) => h('li', { style: 'margin:8px 0' },
        h('strong', {}, e.mensagem), e.proximoPasso ? h('p', { style: 'margin:4px 0' }, 'O que fazer: ', e.proximoPasso) : null,
        e.codigo && e.codigo !== 'NAO_ENVIADA' ? h('p', { class: 'suave', style: 'margin:0' }, `Código oficial ${e.codigo}${e.oficial && e.oficial !== e.mensagem ? `: ${e.oficial}` : ''}`) : null)))));
    }
    acoes.push(h('a', { class: 'btn btn-primario', href: `#/nota/${n.id}` }, n.situacao === 'rejeitada' ? 'Corrigir e enviar de novo' : 'Abrir rascunho'));
  }
  if (n.situacao === 'pendente' || n.situacao === 'enviando') {
    const b = h('button', {
      class: 'btn btn-primario', type: 'button',
      onclick: async () => {
        b.disabled = true;
        b.textContent = 'Consultando a Receita…';
        try {
          const r = await api('POST', `/api/notas/${n.id}/verificar`, {});
          if (r.nota.situacao === 'pendente') aviso('Ainda sem confirmação. Tentaremos de novo automaticamente.');
          raiz.replaceChildren(...montar(r.nota, { detalhe }).childNodes);
        } catch (e) {
          aviso(e instanceof ErroApi ? e.message : 'Não foi possível consultar agora.');
          b.disabled = false; b.textContent = 'Verificar situação agora';
        }
      },
    }, icone(ICONES.atualizar), 'Verificar situação agora');
    acoes.push(b, h('p', { class: 'suave' }, 'O NotaVez também verifica sozinho a cada poucos minutos.'));
  }
  if (n.alertas?.length) acoes.push(h('div', { class: 'cartao cartao-alerta' }, h('strong', {}, 'Avisos da Receita:'), h('ul', {}, n.alertas.map((a) => h('li', {}, `${a.mensagem} (${a.codigo})`)))));

  const extras = [];
  if (detalhe) {
    extras.push(h('h3', {}, 'Detalhes'), h('dl', { class: 'dados cartao' },
      h('div', {}, h('dt', {}, 'Situação'), h('dd', {}, situacaoSelo(n))),
      h('div', {}, h('dt', {}, 'Cliente'), h('dd', {}, n.tomadorExibicao ? `${n.tomadorExibicao.nome} (${n.tomadorExibicao.tipo} ${n.tomadorExibicao.documentoExibicao})` : '—')),
      h('div', {}, h('dt', {}, 'Serviço'), h('dd', {}, n.servicoNacional ? `${n.servicoNacional.codigo} — ${n.servicoNacional.descricao}` : '—')),
      h('div', {}, h('dt', {}, 'Descrição'), h('dd', { style: 'white-space:pre-wrap;font-weight:400' }, n.descricao || '—')),
      h('div', {}, h('dt', {}, 'Competência'), h('dd', {}, data(n.competencia))),
      h('div', {}, h('dt', {}, 'Valor'), h('dd', {}, moeda(n.valor))),
      n.dps ? h('div', {}, h('dt', {}, 'DPS (identificação do envio)'), h('dd', { class: 'chave' }, `Série ${n.dps.serie} · nº ${n.dps.numero}`)) : null));
    if (n.historicoEnvio?.length) {
      const nomes = { envio: 'Envio', reenvio: 'Reenvio da mesma DPS', consulta_dps: 'Consulta da DPS', consulta_nfse: 'Consulta da NFS-e' };
      extras.push(h('details', {}, h('summary', {}, 'Registro de comunicação com a Receita'),
        h('ul', { class: 'lista' }, n.historicoEnvio.map((c) => h('li', { class: 'suave', style: 'margin:6px 0' },
          `${dataHora(c.criado_em)} · ${nomes[c.operacao] || c.operacao}: ${c.resultado}${c.codigos ? ` (${c.codigos})` : ''}`)))));
    }
    if (n.situacao !== 'pendente' && n.situacao !== 'enviando') {
      extras.push(h('button', {
        class: 'btn', type: 'button',
        onclick: async () => {
          try {
            const { nota } = await api('POST', `/api/notas/${n.id}/clonar`, {});
            aviso('Nova nota criada. Confira os campos destacados.');
            ir(`/nota/${nota.id}`);
          } catch (e) { aviso(e.message); }
        },
      }, icone(ICONES.clonar), 'Clonar esta nota'));
    }
  }

  const raiz = h('div', { class: `r-${n.situacao === 'enviando' ? 'pendente' : n.situacao}` },
    h('div', { class: 'resultado', role: detalhe ? undefined : 'alert' },
      h('div', { class: 'resultado-icone', 'aria-hidden': 'true' }, icones[n.situacao]),
      h('h2', {}, titulos[n.situacao]),
      h('p', {}, orientacao[n.situacao])),
    ...acoes, ...extras,
    detalhe ? null : h('a', { class: 'btn btn-texto', href: '#/' }, 'Voltar ao início'));
  return raiz;
}

export async function tela({ id }) {
  let n = estado.ultimoResultado?.id === id ? estado.ultimoResultado : null;
  if (!n) {
    try { n = (await api('GET', `/api/notas/${id}`)).nota; } catch (e) {
      if (e instanceof ErroApi && e.status === 0) {
        return { titulo: 'Resultado', node: h('div', { class: 'cartao cartao-alerta', role: 'alert' }, h('h2', {}, 'Sem confirmação'), h('p', {}, 'A conexão caiu durante o envio. Não emita de novo. Quando a internet voltar, abra "Notas" para ver a situação.')) };
      }
      throw e;
    }
  }
  estado.ultimoResultado = null;
  return { titulo: 'Resultado', aba: 'notas', node: montar(n) };
}

export async function detalhe({ id }) {
  const { nota } = await api('GET', `/api/notas/${id}`);
  if (['rascunho'].includes(nota.situacao) && !nota.erros?.length) { ir(`/nota/${id}`, { substituir: true }); return null; }
  return { titulo: nota.nNfse ? `NFS-e nº ${nota.nNfse}` : 'Nota', aba: 'notas', voltar: true, node: montar(nota, { detalhe: true }) };
}
