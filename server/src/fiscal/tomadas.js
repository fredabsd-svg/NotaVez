// Notas tomadas: NFS-e emitidas por fornecedores PARA a empresa. O ADN distribui
// por NSU tudo em que o CNPJ é parte; aqui ficam só as notas em que a empresa
// é a tomadora (as que ela própria emitiu já estão em "Notas") e os eventos de
// cancelamento delas. Nada é enviado à Receita: é só leitura.
import { XMLParser } from 'fast-xml-parser';
import { municipio } from './tabelas.js';
import { ErroApp } from '../util/erros.js';

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

export function criarServicoTomadas({ repo, emissao }) {
  const emAndamento = new Map();
  const ultimaTentativa = new Map();

  async function executar(prestador) {
    const ambiente = prestador.ambiente;
    let { ultimoNsu } = repo.distribuicao(prestador.id, ambiente, prestador.documento);
    const resultado = { novas: 0, canceladas: 0, lidos: 0 };
    for (let lote = 0; lote < LOTES_POR_SINCRONIZACAO; lote++) {
      const r = await emissao.distribuirDfe(prestador, ultimoNsu);
      repo.registrarChamada(null, 'distribuicao_dfe', { http: r.http, tipo: r.tipo, ms: r.ms, erros: r.erros?.length ? r.erros : undefined, detalhe: r.detalhe });
      if (r.tipo !== 'ok') {
        if (lote === 0) throw new ErroApp(502, 'A Receita não respondeu à consulta de notas tomadas. Tente novamente em alguns minutos.', { erros: r.erros || [] });
        break;
      }
      let maior = ultimoNsu;
      for (const d of r.documentos) {
        maior = Math.max(maior, d.nsu);
        if (!d.xml) continue;
        resultado.lidos += 1;
        if (d.tipoDocumento.includes('EVENTO') || /<(\w+:)?evento[\s>]/.test(d.xml)) {
          const chave = chaveCancelada(d.xml);
          if (chave && repo.cancelarTomada(prestador.id, ambiente, chave)) resultado.canceladas += 1;
          continue;
        }
        let n;
        try { n = resumoNfse(d.xml); } catch { n = null; }
        // Só entra se a empresa for a tomadora desta nota.
        if (!n?.chaveAcesso || n.tomador?.documento !== prestador.documento) continue;
        if (repo.salvarTomada(prestador.id, ambiente, { ...n, nsu: d.nsu, xml: d.xml })) resultado.novas += 1;
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
    if (anterior && Date.now() - anterior < INTERVALO_MINIMO_MS) {
      throw new ErroApp(429, 'As notas tomadas desta empresa acabaram de ser consultadas. Aguarde um minuto para buscar de novo.');
    }
    ultimaTentativa.set(chave, Date.now());
    const p = executar(prestador)
      // Sem certificado nada chegou ao ADN: não conta como consulta.
      .catch((e) => { if (e instanceof ErroApp && e.status === 409) ultimaTentativa.delete(chave); throw e; })
      .finally(() => emAndamento.delete(chave));
    emAndamento.set(chave, p);
    return p;
  }

  return { sincronizar };
}
