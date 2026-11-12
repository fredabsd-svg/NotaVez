// Sincronização com o ADN (Ambiente de Dados Nacional da NFS-e). O ADN distribui por NSU tudo
// em que o CNPJ é parte. Daqui saem:
//  - as notas TOMADAS: NFS-e que fornecedores emitiram para a empresa;
//  - as notas EMITIDAS pela empresa fora do app (Emissor Nacional, outro sistema), que passam a
//    constar em "Notas" com o XML oficial;
//  - os cancelamentos das duas.
// Nada é enviado à Receita: é só leitura, com o certificado da empresa ou o do escritório (procuração).
import { XMLParser } from 'fast-xml-parser';
import { municipio } from './tabelas.js';
import { ErroApp } from '../util/erros.js';
import { lerNfseImportada, manterVinculos } from './assistida.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false });
const txt = (v) => (v === undefined || v === null ? null : String(typeof v === 'object' ? v['#text'] ?? '' : v).trim() || null);
const LOTES_POR_SINCRONIZACAO = 20;
const INTERVALO_MINIMO_MS = 60_000;
// Cancelamento, cancelamento por substituição e cancelamento deferido por análise fiscal.
const EVENTOS_CANCELAMENTO = ['e101101', 'e105102', 'e105104'];

const documentoDe = (o) => (o?.CNPJ ? { tipo: 'CNPJ', documento: txt(o.CNPJ) } : o?.CPF ? { tipo: 'CPF', documento: txt(o.CPF) } : o?.NIF ? { tipo: 'NIF', documento: txt(o.NIF) } : null);

// Resumo de uma NFS-e (qualquer emitente) a partir do XML oficial.
export function resumoNfse(xml) {
  const inf = parser.parse(xml)?.NFSe?.infNFSe;
  if (!inf) return null;
  const dps = inf.DPS?.infDPS || {};
  const emit = inf.emit || {};
  const toma = dps.toma || {};
  const vServ = txt(dps.valores?.vServPrest?.vServ);
  const tpRet = txt(dps.valores?.trib?.tribMun?.tpRetISSQN);
  const cTribNac = txt(dps.serv?.cServ?.cTribNac);
  const local = txt(dps.serv?.locPrest?.cLocPrestacao) || txt(dps.cLocEmi);
  return {
    chaveAcesso: String(inf['@Id'] || '').replace(/^NFS/, ''),
    nNfse: txt(inf.nNFSe),
    emitidaEm: txt(inf.dhProc) || txt(dps.dhEmi),
    competencia: txt(dps.dCompet),
    valor: vServ ? Number(vServ).toFixed(2) : null,
    valorLiquido: txt(inf.valores?.vLiq) ? Number(txt(inf.valores.vLiq)).toFixed(2) : null,
    issRetido: !!tpRet && tpRet !== '1',
    tomador: documentoDe(toma),
    resumo: {
      emitente: { ...(documentoDe(emit) || documentoDe(dps.prest) || {}), nome: txt(emit.xNome) || txt(dps.prest?.xNome) },
      descricao: (txt(dps.serv?.cServ?.xDescServ) || '').slice(0, 2000),
      cTribNac, servico: txt(inf.xTribNac),
      localPrestacao: municipio(local) || (txt(inf.xLocPrestacao) ? { nome: txt(inf.xLocPrestacao) } : null),
      vIss: txt(inf.valores?.vISSQN),
    },
  };
}

// Evento de cancelamento: devolve a chave da NFS-e cancelada (ou null).
export function chaveCancelada(xml) {
  const doc = parser.parse(xml);
  const ped = doc?.evento?.infEvento?.pedRegEvento?.infPedReg || doc?.pedRegEvento?.infPedReg;
  if (!ped || !EVENTOS_CANCELAMENTO.some((e) => ped[e] !== undefined)) return null;
  return txt(ped.chNFSe);
}

const esperar = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

// `registrar`: recebe os eventos de auditoria (nota trazida da Receita, nota cancelada no portal).
// `pausaEntreEmpresasMs`: intervalo entre empresas nas buscas em lote (o ADN limita o consumo).
// `intervaloMinimoMs`: tempo mínimo entre duas buscas da mesma empresa.
export function criarServicoTomadas({ repo, emissao, registrar = () => {}, pausaEntreEmpresasMs = 1500, intervaloMinimoMs = INTERVALO_MINIMO_MS }) {
  const emAndamento = new Map();
  const ultimaTentativa = new Map();

  // NFS-e em que a empresa é a EMITENTE. Entra em "Notas" se ainda não estiver lá.
  async function registrarEmitida(prestador, xml) {
    let dados;
    try { dados = await lerNfseImportada(xml, { exigirAssinatura: false, fonteOficial: true }); } catch { return 'ilegivel'; }
    if (dados.emitente?.documento !== prestador.documento || dados.ambiente !== prestador.ambiente) return 'ignorada';
    const existente = repo.notaPorChave(prestador.id, dados.chaveAcesso);
    if (existente) {
      // XML que a pessoa trouxe quando a empresa não tinha certificado: agora vale a versão da Receita.
      if (existente.situacao === 'emitida' && existente.canal === 'emissor_nacional' && !existente.importadaConferida) {
        repo.reconferirImportada(prestador.id, existente.id, { xml, nNfse: dados.nNfse, emitidaEm: dados.emitidaEm, ambiente: dados.ambiente,
          rascunho: manterVinculos(repo, prestador.id, existente.rascunho, dados.rascunho) });
        registrar({ usuarioId: prestador.usuarioId, prestadorId: prestador.id, acao: 'nota.reconferida', entidade: 'nota', entidadeId: existente.id, detalhes: { origem: 'sincronizacao' } });
        return 'conferida';
      }
      return 'existente';
    }
    // DPS que o próprio app enviou (pendente de confirmação, por exemplo): quem conclui essa nota é a
    // verificação dela, que consulta a Receita antes de qualquer reenvio. Aqui não se cria uma segunda.
    if (dados.idDps && repo.notaPorIdDps(prestador.id, dados.idDps)) return 'do_app';
    const documento = dados.rascunho.tomador?.documento;
    const cliente = documento ? repo.clientePorDocumento(prestador.id, documento) : null;
    // Na lista, a nota entra na data em que a Receita a autorizou, e não como se fosse de agora.
    const instante = new Date(dados.emitidaEm || '');
    const id = repo.registrarImportada(prestador.id, null, { ...dados, rascunho: { ...dados.rascunho, clienteId: cliente?.id || null }, xml, contexto: prestador, conferida: true, canal: 'sincronizada',
      ...(Number.isNaN(instante.getTime()) || instante > new Date() ? {} : { atualizadaEm: instante.toISOString() }) });
    registrar({ usuarioId: prestador.usuarioId, prestadorId: prestador.id, acao: 'nota.sincronizada', entidade: 'nota', entidadeId: id });
    return 'nova';
  }

  async function executar(prestador) {
    const ambiente = prestador.ambiente;
    let { ultimoNsu, leitura } = repo.distribuicao(prestador.id, ambiente, prestador.documento);
    // Fila lida por uma versão que só guardava as tomadas: relê desde o início, uma única vez, para
    // trazer as notas que a empresa emitiu fora do app (as tomadas já guardadas não se repetem).
    if (leitura < 2 && repo.reiniciarLeitura(prestador.id, ambiente, prestador.documento)) ultimoNsu = 0;
    const resultado = { novas: 0, canceladas: 0, emitidas: 0, emitidasCanceladas: 0, ilegiveis: 0, lidos: 0 };
    for (let lote = 0; lote < LOTES_POR_SINCRONIZACAO; lote++) {
      const r = await emissao.distribuirDfe(prestador, ultimoNsu);
      repo.registrarChamada(null, 'distribuicao_dfe', { http: r.http, tipo: r.tipo, ms: r.ms, erros: r.erros?.length ? r.erros : undefined, detalhe: r.detalhe });
      if (r.tipo !== 'ok') {
        if (lote === 0) {
          // Com resposta da Receita, mostra o motivo dela (ex.: procuração não vigente); sem resposta, pede para tentar depois.
          const motivo = r.erros?.find((e) => e.descricao)?.descricao;
          throw new ErroApp(502, motivo
            ? `A Receita recusou a consulta das notas: ${motivo}${prestador.usaProcuracao ? ' Confira se a procuração eletrônica NFS-e desta empresa para o escritório está vigente.' : ''}`
            : 'A Receita não respondeu à consulta das notas. Tente novamente em alguns minutos.', { erros: r.erros || [] });
        }
        break;
      }
      let maior = ultimoNsu;
      for (const d of r.documentos) {
        maior = Math.max(maior, d.nsu);
        if (!d.xml) continue;
        resultado.lidos += 1;
        if (d.tipoDocumento.includes('EVENTO') || /<(\w+:)?evento[\s>]/.test(d.xml)) {
          // Evento malformado não pode travar a fila: segue para o próximo NSU.
          let chave = null;
          try { chave = chaveCancelada(d.xml); } catch { chave = null; }
          if (!chave) continue;
          if (repo.cancelarTomada(prestador.id, ambiente, chave)) resultado.canceladas += 1;
          // Nota da própria empresa cancelada no portal: sai dos totais e fica no histórico como cancelada.
          else if (repo.cancelarEmitida(prestador.id, chave)) {
            resultado.emitidasCanceladas += 1;
            registrar({ usuarioId: prestador.usuarioId, prestadorId: prestador.id, acao: 'nota.cancelada_no_portal', entidade: 'nota', entidadeId: repo.notaPorChave(prestador.id, chave)?.id });
          }
          continue;
        }
        let n;
        try { n = resumoNfse(d.xml); } catch { n = null; }
        if (!n?.chaveAcesso) { resultado.ilegiveis += 1; continue; }
        // A empresa é a tomadora: nota recebida de um fornecedor.
        if (n.tomador?.documento === prestador.documento) {
          if (repo.salvarTomada(prestador.id, ambiente, { ...n, nsu: d.nsu, xml: d.xml })) resultado.novas += 1;
        } else if (n.resumo.emitente?.documento === prestador.documento) {
          // A empresa é a emitente: nota emitida por ela (pelo app ou fora dele).
          const situacao = await registrarEmitida(prestador, d.xml);
          if (situacao === 'nova') resultado.emitidas += 1;
          if (situacao === 'ilegivel') resultado.ilegiveis += 1;
        }
      }
      repo.gravarDistribuicao(prestador.id, ambiente, prestador.documento, maior);
      if (maior <= ultimoNsu || r.documentos.length < 50) break;
      ultimoNsu = maior;
    }
    return { ...resultado, ...repo.distribuicao(prestador.id, ambiente, prestador.documento) };
  }

  // Uma sincronização por empresa por vez, e no máximo uma por minuto (o ADN limita o consumo).
  async function sincronizar(prestador) {
    const chave = `${prestador.id}:${prestador.ambiente}`;
    if (emAndamento.has(chave)) return emAndamento.get(chave);
    const anterior = ultimaTentativa.get(chave);
    if (anterior && Date.now() - anterior < intervaloMinimoMs) {
      throw new ErroApp(429, 'As notas desta empresa acabaram de ser consultadas na Receita. Aguarde um minuto para buscar de novo.');
    }
    ultimaTentativa.set(chave, Date.now());
    const p = executar(prestador)
      // Sem certificado nada chegou ao ADN: não conta como consulta.
      .catch((e) => { if (e instanceof ErroApp && e.status === 409) ultimaTentativa.delete(chave); throw e; })
      .finally(() => emAndamento.delete(chave));
    emAndamento.set(chave, p);
    return p;
  }

  // ---------- todas as empresas de uma conta (escritório com procuração) ----------
  // Roda em segundo plano, uma empresa por vez; a tela acompanha pelo andamento.
  const lotes = new Map();
  const situacaoLote = (usuarioId) => ({ ...(lotes.get(usuarioId) || { emAndamento: false, total: 0, feitas: 0, tomadas: 0, emitidas: 0, canceladas: 0, falhas: [], iniciadaEm: null, terminadaEm: null }) });
  function iniciarLote(usuarioId) {
    if (lotes.get(usuarioId)?.emAndamento) return situacaoLote(usuarioId);
    const empresas = repo.prestadoresComCertificado(usuarioId);
    const agora = new Date().toISOString();
    const lote = { emAndamento: empresas.length > 0, total: empresas.length, feitas: 0, tomadas: 0, emitidas: 0, canceladas: 0, falhas: [], iniciadaEm: agora, terminadaEm: empresas.length ? null : agora };
    lotes.set(usuarioId, lote);
    (async () => {
      try {
        for (const [i, p] of empresas.entries()) {
          try {
            const r = await sincronizar(p);
            lote.tomadas += r.novas; lote.emitidas += r.emitidas; lote.canceladas += r.canceladas + r.emitidasCanceladas;
          } catch (e) {
            // Consultada há menos de um minuto: já está em dia, não é falha.
            if (!(e instanceof ErroApp && e.status === 429) && lote.falhas.length < 50) lote.falhas.push({ empresa: p.nome || 'Empresa sem nome', motivo: e instanceof ErroApp ? e.message : 'Não foi possível consultar a Receita.' });
          }
          lote.feitas += 1;
          if (i < empresas.length - 1 && pausaEntreEmpresasMs) await esperar(pausaEntreEmpresasMs);
        }
      } finally {
        // Aconteça o que acontecer, a busca não fica "em andamento" para sempre.
        lote.emAndamento = false;
        lote.terminadaEm = new Date().toISOString();
      }
    })().catch(() => {});
    return situacaoLote(usuarioId);
  }

  // Tarefa periódica do servidor: todas as empresas com certificado válido, uma por vez. Falhas não param a fila.
  let rodandoTodas = false;
  async function sincronizarTodas() {
    if (rodandoTodas) return { empresas: 0 };
    rodandoTodas = true;
    let empresas = 0;
    try {
      for (const p of repo.prestadoresComCertificado()) {
        try { await sincronizar(p); empresas += 1; } catch { /* a próxima rodada tenta de novo */ }
        if (pausaEntreEmpresasMs) await esperar(pausaEntreEmpresasMs);
      }
    } finally { rodandoTodas = false; }
    return { empresas };
  }

  return { sincronizar, iniciarLote, situacaoLote, sincronizarTodas };
}
