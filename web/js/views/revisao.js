import { h, moeda, data, carregando, aviso } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { rascunhoLocal, removerLocal } from '../store.js';
import { salvarAgora } from '../rascunho.js';
import { ir, estado } from '../app.js';
import { pendenciasCartao } from './inicio.js';

const CAMPO_TELA = {
  competencia: 'Competência', valor: 'Valor', descricao: 'Descrição', tributacao: 'Tributação', servico: 'Serviço',
  tomador: 'Cliente', 'tomador.documento': 'Cliente', 'tomador.nome': 'Cliente', 'tomador.endereco': 'Endereço do cliente',
  'tomador.email': 'E-mail do cliente', 'tomador.fone': 'Telefone do cliente', localPrestacao: 'Local da prestação',
  'perfil.cnpj': 'Perfil', 'perfil.municipio': 'Perfil', 'perfil.regime': 'Perfil', regime: 'Regime', cTribMun: 'Código municipal', cNBS: 'Código NBS',
};

// Resumo da tributação que vai na nota, conforme o regime e o que a regra oficial exige.
function textoTributacao(p, r, ex, valor) {
  if (p.opSimpNac === '2') return ['ISS tributável, sem retenção. MEI: impostos pagos no DAS (sem alíquota na nota).'];
  if (p.opSimpNac !== '3') return ['Regime ainda sem emissão direta no NotaVez.'];
  const reg = { 1: 'tudo pelo Simples', 2: 'federais pelo Simples, ISS fora', 3: 'tudo fora do Simples' }[p.regApTribSN] || '—';
  const pct = (v) => `${Number(v).toFixed(2).replace('.', ',')}%`;
  const aliq = r.pAliq ?? (r.issRetido && p.regApTribSN === '1' ? p.aliqIssSN : null);
  const partes = [`ME/EPP (${reg}). `, r.issRetido ? 'ISS retido pelo cliente. ' : 'ISS não retido. '];
  const a = ex?.aliquota;
  if (a?.modo === 'obrigatoria') partes.push(aliq ? `Alíquota do ISS na nota: ${pct(aliq)}` : 'Alíquota do ISS: falta informar', aliq && r.issRetido ? ` (≈ ${moeda(Number(valor) * Number(aliq) / 100)} retidos). ` : '. ');
  else if (a?.modo === 'proibida') partes.push('Alíquota não vai na nota: ', a.motivo, ' ');
  const tot = r.pTotTribSN ?? p.pTotTribSN;
  partes.push(h('span', { class: 'suave', style: 'display:block' }, `Tributos aproximados (Simples): ${tot ? pct(tot) : 'falta informar'}`));
  return partes;
}

export async function tela({ id }) {
  try { await salvarAgora(id); } catch (e) { if (e instanceof ErroApi && e.status === 409) { ir(`/notas/${id}`, { substituir: true }); return null; } }
  const local = await rascunhoLocal(id);
  if (!navigator.onLine || (local && !local.sincronizado && !local.noServidor)) {
    return {
      titulo: 'Revisão', voltar: true, aba: 'inicio',
      node: h('div', { class: 'cartao cartao-alerta', role: 'alert' },
        h('h2', {}, 'Sem internet'),
        h('p', {}, 'Esta nota ', h('strong', {}, 'ainda não foi emitida'), '. Ela está salva como rascunho neste aparelho.'),
        h('p', {}, 'Quando a conexão voltar, abra o rascunho e toque em "Emitir nota".'),
        h('a', { class: 'btn', href: `#/nota/${id}` }, 'Voltar ao rascunho')),
    };
  }

  const [{ nota }, validacao, perfil] = await Promise.all([
    api('GET', `/api/notas/${id}`),
    api('POST', `/api/notas/${id}/validar`, {}),
    api('GET', '/api/perfil'),
  ]);
  if (!['rascunho', 'rejeitada'].includes(nota.situacao)) { ir(`/notas/${id}`, { substituir: true }); return null; }
  const r = nota.rascunho;
  const t = nota.tomadorExibicao;
  const eleg = perfil.elegibilidade;
  const pode = validacao.ok && eleg.podeEmitir;

  const linha = (rotulo, ...valor) => h('div', {}, h('dt', {}, rotulo), h('dd', {}, ...valor));
  const end = t?.endereco;
  const erros = validacao.erros.length
    ? h('div', { class: 'cartao cartao-erro', role: 'alert' },
      h('h2', { style: 'font-size:19px;margin-top:0' }, 'Corrija antes de emitir'),
      h('ul', {}, validacao.erros.map((e) => h('li', {}, h('strong', {}, `${CAMPO_TELA[e.campo] || 'Nota'}: `), e.mensagem,
        e.regra && /^E\d{4}$/.test(e.regra) ? h('span', { class: 'suave' }, ` (regra ${e.regra})`) : null))),
      h('a', { class: 'btn btn-pequeno', href: `#/nota/${id}` }, 'Corrigir'))
    : null;

  const botao = h('button', { class: 'btn btn-primario btn-grande', type: 'button', disabled: !pode }, 'Emitir nota');
  const corpo = h('div', {},
    nota.homologacao ? h('p', { class: 'cartao cartao-alerta' }, h('strong', {}, 'Ambiente de testes: '), 'a nota será emitida sem validade jurídica.') : null,
    erros,
    pendenciasCartao(eleg),
    h('div', { class: 'cartao' },
      h('p', { class: 'suave', style: 'margin:0' }, 'Valor do serviço'),
      h('p', { class: 'valor-grande', style: 'margin:4px 0 0' }, moeda(nota.valor))),
    h('div', { class: 'cartao' }, h('dl', { class: 'dados' },
      linha('Emitente (você)', `${perfil.perfil.nome || ''} ${perfil.perfil.documentoFormatado}`, h('br'), h('span', { class: 'suave' }, `${perfil.perfil.municipio?.nome || ''} - ${perfil.perfil.municipio?.uf || ''} · ${{ 2: 'MEI', 3: 'ME/EPP (Simples Nacional)', 1: 'Lucro Presumido/Real' }[perfil.perfil.opSimpNac] || ''}`)),
      linha('Cliente', t ? `${t.nome}` : '—', t ? h('br') : null, t ? h('span', { class: 'suave' }, `${t.tipo} ${t.documentoExibicao}`) : null,
        end?.cep ? h('span', { class: 'suave', style: 'display:block' }, `${end.logradouro}, ${end.numero}${end.complemento ? ` ${end.complemento}` : ''} · ${end.bairro} · CEP ${end.cep}`) : null),
      linha('Serviço (lista nacional)', nota.servicoNacional ? `${nota.servicoNacional.codigo} — ${nota.servicoNacional.descricao}` : '—'),
      linha('Descrição na nota', h('span', { style: 'white-space:pre-wrap;font-weight:400' }, r.descricao || '—')),
      linha('Competência', data(r.competencia)),
      linha('Local da prestação', nota.localPrestacao ? `${nota.localPrestacao.nome} - ${nota.localPrestacao.uf}` : '—'),
      linha('Tributação', ...textoTributacao(perfil.perfil, r, validacao.exigencias, nota.valor)),
      r.cTribMun ? linha('Código municipal', r.cTribMun) : null,
      r.cNBS ? linha('Código NBS', r.cNBS) : null)),
    h('div', { class: 'rodape-fixo' },
      botao,
      h('a', { class: 'btn btn-texto', href: `#/nota/${id}` }, 'Editar'),
      !pode ? h('p', { class: 'suave centro' }, 'O rascunho continua salvo. Nada foi enviado à Receita.') : null));

  botao.addEventListener('click', async () => {
    botao.disabled = true;
    const espera = h('div', { role: 'alert', 'aria-busy': 'true' }, carregando('Enviando para a Receita… Não feche o aplicativo.'));
    corpo.replaceChildren(espera);
    try {
      const res = await api('POST', `/api/notas/${id}/emitir`, {});
      estado.ultimoResultado = res.nota;
      if (res.nota.situacao !== 'rascunho' && res.nota.situacao !== 'rejeitada') await removerLocal(id);
    } catch (e) {
      if (e instanceof ErroApi && [403, 409, 422].includes(e.status)) {
        aviso(e.message);
        ir(`/nota/${id}/revisao`, { substituir: true });
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        return;
      }
      // Falha de rede DURANTE o envio: não sabemos se chegou. A tela de resultado consulta a situação.
      estado.ultimoResultado = null;
    }
    ir(`/nota/${id}/resultado`, { substituir: true });
  });

  return { titulo: 'Revisão', voltar: true, aba: 'inicio', node: corpo };
}
