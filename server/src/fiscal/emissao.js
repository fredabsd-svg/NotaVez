// Orquestra a emissão: rascunho → enviando → emitida | rejeitada | pendente.
// Regras de ouro:
//  1. Só "emitida" com chave de acesso devolvida pela Sefin Nacional.
//  2. Resposta incerta → "pendente"; antes de reenviar, consultar GET /dps/{id}.
//  3. O reenvio usa exatamente a mesma DPS assinada (mesmo Id): nunca gera duplicata.
//  4. Número da DPS nunca é reaproveitado entre notas.
import { randomUUID, createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { config, ambientesSefin } from '../config.js';
import { decifrar, decifrarBuffer } from '../security/cripto.js';
import { escolherPacote } from './regras/index.js';
import { municipioIncidencia } from './regras/comum.js';
import { montarDps, dataHoraBrasilia, hojeBrasilia, montarPedidoCancelamento, MOTIVOS_CANCELAMENTO } from './dps.js';
import { validarXsd } from './xsd.js';
import { assinarDps, assinarPedidoEvento } from './assinatura.js';
import { lerCertificado, verificarParaEmitente, verificarParaProcurador } from './certificado.js';
import { avaliarElegibilidade } from './elegibilidade.js';
import { explicar, explicarPorProcuracao, MOTIVOS_NAO_ENVIADA, DPS_DE_OUTRO_SISTEMA } from './mensagens.js';
import { mesmaDps } from './conferencia.js';
import { ErroApp, invalido } from '../util/erros.js';

const MAX_REENVIOS = 3;
const travas = new Set(); // evita dois envios simultâneos da mesma nota neste processo

export function lerNfse(xml) {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false });
  const doc = p.parse(xml);
  const inf = doc?.NFSe?.infNFSe;
  if (!inf) return null;
  return {
    chaveAcesso: String(inf['@Id'] || '').replace(/^NFS/, ''),
    nNFSe: inf.nNFSe ? String(inf.nNFSe) : null,
    dhProc: inf.dhProc ? String(inf.dhProc) : null,
    cStat: inf.cStat ? String(inf.cStat) : null,
    ambGer: inf.ambGer ? String(inf.ambGer) : null,
    xLocEmi: inf.xLocEmi ? String(inf.xLocEmi) : null,
    vLiq: inf.valores?.vLiq ? String(inf.valores.vLiq) : null,
    tpAmb: inf.DPS?.infDPS?.tpAmb ? String(inf.DPS.infDPS.tpAmb) : null,
  };
}

/**
 * Valida o rascunho sem enviar nada (tela de Revisão e antes da emissão).
 * `parametros` = convênios já consultados ({ convenioEmissor, convenioIncidencia }).
 */
export function validarRascunho(prestador, rascunho, hoje = hojeBrasilia(), parametros = {}) {
  const escolha = escolherPacote({ opSimpNac: prestador?.opSimpNac, competencia: rascunho.competencia });
  if (!escolha.pacote) return { ok: false, erros: [{ campo: 'regime', mensagem: escolha.motivo, regra: 'Nota Sem Stress' }], exigencias: null };
  const contexto = { hoje, parametros, municipioIncidencia: municipioIncidencia(prestador, rascunho) };
  const ctx = { prestador, nota: rascunho, ...contexto };
  const erros = escolha.pacote.validar(ctx);
  const pendRevisao = (rascunho.revisar || []).filter(Boolean);
  for (const c of pendRevisao) erros.push({ campo: c, mensagem: 'Confira este campo (nota clonada).', regra: 'Clonagem' });
  return { ok: erros.length === 0, erros, pacote: escolha.pacote, contexto, exigencias: escolha.pacote.exigencias(ctx) };
}

// Com procuração eletrônica NFS-e, o certificado é do procurador (outro CPF/CNPJ).
const problemasCertificado = (mat, certificado, prestador) => (certificado.procurador ? verificarParaProcurador(mat) : verificarParaEmitente(mat, prestador.documento));

function materialCertificado(certificado) {
  const pfx = decifrarBuffer(certificado._pfx);
  return lerCertificado(pfx, decifrar(certificado._senha));
}

export function criarServicoEmissao({ repo, fabricaCliente }) {
  const clientes = new Map();
  async function certificadoCompativel(prestador, certificado) {
    if (!certificado || (!certificado.procurador && certificado.documento !== prestador.documento)
      || !(new Date(certificado.validoDe) <= new Date()) || !(new Date(certificado.validoAte) > new Date())) {
      throw new ErroApp(403, 'Envie um certificado válido do emitente original para verificar esta nota.');
    }
    if ((await repo.certificadoEmissao(prestador))?.id !== certificado.id) {
      throw new ErroApp(409, 'O certificado foi removido ou atualizado. Verifique novamente com o certificado atual.');
    }
  }
  function fecharClientesDoPrestador(id) {
    for (const [k, c] of clientes) if (k.startsWith(`${id}:`)) { c.fechar?.(); clientes.delete(k); }
  }
  async function clienteSefin(prestador, certificado) {
    await certificadoCompativel(prestador, certificado);
    const chave = `${prestador.id}:${certificado.id}:${prestador.ambiente}`;
    if (!clientes.has(chave)) {
      for (const [k, c] of clientes) if (k.startsWith(`${prestador.id}:`) && !k.startsWith(`${prestador.id}:${certificado.id}:`)) { c.fechar?.(); clientes.delete(k); }
      const mat = materialCertificado(certificado);
      const problemas = problemasCertificado(mat, certificado, prestador);
      if (problemas.length) throw new ErroApp(403, 'O certificado atual não é compatível com o emitente original.', { problemas });
      const amb = ambientesSefin[prestador.ambiente];
      if (!amb) throw new ErroApp(409, 'Ambiente original da nota indisponível. Procure o suporte.');
      clientes.set(chave, fabricaCliente({
        baseUrl: amb.sefin, baseParametros: amb.parametros, baseAdn: amb.adn, rotasParametros: ambientesSefin.rotasParametros, ...mat, timeoutMs: config.timeoutSefinMs,
      }));
    }
    return clientes.get(chave);
  }

  // ---------- Parâmetros municipais (convênio), com cache de 12 h ----------
  const VALIDADE_CONVENIO_MS = 12 * 3600_000;
  async function convenio(prestador, certificado, ibge) {
    if (!ibge) return { situacao: 'desconhecido', motivo: 'sem_municipio' };
    // "convenio2": a primeira versão consultava uma rota que não é a oficial e guardava respostas erradas.
    const chave = `convenio2:${prestador.ambiente}:${ibge}`;
    const cache = await repo.parametroEmCache(chave, VALIDADE_CONVENIO_MS);
    if (cache) return { ...cache, cache: true };
    if (!certificado) return { situacao: 'desconhecido', motivo: 'sem_certificado' };
    // Certificado vencido ou de outro CNPJ: a consulta é só informativa e não pode
    // derrubar a revisão nem a emissão assistida (a elegibilidade já aponta o problema).
    let cliente;
    try { cliente = await clienteSefin(prestador, certificado); } catch (e) {
      if (e instanceof ErroApp) return { situacao: 'desconhecido', motivo: 'certificado' };
      throw e;
    }
    const r = await cliente.consultarConvenio(ibge);
    await repo.registrarChamada(null, 'parametros_convenio', { http: r.http, tipo: r.situacao, ms: r.ms, detalhe: `${ibge} ${r.motivo || ''}`.trim() });
    // Diagnóstico nos logs do servidor (só município, código HTTP e rota tentada; nada pessoal).
    if (r.situacao !== 'ativo') console.warn(`[receita] convênio ${ibge} (${prestador.ambiente}): ${r.situacao} ${r.motivo || ''} ${r.mensagem ? String(r.mensagem).slice(0, 160) : ''}`.trim());
    if (r.situacao !== 'desconhecido') await repo.guardarParametro(chave, { situacao: r.situacao, aderenteEmissorNacional: r.aderenteEmissorNacional ?? null });
    return r;
  }

  // Consulta só o que o pacote de regras precisa (o MEI não precisa de nada).
  async function parametrosPara(prestador, certificado, rascunho) {
    const escolha = escolherPacote({ opSimpNac: prestador.opSimpNac, competencia: rascunho.competencia });
    if (!escolha.pacote) return {};
    const precisa = escolha.pacote.precisaParametros({ prestador, nota: rascunho });
    const p = {};
    if (precisa.convenioEmissor) p.convenioEmissor = await convenio(prestador, certificado, prestador.municipioIbge);
    if (precisa.convenioIncidencia) {
      const ibge = municipioIncidencia(prestador, rascunho);
      p.convenioIncidencia = ibge === prestador.municipioIbge && p.convenioEmissor ? p.convenioEmissor : await convenio(prestador, certificado, ibge);
    }
    return p;
  }

  function revisao(prestador, nota) {
    return createHash('sha256').update(JSON.stringify({ prestador, rascunho: nota.rascunho, versao: nota.versao })).digest('hex');
  }
  async function validarNota(prestador, notaId, versao) {
    const nota = await repo.nota(prestador.id, notaId);
    if (!nota) throw new ErroApp(404, 'Nota não encontrada.');
    if (versao !== undefined && versao !== nota.versao) throw new ErroApp(409, 'O rascunho mudou. Faça uma nova revisão.');
    const v = await validar(prestador, nota.rascunho);
    const atual = await repo.nota(prestador.id, notaId);
    if (!atual || atual.versao !== nota.versao || (await repo.prestador(prestador.id))?.versao !== prestador.versao) throw new ErroApp(409, 'Os dados mudaram. Faça uma nova revisão.');
    return { ...v, versao: nota.versao, revisao: revisao(prestador, nota) };
  }

  async function validar(prestador, rascunho) {
    const certificado = await repo.certificadoEmissao(prestador);
    const parametros = await parametrosPara(prestador, certificado, rascunho);
    return validarRascunho(prestador, rascunho, hojeBrasilia(), parametros);
  }

  async function convenioEmissor(prestador) {
    if (!prestador || prestador.opSimpNac === '2' || !prestador.municipioIbge) return null;
    return convenio(prestador, await repo.certificadoEmissao(prestador), prestador.municipioIbge);
  }

  async function comTrava(notaId, fn) {
    if (travas.has(notaId)) throw new ErroApp(409, 'Esta nota já está sendo processada. Aguarde.');
    travas.add(notaId);
    try { return await fn(); } finally { travas.delete(notaId); }
  }

  const prazoPosse = () => new Date(Date.now() + Math.max(60_000, config.timeoutSefinMs * 3)).toISOString();
  const proxima = (vezes = 0) => new Date(Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(vezes, 7))).toISOString();
  const incerto = (nota) => new ErroApp(503,
    'O resultado desta operação ainda precisa ser confirmado. Use "Verificar situação"; não crie outra nota para o mesmo serviço.',
    { operacao: { notaId: nota.id, idDps: nota.idDps, ambiente: nota.ambiente }, resultadoIncerto: true });

  // Uma falha local depois do envio também é resultado desconhecido. O snapshot
  // e a posse persistida permitem retomar mesmo se gravar o resultado falhar.
  async function aplicarResultadoEnvio(nota, r) {
    const campos = { processamentoToken: null, processamentoAte: null, proximaVerificacaoEm: proxima(nota.verificacoes) };
    let estado = 'pendente';
    if (r.tipo === 'emitida') {
      const info = lerNfse(r.nfseXml);
      if (!r.chaveAcesso) throw incerto(nota);
      estado = 'emitida';
      await repo.removerImportadaDuplicada(nota.prestadorId, r.chaveAcesso, nota.id);
      Object.assign(campos, { chaveAcesso: r.chaveAcesso, nNfse: info?.nNFSe ?? null, nfseXml: r.nfseXml, emitidaEm: info?.dhProc || new Date().toISOString(), alertas: r.alertas?.length ? r.alertas.map(explicar) : null, erros: null });
    } else if (r.tipo === 'rejeitada' || (r.tipo === 'nao_enviada' && nota.situacao === 'enviando')) {
      estado = r.tipo === 'rejeitada' ? 'rejeitada' : 'rascunho';
      // Por procuração, a recusa ligada ao certificado fala da procuração (é ela que a pessoa precisa conferir).
      const porProcuracao = !!nota.contextoEmitente?.usaProcuracao;
      Object.assign(campos, { erros: r.tipo === 'rejeitada' ? r.erros.map(porProcuracao ? explicarPorProcuracao : explicar) : [{ codigo: 'NAO_ENVIADA', mensagem: MOTIVOS_NAO_ENVIADA[r.motivo] || 'Nada foi enviado.',
        proximoPasso: porProcuracao && r.motivo === 'autorizacao'
          ? 'Confira se o certificado do escritório está válido e se a procuração eletrônica NFS-e desta empresa está vigente no Portal de Serviços da Receita.'
          : 'Tente novamente em instantes.' }], idDps: null, serie: null, nDps: null, dpsXml: null, contextoEmitente: null });
    }
    const ok = await repo.transicionar(nota.id, nota.situacao, estado, campos, { versao: nota.versao, token: nota.processamentoToken });
    if (!ok) throw incerto(nota);
    const atual = await repo.notaPorId(nota.id);
    if (estado === 'emitida') await concluirSubstituicao(atual);
    return atual;
  }

  // ---------- Substituição: a nota nova leva a chave da original (grupo subst da DPS) ----------
  // A original precisa ser desta empresa, estar emitida e no mesmo ambiente.
  async function conferirSubstituicao(prestador, nota) {
    const s = nota.rascunho?.substituicao;
    if (!s) return;
    const original = await repo.notaPorChave(prestador.id, s.chave);
    if (!original || original.id === nota.id) throw new ErroApp(422, 'A NFS-e a substituir não foi encontrada nesta empresa.', { erros: [{ campo: 'substituicao', mensagem: 'A NFS-e a substituir não foi encontrada nesta empresa.', regra: 'Regra' }] });
    if (original.situacao !== 'emitida') throw new ErroApp(409, `A NFS-e nº ${original.nNfse || ''} não está mais emitida (situação: ${original.situacao}): não dá para substituí-la.`.replace('nº  ', ''));
    if ((original.ambiente || prestador.ambiente) !== prestador.ambiente) throw new ErroApp(409, 'A NFS-e a substituir é de outro ambiente da Receita (testes × produção).');
  }
  // Emitida a substituta, a Receita cancela a original (evento 105102): o app marca a original como substituída.
  async function concluirSubstituicao(nota) {
    const s = nota?.rascunho?.substituicao;
    if (!s?.chave || !nota.chaveAcesso) return;
    const original = await repo.notaPorChave(nota.prestadorId, s.chave);
    if (!original || original.situacao !== 'emitida') return;
    await repo.transicionar(original.id, 'emitida', 'cancelada', { cancelamento: { tipo: 'substituicao', em: new Date().toISOString(), cMotivo: s.cMotivo, xMotivo: s.xMotivo,
      substituta: { id: nota.id, chave: nota.chaveAcesso, nNfse: nota.nNfse } } });
  }

  // ---------- Cancelamento (evento e101101) ----------
  // Pedido assinado pelo certificado de emissão (da empresa ou do escritório, por procuração), em nome da empresa.
  // Resultado incerto: consulta o evento antes de dizer qualquer coisa; repetir o pedido é seguro.
  async function cancelar(prestador, notaId, { cMotivo, xMotivo } = {}) {
    return comTrava(notaId, async () => {
      const nota = await repo.nota(prestador.id, notaId);
      if (!nota) throw new ErroApp(404, 'Nota não encontrada.');
      if (nota.situacao === 'cancelada') throw new ErroApp(409, 'Esta NFS-e já está cancelada.');
      if (nota.situacao !== 'emitida' || !nota.chaveAcesso) throw new ErroApp(409, 'Só dá para cancelar uma NFS-e emitida.');
      const motivo = String(xMotivo ?? '').replace(/\s+/g, ' ').trim();
      const erros = {};
      if (!MOTIVOS_CANCELAMENTO[cMotivo]) erros.cMotivo = 'Escolha o motivo do cancelamento.';
      if (motivo.length < 15 || motivo.length > 255) erros.xMotivo = 'Explique o motivo com 15 a 255 caracteres.';
      if (Object.keys(erros).length) throw invalido('Confira o pedido de cancelamento.', erros);
      const certificado = await repo.certificadoEmissao(prestador);
      if (!certificado) throw new ErroApp(409, 'Para cancelar pelo app, envie o certificado A1 desta empresa (ou use o do escritório, por procuração eletrônica).', { acao: 'certificado' });
      const ambiente = nota.ambiente || prestador.ambiente;
      const emitente = { ...prestador, ambiente };
      const amb = ambientesSefin[ambiente];
      const { xml } = montarPedidoCancelamento({ tpAmb: amb.tpAmb, prestador, chave: nota.chaveAcesso, cMotivo: String(cMotivo), xMotivo: motivo,
        dhEvento: dataHoraBrasilia(), verAplic: config.versaoAplicativo });
      const cliente = await clienteSefin(emitente, certificado);
      const mat = materialCertificado(certificado);
      const problemas = problemasCertificado(mat, certificado, prestador);
      if (problemas.length) throw new ErroApp(403, 'O certificado não pode assinar este cancelamento.', { problemas });
      const assinado = assinarPedidoEvento(xml, mat);
      const xsd = await validarXsd(assinado, 'pedRegEvento_v1.01.xsd');
      if (!xsd.valido) throw new ErroApp(422, 'O pedido de cancelamento não passou na validação do leiaute oficial. Nada foi enviado.', { detalhes: xsd.erros.slice(0, 5) });

      let r = await cliente.registrarEvento(nota.chaveAcesso, assinado);
      await repo.registrarChamada(nota.id, 'cancelamento', r);
      if (r.tipo === 'incerto' || r.tipo === 'recusado') {
        // Resposta perdida, ou recusa por evento repetido: se o cancelamento já está na Receita, ele vale.
        const c = await cliente.consultarEvento(nota.chaveAcesso, '101101', 1);
        await repo.registrarChamada(nota.id, 'consulta_cancelamento', c);
        if (c.tipo === 'encontrado') r = { tipo: 'registrado', eventoXml: c.eventoXml };
      }
      if (r.tipo === 'registrado') {
        await repo.transicionar(nota.id, 'emitida', 'cancelada', { cancelamento: { tipo: 'cancelamento', em: new Date().toISOString(), cMotivo: String(cMotivo), xMotivo: motivo, eventoXml: r.eventoXml || null } });
        return await repo.notaPorId(nota.id);
      }
      const porProcuracao = !!prestador.usaProcuracao;
      if (r.tipo === 'recusado') throw new ErroApp(422, 'A Receita recusou o cancelamento. A NFS-e continua válida.', { erros: r.erros.map(porProcuracao ? explicarPorProcuracao : explicar) });
      if (r.tipo === 'nao_enviado') throw new ErroApp(503, `${(MOTIVOS_NAO_ENVIADA[r.motivo] || 'Nada foi enviado.').replace('Nada foi emitido.', 'Nada foi cancelado.')} A NFS-e continua válida.`);
      throw new ErroApp(503, 'A Receita não confirmou o cancelamento a tempo. Tente de novo em instantes: se ele já tiver sido registrado, o app reconhece e não cancela duas vezes.', { codigo: 'CANCELAMENTO_INCERTO' });
    });
  }

  async function emitir(prestador, notaId, aprovado = {}) {
    return comTrava(notaId, async () => {
      const nota = await repo.nota(prestador.id, notaId);
      if (!nota) throw new ErroApp(404, 'Nota não encontrada.');
      if (nota.situacao === 'emitida') throw new ErroApp(409, 'Esta nota já foi emitida. Para uma nova, use "Clonar".');
      if (nota.situacao === 'pendente' || nota.situacao === 'enviando') {
        throw new ErroApp(409, 'Esta nota está pendente de confirmação. Use "Verificar situação" — não envie de novo.');
      }
      if (aprovado.versao !== undefined && (nota.versao !== aprovado.versao || aprovado.revisao !== revisao(prestador, nota))) {
        throw new ErroApp(409, 'Os dados mudaram desde a revisão. Revise novamente antes de emitir.');
      }
      const certificado = await repo.certificadoEmissao(prestador);
      // Pendências de perfil/certificado antes de qualquer consulta: a resposta traz a lista certa.
      const previa = avaliarElegibilidade(prestador, certificado, {});
      const semConvenio = previa.pendencias.filter((p) => p.id !== 'convenio');
      if (semConvenio.length) throw new ErroApp(403, 'Ainda falta algo para emitir pelo Nota Sem Stress.', { pendencias: semConvenio });
      const parametros = await parametrosPara(prestador, certificado, nota.rascunho);
      const eleg = avaliarElegibilidade(prestador, certificado, { convenioEmissor: parametros.convenioEmissor });
      if (!eleg.podeEmitir) throw new ErroApp(403, 'Ainda falta algo para emitir pelo Nota Sem Stress.', { pendencias: eleg.pendencias });

      const v = validarRascunho(prestador, nota.rascunho, hojeBrasilia(), parametros);
      if (!v.ok) throw new ErroApp(422, 'Corrija os campos indicados antes de emitir.', { erros: v.erros });
      await conferirSubstituicao(prestador, nota);

      const amb = ambientesSefin[prestador.ambiente];
      const serie = prestador.serieDps || config.serieDpsPadrao;
      const nDPS = await repo.proximoNumeroDps(prestador.documento, prestador.ambiente, serie);
      const { xml, Id } = montarDps({
        tpAmb: amb.tpAmb, prestador, nota: nota.rascunho, pacote: v.pacote, serie, nDPS,
        dhEmi: dataHoraBrasilia(), verAplic: config.versaoAplicativo, contexto: v.contexto,
      });
      await certificadoCompativel(prestador, certificado);
      const mat = materialCertificado(certificado);
      const problemas = problemasCertificado(mat, certificado, prestador);
      if (problemas.length) throw new ErroApp(403, 'O certificado não pode assinar esta nota.', { problemas });
      const assinado = assinarDps(xml, mat);
      const xsd = await validarXsd(assinado);
      if (!xsd.valido) throw new ErroApp(422, 'A nota não passou na validação do leiaute oficial. Nada foi enviado.', { detalhes: xsd.erros.slice(0, 5) });

      const ok = await repo.transicionar(nota.id, ['rascunho', 'rejeitada'], 'enviando', {
        contextoEmitente: prestador, processamentoToken: randomUUID(), processamentoAte: prazoPosse(),
        ambiente: prestador.ambiente, serie, nDps: String(nDPS), idDps: Id, dpsXml: assinado,
        tentativas: 1, ultimoEnvioEm: new Date().toISOString(), erros: null,
      }, { versao: nota.versao, prestadorVersao: prestador.versao, certificadoId: certificado.id });
      if (!ok) throw new ErroApp(409, 'A nota mudou enquanto era enviada. Atualize a tela.');

      const envio = await repo.notaPorId(nota.id);
      try {
        const r = await (await clienteSefin(prestador, certificado)).enviarDps(assinado);
        await repo.registrarChamada(nota.id, 'envio', r);
        const resultado = await aplicarResultadoEnvio(envio, r);
        if (r.tipo === 'duplicada') return reconciliar(nota.id, prestador, certificado, { reenviar: false });
        return resultado;
      } catch {
        // Não deixa a aplicação sugerir outro envio após um erro de transporte,
        // auditoria ou persistência: o prazo persistido também cobre um restart.
        try { await repo.transicionar(nota.id, 'enviando', 'pendente', { processamentoToken: null, processamentoAte: null }, { versao: envio.versao }); } catch { /* recuperar após prazo */ }
        throw incerto(envio);
      }
    });
  }

  async function reconciliar(notaId, prestador, certificado, { reenviar = true } = {}) {
    let nota = await repo.notaPorId(notaId);
    if (!nota || !['pendente', 'enviando'].includes(nota.situacao)) return nota;
    if (nota.processamentoAte && new Date(nota.processamentoAte).getTime() > Date.now()) return nota;
    if (nota.situacao === 'enviando') {
      if (!await repo.transicionar(nota.id, 'enviando', 'pendente', { processamentoToken: null, processamentoAte: null }, { versao: nota.versao })) return await repo.notaPorId(notaId);
      nota = await repo.notaPorId(notaId);
    }
    const original = nota.contextoEmitente;
    if (!original || !nota.idDps || !await repo.xmlDps(nota.id)) throw incerto(nota);
    const contexto = { ...original, id: nota.prestadorId, ambiente: nota.ambiente };
    await certificadoCompativel(contexto, certificado);
    const token = randomUUID();
    if (!await repo.transicionar(nota.id, nota.situacao, 'pendente', {
      contextoEmitente: original, processamentoToken: token, processamentoAte: prazoPosse(),
      proximaVerificacaoEm: proxima(nota.verificacoes), verificacoes: nota.verificacoes + 1,
    }, { versao: nota.versao, certificadoId: certificado.id })) return await repo.notaPorId(notaId);
    nota = await repo.notaPorId(notaId);
    try {
      const cli = await clienteSefin(contexto, certificado);
      const c = await cli.consultarDps(nota.idDps);
      await repo.registrarChamada(nota.id, 'consulta_dps', c);
      if (c.tipo === 'encontrada' && c.chaveAcesso) {
        const n = await cli.consultarNfse(c.chaveAcesso);
        await repo.registrarChamada(nota.id, 'consulta_nfse', n);
        // A nota encontrada precisa ser a da DPS que este app enviou: outro sistema da empresa pode ter
        // usado a mesma série e o mesmo número, e aí a Receita devolve a nota dele.
        const confere = n.tipo === 'ok' ? mesmaDps(await repo.xmlDps(nota.id), n.nfseXml) : null;
        if (confere === true) {
          const info = lerNfse(n.nfseXml);
          // Se a pessoa já trouxe o XML desta mesma NFS-e pelo Emissor Nacional, a nota do app a substitui.
          await repo.removerImportadaDuplicada(nota.prestadorId, c.chaveAcesso, nota.id);
          if (await repo.transicionar(nota.id, 'pendente', 'emitida', {
            chaveAcesso: c.chaveAcesso, nNfse: info?.nNFSe ?? null, emitidaEm: info?.dhProc || new Date().toISOString(),
            nfseXml: n.nfseXml, erros: null, processamentoToken: null, processamentoAte: null,
          }, { versao: nota.versao, token })) await concluirSubstituicao(await repo.notaPorId(nota.id));
        } else if (confere === false) {
          // A numeração é de uma nota de outro sistema: a deste app não foi emitida. Volta a poder ser
          // enviada, com novo número (e a orientação de trocar a série).
          await repo.transicionar(nota.id, 'pendente', 'rejeitada', {
            erros: [DPS_DE_OUTRO_SISTEMA], idDps: null, serie: null, nDps: null, dpsXml: null, contextoEmitente: null,
            processamentoToken: null, processamentoAte: null,
          }, { versao: nota.versao, token });
        }
        // Sem o XML (ou sem conseguir ler a DPS dentro dele) não dá para afirmar de quem é a nota:
        // continua pendente e a próxima verificação tenta de novo.
      } else if (c.tipo === 'nao_encontrada' && reenviar) {
        const desde = Date.now() - new Date(nota.ultimoEnvioEm).getTime();
        if (Number.isFinite(desde) && desde >= config.esperaAntesDeReenviarMs && nota.tentativas <= MAX_REENVIOS) {
          // Reenvio apenas depois de uma resposta explícita de ausência. Nunca
          // muda XML/identidade e nunca reenvia uma consulta inconclusiva.
          // A consulta é assíncrona: validade e autorização do A1 podem mudar
          // enquanto aguardamos. O CAS protege também contra outro processo.
          await certificadoCompativel(contexto, certificado);
          if (!await repo.transicionar(nota.id, 'pendente', 'pendente', { tentativas: nota.tentativas + 1, ultimoEnvioEm: new Date().toISOString(), processamentoAte: prazoPosse() }, { versao: nota.versao, token, certificadoId: certificado.id })) return await repo.notaPorId(nota.id);
          nota = await repo.notaPorId(nota.id);
          const r = await cli.enviarDps(await repo.xmlDps(nota.id));
          await repo.registrarChamada(nota.id, 'reenvio', r);
          await aplicarResultadoEnvio(nota, r);
        }
      }
      return await repo.notaPorId(nota.id);
    } catch (e) {
      if (e instanceof ErroApp && !e.extra?.resultadoIncerto) throw e;
      throw incerto(nota);
    } finally {
      const atual = await repo.notaPorId(notaId);
      if (atual?.processamentoToken === token) {
        try { await repo.liberarProcessamento(notaId, token); } catch { throw incerto(nota); }
      }
    }
  }

  async function verificar(prestador, notaId) {
    return comTrava(notaId, async () => {
      const nota = await repo.nota(prestador.id, notaId);
      if (!nota) throw new ErroApp(404, 'Nota não encontrada.');
      if (!['pendente', 'enviando'].includes(nota.situacao)) return nota;
      const certificado = await repo.certificadoEmissao(prestador);
      return reconciliar(notaId, prestador, certificado);
    });
  }

  // Busca o XML oficial de uma nota emitida cuja consulta inicial falhou.
  async function buscarXml(prestador, notaId) {
    const nota = await repo.nota(prestador.id, notaId);
    if (!nota || nota.situacao !== 'emitida' || nota.temXml) return nota;
    const certificado = await repo.certificadoEmissao(prestador);
    if (!certificado) return nota;
    if (!nota.contextoEmitente) throw incerto(nota);
    const n = await (await clienteSefin({ ...nota.contextoEmitente, id: nota.prestadorId, ambiente: nota.ambiente }, certificado)).consultarNfse(nota.chaveAcesso);
    await repo.registrarChamada(nota.id, 'consulta_nfse', n);
    if (n.tipo === 'ok') await repo.transicionar(nota.id, 'emitida', 'emitida', { nfseXml: n.nfseXml });
    return await repo.notaPorId(nota.id);
  }

  // XML trazido do Emissor Nacional: com certificado disponível, busca a versão oficial na Receita.
  // null = não foi possível conferir (sem certificado ou falha); a nota fica "não conferida".
  async function conferirNfse(prestador, chave) {
    const certificado = await repo.certificadoEmissao(prestador);
    if (!certificado) return null;
    let cliente;
    try { cliente = await clienteSefin(prestador, certificado); } catch { return null; }
    let r;
    try { r = await cliente.consultarNfse(chave); } catch (e) { r = { tipo: 'falha', detalhe: e.message }; }
    await repo.registrarChamada(null, 'consulta_nfse_importada', r);
    return r;
  }

  // Notas recebidas pela empresa (ADN), com o certificado ativo dela.
  async function distribuirDfe(prestador, nsu) {
    const certificado = await repo.certificadoEmissao(prestador);
    if (!certificado) throw new ErroApp(409, 'Envie o certificado A1 desta empresa (ou use o do escritório, por procuração eletrônica) para baixar as notas tomadas.', { acao: 'certificado' });
    const cliente = await clienteSefin(prestador, certificado);
    if (typeof cliente.distribuirDfe !== 'function') throw new ErroApp(503, 'Consulta de notas tomadas indisponível neste servidor.');
    return cliente.distribuirDfe(nsu, prestador.documento);
  }

  // Tarefa periódica: verifica notas pendentes (consulta primeiro, sempre).
  async function verificarPendentes() {
    for (const nota of await repo.pendentes()) {
      if (travas.has(nota.id)) continue;
      const prestador = await repo.prestador(nota.prestadorId);
      const certificado = prestador && await repo.certificadoEmissao(prestador);
      if (!certificado) {
        await repo.transicionar(nota.id, nota.situacao, 'pendente', { processamentoToken: null, processamentoAte: null, proximaVerificacaoEm: proxima(nota.verificacoes), verificacoes: nota.verificacoes + 1 }, { versao: nota.versao });
        continue;
      }
      try { await comTrava(nota.id, () => reconciliar(nota.id, prestador, certificado)); } catch {
        const atual = await repo.notaPorId(nota.id);
        if (atual && (!atual.processamentoAte || new Date(atual.processamentoAte).getTime() <= Date.now())) await repo.transicionar(atual.id, atual.situacao, atual.situacao, { proximaVerificacaoEm: proxima(atual.verificacoes), verificacoes: atual.verificacoes + 1 }, { versao: atual.versao });
      }
    }
  }

  return { emitir, cancelar, verificar, validar, validarNota, fecharClientesDoPrestador, convenioEmissor, buscarXml, verificarPendentes, distribuirDfe, conferirNfse, fecharClientes: () => { for (const c of clientes.values()) c.fechar?.(); clientes.clear(); } };
}
