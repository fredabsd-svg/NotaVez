// Orquestra a emissão: rascunho → enviando → emitida | rejeitada | pendente.
// Regras de ouro:
//  1. Só "emitida" com chave de acesso devolvida pela Sefin Nacional.
//  2. Resposta incerta → "pendente"; antes de reenviar, consultar GET /dps/{id}.
//  3. O reenvio usa exatamente a mesma DPS assinada (mesmo Id): nunca gera duplicata.
//  4. Número da DPS nunca é reaproveitado entre notas.
import { XMLParser } from 'fast-xml-parser';
import { config, ambientesSefin } from '../config.js';
import { decifrar, decifrarBuffer } from '../security/cripto.js';
import { escolherPacote } from './regras/index.js';
import { montarDps, dataHoraBrasilia, hojeBrasilia } from './dps.js';
import { validarXsd } from './xsd.js';
import { assinarDps } from './assinatura.js';
import { lerCertificado } from './certificado.js';
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

/** Valida o rascunho sem enviar nada (usado na tela de Revisão). */
export function validarRascunho(prestador, rascunho, hoje = hojeBrasilia()) {
  const escolha = escolherPacote({ opSimpNac: prestador?.opSimpNac, competencia: rascunho.competencia });
  if (!escolha.pacote) return { ok: false, erros: [{ campo: 'regime', mensagem: escolha.motivo, regra: 'NotaVez' }] };
  const erros = escolha.pacote.validar({ prestador, nota: rascunho, hoje });
  const pendRevisao = (rascunho.revisar || []).filter(Boolean);
  for (const c of pendRevisao) erros.push({ campo: c, mensagem: 'Confira este campo (nota clonada).', regra: 'Clonagem' });
  return { ok: erros.length === 0, erros, pacote: escolha.pacote };
}

function materialCertificado(certificado) {
  const pfx = decifrarBuffer(certificado._pfx);
  return lerCertificado(pfx, decifrar(certificado._senha));
}

export function criarServicoEmissao({ repo, fabricaCliente }) {
  const clientes = new Map();
  function clienteSefin(prestador, certificado) {
    const chave = `${prestador.id}:${certificado.id}:${prestador.ambiente}`;
    if (!clientes.has(chave)) {
      const mat = materialCertificado(certificado);
      const amb = ambientesSefin[prestador.ambiente];
      clientes.set(chave, fabricaCliente({ baseUrl: amb.sefin, ...mat, timeoutMs: config.timeoutSefinMs }));
    }
    return clientes.get(chave);
  }

  async function comTrava(notaId, fn) {
    if (travas.has(notaId)) throw new ErroApp(409, 'Esta nota já está sendo processada. Aguarde.');
    travas.add(notaId);
    try { return await fn(); } finally { travas.delete(notaId); }
  }

  // Aplica o resultado de um envio (ou reenvio) à nota.
  async function aplicarResultadoEnvio(nota, r, prestador, certificado) {
    if (r.tipo === 'emitida') {
      const info = lerNfse(r.nfseXml);
      repo.transicionar(nota.id, ['enviando', 'pendente'], 'emitida', {
        chaveAcesso: r.chaveAcesso, nNfse: info?.nNFSe ?? null, nfseXml: r.nfseXml, emitidaEm: info?.dhProc || new Date().toISOString(),
        alertas: r.alertas?.length ? r.alertas.map(explicar) : null, erros: null,
      });
    } else if (r.tipo === 'rejeitada') {
      // A DPS não gerou NFS-e: liberamos o rascunho para correção (novo número no próximo envio).
      repo.transicionar(nota.id, ['enviando', 'pendente'], 'rejeitada', {
        erros: r.erros.map(explicar), idDps: null, serie: null, nDps: null, dpsXml: null,
      });
    } else if (r.tipo === 'nao_enviada') {
      repo.transicionar(nota.id, ['enviando'], 'rascunho', {
        erros: [{ codigo: 'NAO_ENVIADA', mensagem: MOTIVOS_NAO_ENVIADA[r.motivo] || 'Nada foi enviado.', proximoPasso: 'Tente novamente em instantes.' }],
        idDps: null, serie: null, nDps: null, dpsXml: null,
      });
    } else {
      // incerta ou duplicada (E0014): consultar antes de qualquer reenvio.
      repo.transicionar(nota.id, ['enviando', 'pendente'], 'pendente', { ultimoEnvioEm: new Date().toISOString() });
      if (r.tipo === 'duplicada') return reconciliar(nota.id, prestador, certificado, { reenviar: false });
    }
    return repo.notaPorId(nota.id);
  }

  async function emitir(prestador, notaId) {
    return comTrava(notaId, async () => {
      const nota = repo.nota(prestador.id, notaId);
      if (!nota) throw new ErroApp(404, 'Nota não encontrada.');
      if (nota.situacao === 'emitida') throw new ErroApp(409, 'Esta nota já foi emitida. Para uma nova, use "Clonar".');
      if (nota.situacao === 'pendente' || nota.situacao === 'enviando') {
        throw new ErroApp(409, 'Esta nota está pendente de confirmação. Use "Verificar situação" — não envie de novo.');
      }
      const certificado = repo.certificadoAtivo(prestador.id);
      const eleg = avaliarElegibilidade(prestador, certificado);
      if (!eleg.podeEmitir) throw new ErroApp(403, 'Ainda falta algo para emitir pelo NotaVez.', { pendencias: eleg.pendencias });

      const v = validarRascunho(prestador, nota.rascunho);
      if (!v.ok) throw new ErroApp(422, 'Corrija os campos indicados antes de emitir.', { erros: v.erros });

      const amb = ambientesSefin[prestador.ambiente];
      const serie = prestador.serieDps || config.serieDpsPadrao;
      const nDPS = repo.proximoNumeroDps(prestador.documento, prestador.ambiente, serie);
      const { xml, Id } = montarDps({
        tpAmb: amb.tpAmb, prestador, nota: nota.rascunho, pacote: v.pacote, serie, nDPS,
        dhEmi: dataHoraBrasilia(), verAplic: config.versaoAplicativo,
      });
      const mat = materialCertificado(certificado);
      const assinado = assinarDps(xml, mat);
      const xsd = await validarXsd(assinado);
      if (!xsd.valido) throw new ErroApp(422, 'A nota não passou na validação do leiaute oficial. Nada foi enviado.', { detalhes: xsd.erros.slice(0, 5) });

      const ok = repo.transicionar(nota.id, ['rascunho', 'rejeitada'], 'enviando', {
        ambiente: prestador.ambiente, serie, nDps: String(nDPS), idDps: Id, dpsXml: assinado,
        tentativas: 1, ultimoEnvioEm: new Date().toISOString(), erros: null,
      });
      if (!ok) throw new ErroApp(409, 'A nota mudou enquanto era enviada. Atualize a tela.');

      const r = await clienteSefin(prestador, certificado).enviarDps(assinado);
      repo.registrarChamada(nota.id, 'envio', r);
      return aplicarResultadoEnvio(repo.notaPorId(nota.id), r, prestador, certificado);
    });
  }

  async function reconciliar(notaId, prestador, certificado, { reenviar = true } = {}) {
    const nota = repo.notaPorId(notaId);
    if (!nota || nota.situacao !== 'pendente') return nota;
    const cli = clienteSefin(prestador, certificado);
    const c = await cli.consultarDps(nota.idDps);
    repo.registrarChamada(nota.id, 'consulta_dps', c);
    if (c.tipo === 'encontrada') {
      const n = await cli.consultarNfse(c.chaveAcesso);
      repo.registrarChamada(nota.id, 'consulta_nfse', n);
      const info = n.tipo === 'ok' ? lerNfse(n.nfseXml) : null;
      repo.transicionar(nota.id, 'pendente', 'emitida', {
        chaveAcesso: c.chaveAcesso, nNfse: info?.nNFSe ?? null, emitidaEm: info?.dhProc || new Date().toISOString(),
        ...(n.tipo === 'ok' ? { nfseXml: n.nfseXml } : {}), erros: null,
      });
      return repo.notaPorId(nota.id);
    }
    if (c.tipo === 'nao_encontrada' && reenviar) {
      const desde = Date.now() - new Date(nota.ultimoEnvioEm).getTime();
      if (desde < config.esperaAntesDeReenviarMs || nota.tentativas > MAX_REENVIOS) return nota;
      // Mesma DPS assinada, mesmo Id: se ela tiver sido processada nesse meio-tempo, a Sefin responde E0014.
      repo.transicionar(nota.id, 'pendente', 'pendente', { tentativas: nota.tentativas + 1, ultimoEnvioEm: new Date().toISOString() });
      const r = await cli.enviarDps(repo.xmlDps(nota.id));
      repo.registrarChamada(nota.id, 'reenvio', r);
      if (r.tipo === 'nao_enviada') return repo.notaPorId(nota.id); // segue pendente; a consulta decide depois
      return aplicarResultadoEnvio(repo.notaPorId(nota.id), r, prestador, certificado);
    }
    return nota;
  }

  async function verificar(prestador, notaId) {
    return comTrava(notaId, async () => {
      const nota = repo.nota(prestador.id, notaId);
      if (!nota) throw new ErroApp(404, 'Nota não encontrada.');
      if (nota.situacao !== 'pendente') return nota;
      const certificado = repo.certificadoAtivo(prestador.id);
      if (!certificado) throw new ErroApp(403, 'Envie novamente o certificado digital para consultar esta nota.');
      return reconciliar(notaId, prestador, certificado);
    });
  }

  // Busca o XML oficial de uma nota emitida cuja consulta inicial falhou.
  async function buscarXml(prestador, notaId) {
    const nota = repo.nota(prestador.id, notaId);
    if (!nota || nota.situacao !== 'emitida' || nota.temXml) return nota;
    const certificado = repo.certificadoAtivo(prestador.id);
    if (!certificado) return nota;
    const n = await clienteSefin(prestador, certificado).consultarNfse(nota.chaveAcesso);
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
      if (!certificado) continue;
      try { await comTrava(nota.id, () => reconciliar(nota.id, prestador, certificado)); } catch { /* segue para a próxima */ }
    }
  }

  return { emitir, verificar, buscarXml, verificarPendentes, fecharClientes: () => { for (const c of clientes.values()) c.fechar?.(); clientes.clear(); } };
}
