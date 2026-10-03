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
import { montarDps, dataHoraBrasilia, hojeBrasilia } from './dps.js';
import { validarXsd } from './xsd.js';
import { assinarDps } from './assinatura.js';
import { lerCertificado, verificarParaEmitente } from './certificado.js';
import { avaliarElegibilidade } from './elegibilidade.js';
import { explicar, MOTIVOS_NAO_ENVIADA } from './mensagens.js';
import { ErroApp } from '../util/erros.js';

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

function materialCertificado(certificado) {
  const pfx = decifrarBuffer(certificado._pfx);
  return lerCertificado(pfx, decifrar(certificado._senha));
}

export function criarServicoEmissao({ repo, fabricaCliente }) {
  const clientes = new Map();
  function certificadoCompativel(prestador, certificado) {
    if (!certificado || certificado.documento !== prestador.documento
      || !(new Date(certificado.validoDe) <= new Date()) || !(new Date(certificado.validoAte) > new Date())) {
      throw new ErroApp(403, 'Envie um certificado válido do emitente original para verificar esta nota.');
    }
    if (repo.certificadoAtivo(prestador.id)?.id !== certificado.id) {
      throw new ErroApp(409, 'O certificado foi removido ou atualizado. Verifique novamente com o certificado atual.');
    }
  }
  function fecharClientesDoPrestador(id) {
    for (const [k, c] of clientes) if (k.startsWith(`${id}:`)) { c.fechar?.(); clientes.delete(k); }
  }
  function clienteSefin(prestador, certificado) {
    certificadoCompativel(prestador, certificado);
    const chave = `${prestador.id}:${certificado.id}:${prestador.ambiente}`;
    if (!clientes.has(chave)) {
      for (const [k, c] of clientes) if (k.startsWith(`${prestador.id}:`) && !k.startsWith(`${prestador.id}:${certificado.id}:`)) { c.fechar?.(); clientes.delete(k); }
      const mat = materialCertificado(certificado);
      const problemas = verificarParaEmitente(mat, prestador.documento);
      if (problemas.length) throw new ErroApp(403, 'O certificado atual não é compatível com o emitente original.', { problemas });
      const amb = ambientesSefin[prestador.ambiente];
      if (!amb) throw new ErroApp(409, 'Ambiente original da nota indisponível. Procure o suporte.');
      clientes.set(chave, fabricaCliente({
        baseUrl: amb.sefin, baseParametros: amb.parametros, rotasParametros: ambientesSefin.rotasParametros, ...mat, timeoutMs: config.timeoutSefinMs,
      }));
    }
    return clientes.get(chave);
  }

  // ---------- Parâmetros municipais (convênio), com cache de 12 h ----------
  const VALIDADE_CONVENIO_MS = 12 * 3600_000;
  async function convenio(prestador, certificado, ibge) {
    if (!ibge) return { situacao: 'desconhecido', motivo: 'sem_municipio' };
    const chave = `convenio:${prestador.ambiente}:${ibge}`;
    const cache = repo.parametroEmCache(chave, VALIDADE_CONVENIO_MS);
    if (cache) return { ...cache, cache: true };
    if (!certificado) return { situacao: 'desconhecido', motivo: 'sem_certificado' };
    const r = await clienteSefin(prestador, certificado).consultarConvenio(ibge);
    repo.registrarChamada(null, 'parametros_convenio', { http: r.http, tipo: r.situacao, ms: r.ms, detalhe: ibge });
    if (r.situacao !== 'desconhecido') repo.guardarParametro(chave, { situacao: r.situacao, aderenteEmissorNacional: r.aderenteEmissorNacional ?? null });
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
    const nota = repo.nota(prestador.id, notaId);
    if (!nota) throw new ErroApp(404, 'Nota não encontrada.');
    if (versao !== undefined && versao !== nota.versao) throw new ErroApp(409, 'O rascunho mudou. Faça uma nova revisão.');
    const v = await validar(prestador, nota.rascunho);
    const atual = repo.nota(prestador.id, notaId);
    if (!atual || atual.versao !== nota.versao || repo.prestador(prestador.id)?.versao !== prestador.versao) throw new ErroApp(409, 'Os dados mudaram. Faça uma nova revisão.');
    return { ...v, versao: nota.versao, revisao: revisao(prestador, nota) };
  }

  async function validar(prestador, rascunho) {
    const certificado = repo.certificadoAtivo(prestador.id);
    const parametros = await parametrosPara(prestador, certificado, rascunho);
    return validarRascunho(prestador, rascunho, hojeBrasilia(), parametros);
  }

  async function convenioEmissor(prestador) {
    if (!prestador || prestador.opSimpNac === '2' || !prestador.municipioIbge) return null;
    return convenio(prestador, repo.certificadoAtivo(prestador.id), prestador.municipioIbge);
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
      Object.assign(campos, { chaveAcesso: r.chaveAcesso, nNfse: info?.nNFSe ?? null, nfseXml: r.nfseXml, emitidaEm: info?.dhProc || new Date().toISOString(), alertas: r.alertas?.length ? r.alertas.map(explicar) : null, erros: null });
    } else if (r.tipo === 'rejeitada' || (r.tipo === 'nao_enviada' && nota.situacao === 'enviando')) {
      estado = r.tipo === 'rejeitada' ? 'rejeitada' : 'rascunho';
      Object.assign(campos, { erros: r.tipo === 'rejeitada' ? r.erros.map(explicar) : [{ codigo: 'NAO_ENVIADA', mensagem: MOTIVOS_NAO_ENVIADA[r.motivo] || 'Nada foi enviado.', proximoPasso: 'Tente novamente em instantes.' }], idDps: null, serie: null, nDps: null, dpsXml: null, contextoEmitente: null });
    }
    const ok = repo.transicionar(nota.id, nota.situacao, estado, campos, { versao: nota.versao, token: nota.processamentoToken });
    if (!ok) throw incerto(nota);
    return repo.notaPorId(nota.id);
  }

  async function emitir(prestador, notaId, aprovado = {}) {
    return comTrava(notaId, async () => {
      const nota = repo.nota(prestador.id, notaId);
      if (!nota) throw new ErroApp(404, 'Nota não encontrada.');
      if (nota.situacao === 'emitida') throw new ErroApp(409, 'Esta nota já foi emitida. Para uma nova, use "Clonar".');
      if (nota.situacao === 'pendente' || nota.situacao === 'enviando') {
        throw new ErroApp(409, 'Esta nota está pendente de confirmação. Use "Verificar situação" — não envie de novo.');
      }
      if (aprovado.versao !== undefined && (nota.versao !== aprovado.versao || aprovado.revisao !== revisao(prestador, nota))) {
        throw new ErroApp(409, 'Os dados mudaram desde a revisão. Revise novamente antes de emitir.');
      }
      const certificado = repo.certificadoAtivo(prestador.id);
      const parametros = await parametrosPara(prestador, certificado, nota.rascunho);
      const eleg = avaliarElegibilidade(prestador, certificado, { convenioEmissor: parametros.convenioEmissor });
      if (!eleg.podeEmitir) throw new ErroApp(403, 'Ainda falta algo para emitir pelo Nota Sem Stress.', { pendencias: eleg.pendencias });

      const v = validarRascunho(prestador, nota.rascunho, hojeBrasilia(), parametros);
      if (!v.ok) throw new ErroApp(422, 'Corrija os campos indicados antes de emitir.', { erros: v.erros });

      const amb = ambientesSefin[prestador.ambiente];
      const serie = prestador.serieDps || config.serieDpsPadrao;
      const nDPS = repo.proximoNumeroDps(prestador.documento, prestador.ambiente, serie);
      const { xml, Id } = montarDps({
        tpAmb: amb.tpAmb, prestador, nota: nota.rascunho, pacote: v.pacote, serie, nDPS,
        dhEmi: dataHoraBrasilia(), verAplic: config.versaoAplicativo, contexto: v.contexto,
      });
      certificadoCompativel(prestador, certificado);
      const mat = materialCertificado(certificado);
      const problemas = verificarParaEmitente(mat, prestador.documento);
      if (problemas.length) throw new ErroApp(403, 'O certificado não pode assinar esta nota.', { problemas });
      const assinado = assinarDps(xml, mat);
      const xsd = await validarXsd(assinado);
      if (!xsd.valido) throw new ErroApp(422, 'A nota não passou na validação do leiaute oficial. Nada foi enviado.', { detalhes: xsd.erros.slice(0, 5) });

      const ok = repo.transicionar(nota.id, ['rascunho', 'rejeitada'], 'enviando', {
        contextoEmitente: prestador, processamentoToken: randomUUID(), processamentoAte: prazoPosse(),
        ambiente: prestador.ambiente, serie, nDps: String(nDPS), idDps: Id, dpsXml: assinado,
        tentativas: 1, ultimoEnvioEm: new Date().toISOString(), erros: null,
      }, { versao: nota.versao, prestadorVersao: prestador.versao, certificadoId: certificado.id });
      if (!ok) throw new ErroApp(409, 'A nota mudou enquanto era enviada. Atualize a tela.');

      const envio = repo.notaPorId(nota.id);
      try {
        const r = await clienteSefin(prestador, certificado).enviarDps(assinado);
        repo.registrarChamada(nota.id, 'envio', r);
        const resultado = await aplicarResultadoEnvio(envio, r);
        if (r.tipo === 'duplicada') return reconciliar(nota.id, prestador, certificado, { reenviar: false });
        return resultado;
      } catch {
        // Não deixa a aplicação sugerir outro envio após um erro de transporte,
        // auditoria ou persistência: o prazo persistido também cobre um restart.
        try { repo.transicionar(nota.id, 'enviando', 'pendente', { processamentoToken: null, processamentoAte: null }, { versao: envio.versao }); } catch { /* recuperar após prazo */ }
        throw incerto(envio);
      }
    });
  }

  async function reconciliar(notaId, prestador, certificado, { reenviar = true } = {}) {
    let nota = repo.notaPorId(notaId);
    if (!nota || !['pendente', 'enviando'].includes(nota.situacao)) return nota;
    if (nota.processamentoAte && new Date(nota.processamentoAte).getTime() > Date.now()) return nota;
    if (nota.situacao === 'enviando') {
      if (!repo.transicionar(nota.id, 'enviando', 'pendente', { processamentoToken: null, processamentoAte: null }, { versao: nota.versao })) return repo.notaPorId(notaId);
      nota = repo.notaPorId(notaId);
    }
    const original = nota.contextoEmitente;
    if (!original || !nota.idDps || !repo.xmlDps(nota.id)) throw incerto(nota);
    const contexto = { ...original, id: nota.prestadorId, ambiente: nota.ambiente };
    certificadoCompativel(contexto, certificado);
    const token = randomUUID();
    if (!repo.transicionar(nota.id, nota.situacao, 'pendente', {
      contextoEmitente: original, processamentoToken: token, processamentoAte: prazoPosse(),
      proximaVerificacaoEm: proxima(nota.verificacoes), verificacoes: nota.verificacoes + 1,
    }, { versao: nota.versao, certificadoId: certificado.id })) return repo.notaPorId(notaId);
    nota = repo.notaPorId(notaId);
    try {
      const cli = clienteSefin(contexto, certificado);
      const c = await cli.consultarDps(nota.idDps);
      repo.registrarChamada(nota.id, 'consulta_dps', c);
      if (c.tipo === 'encontrada' && c.chaveAcesso) {
        const n = await cli.consultarNfse(c.chaveAcesso);
        repo.registrarChamada(nota.id, 'consulta_nfse', n);
        const info = n.tipo === 'ok' ? lerNfse(n.nfseXml) : null;
        repo.transicionar(nota.id, 'pendente', 'emitida', {
          chaveAcesso: c.chaveAcesso, nNfse: info?.nNFSe ?? null, emitidaEm: info?.dhProc || new Date().toISOString(),
          ...(n.tipo === 'ok' ? { nfseXml: n.nfseXml } : {}), erros: null,
          processamentoToken: null, processamentoAte: null,
        }, { versao: nota.versao, token });
      } else if (c.tipo === 'nao_encontrada' && reenviar) {
        const desde = Date.now() - new Date(nota.ultimoEnvioEm).getTime();
        if (Number.isFinite(desde) && desde >= config.esperaAntesDeReenviarMs && nota.tentativas <= MAX_REENVIOS) {
          // Reenvio apenas depois de uma resposta explícita de ausência. Nunca
          // muda XML/identidade e nunca reenvia uma consulta inconclusiva.
          // A consulta é assíncrona: validade e autorização do A1 podem mudar
          // enquanto aguardamos. O CAS protege também contra outro processo.
          certificadoCompativel(contexto, certificado);
          if (!repo.transicionar(nota.id, 'pendente', 'pendente', { tentativas: nota.tentativas + 1, ultimoEnvioEm: new Date().toISOString(), processamentoAte: prazoPosse() }, { versao: nota.versao, token, certificadoId: certificado.id })) return repo.notaPorId(nota.id);
          nota = repo.notaPorId(nota.id);
          const r = await cli.enviarDps(repo.xmlDps(nota.id));
          repo.registrarChamada(nota.id, 'reenvio', r);
          await aplicarResultadoEnvio(nota, r);
        }
      }
      return repo.notaPorId(nota.id);
    } catch (e) {
      if (e instanceof ErroApp && !e.extra?.resultadoIncerto) throw e;
      throw incerto(nota);
    } finally {
      const atual = repo.notaPorId(notaId);
      if (atual?.processamentoToken === token) {
        try { repo.liberarProcessamento(notaId, token); } catch { throw incerto(nota); }
      }
    }
  }

  async function verificar(prestador, notaId) {
    return comTrava(notaId, async () => {
      const nota = repo.nota(prestador.id, notaId);
      if (!nota) throw new ErroApp(404, 'Nota não encontrada.');
      if (!['pendente', 'enviando'].includes(nota.situacao)) return nota;
      const certificado = repo.certificadoAtivo(prestador.id);
      return reconciliar(notaId, prestador, certificado);
    });
  }

  // Busca o XML oficial de uma nota emitida cuja consulta inicial falhou.
  async function buscarXml(prestador, notaId) {
    const nota = repo.nota(prestador.id, notaId);
    if (!nota || nota.situacao !== 'emitida' || nota.temXml) return nota;
    const certificado = repo.certificadoAtivo(prestador.id);
    if (!certificado) return nota;
    if (!nota.contextoEmitente) throw incerto(nota);
    const n = await clienteSefin({ ...nota.contextoEmitente, id: nota.prestadorId, ambiente: nota.ambiente }, certificado).consultarNfse(nota.chaveAcesso);
    repo.registrarChamada(nota.id, 'consulta_nfse', n);
    if (n.tipo === 'ok') repo.transicionar(nota.id, 'emitida', 'emitida', { nfseXml: n.nfseXml });
    return repo.notaPorId(nota.id);
  }

  // Tarefa periódica: verifica notas pendentes (consulta primeiro, sempre).
  async function verificarPendentes() {
    for (const nota of repo.pendentes()) {
      if (travas.has(nota.id)) continue;
      const prestador = repo.prestador(nota.prestadorId);
      const certificado = prestador && repo.certificadoAtivo(prestador.id);
      if (!certificado) {
        repo.transicionar(nota.id, nota.situacao, 'pendente', { processamentoToken: null, processamentoAte: null, proximaVerificacaoEm: proxima(nota.verificacoes), verificacoes: nota.verificacoes + 1 }, { versao: nota.versao });
        continue;
      }
      try { await comTrava(nota.id, () => reconciliar(nota.id, prestador, certificado)); } catch {
        const atual = repo.notaPorId(nota.id);
        if (atual && (!atual.processamentoAte || new Date(atual.processamentoAte).getTime() <= Date.now())) repo.transicionar(atual.id, atual.situacao, atual.situacao, { proximaVerificacaoEm: proxima(atual.verificacoes), verificacoes: atual.verificacoes + 1 }, { versao: atual.versao });
      }
    }
  }

  return { emitir, verificar, validar, validarNota, fecharClientesDoPrestador, convenioEmissor, buscarXml, verificarPendentes, fecharClientes: () => { for (const c of clientes.values()) c.fechar?.(); clientes.clear(); } };
}
