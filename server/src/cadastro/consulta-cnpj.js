// Consulta dos dados públicos do CNPJ (base aberta da Receita Federal, via
// BrasilAPI e, se ela falhar, CNPJ.ws) para preencher cadastros sozinho.
// Os dados públicos são uma SUGESTÃO: o usuário confere antes de salvar, e o
// enquadramento no Simples/MEI pode estar defasado em até um mês na base aberta.
import { municipio, municipios } from '../fiscal/tabelas.js';
import { cnpjValido, normalizarCnpj, somenteDigitos } from '../util/documentos.js';
import { ErroApp } from '../util/erros.js';

const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const texto = (v) => (v === undefined || v === null ? '' : String(v).replace(/\s+/g, ' ').trim());
const simNao = (v) => (typeof v === 'boolean' ? v : /^s(im)?$/i.test(texto(v)) ? true : /^n(ao|ão)?$/i.test(texto(v)) ? false : null);
const dataIso = (v) => (/^\d{4}-\d{2}-\d{2}/.test(texto(v)) ? texto(v).slice(0, 10) : null);

function municipioIbge(ibge, nome, uf) {
  if (municipio(ibge)) return String(ibge);
  const n = semAcento(nome);
  const u = semAcento(uf);
  return municipios.find((m) => semAcento(m.nome) === n && semAcento(m.uf) === u)?.ibge || null;
}

function logradouroCompleto(tipo, logradouro) {
  const t = texto(tipo);
  const l = texto(logradouro);
  return t && l && !semAcento(l).startsWith(semAcento(t)) ? `${t} ${l}` : l;
}

function porte(descricao) {
  const d = semAcento(descricao);
  if (d.includes('micro')) return 'ME';
  if (d.includes('pequeno')) return 'EPP';
  if (d.includes('demais')) return 'DEMAIS';
  return null;
}

// MEI → 2; Simples (ME/EPP) → 3; senão não optante (1), com Presumido/Real
// pela última ECF entregue quando a base informar.
export function enquadramento({ simples, mei, regimes = [] }) {
  if (mei?.optante) return { opSimpNac: '2', apuracao: null, descricao: 'MEI (Simples Nacional - SIMEI)' };
  if (simples?.optante) return { opSimpNac: '3', apuracao: null, descricao: 'ME/EPP optante do Simples Nacional' };
  const ultimo = [...regimes].sort((a, b) => b.ano - a.ano)[0];
  const forma = semAcento(ultimo?.forma);
  const apuracao = forma.includes('real') ? 'real' : forma.includes('presumido') ? 'presumido' : null;
  return {
    opSimpNac: simples?.optante === false ? '1' : null,
    apuracao,
    descricao: apuracao ? `Lucro ${apuracao === 'real' ? 'Real' : 'Presumido'} (ECF ${ultimo.ano})` : simples?.optante === false ? 'Não optante do Simples (confirme Presumido ou Real)' : 'Não informado pela base pública',
  };
}

function deBrasilApi(d) {
  const ibge = municipioIbge(d.codigo_municipio_ibge, d.municipio, d.uf);
  const regimes = (Array.isArray(d.regime_tributario) ? d.regime_tributario : [])
    .map((r) => ({ ano: Number(r.ano), forma: texto(r.forma_de_tributacao) })).filter((r) => r.ano && r.forma);
  return {
    razaoSocial: texto(d.razao_social), nomeFantasia: texto(d.nome_fantasia) || null,
    situacaoCadastral: texto(d.descricao_situacao_cadastral) || null,
    abertura: dataIso(d.data_inicio_atividade),
    naturezaJuridica: texto(d.natureza_juridica) || null,
    porte: porte(d.porte),
    cnae: d.cnae_fiscal ? { codigo: String(d.cnae_fiscal).padStart(7, '0'), descricao: texto(d.cnae_fiscal_descricao) } : null,
    endereco: {
      cep: somenteDigitos(d.cep).slice(0, 8), municipioIbge: ibge,
      logradouro: logradouroCompleto(d.descricao_tipo_de_logradouro, d.logradouro), numero: texto(d.numero),
      complemento: texto(d.complemento), bairro: texto(d.bairro),
    },
    email: texto(d.email).toLowerCase() || null,
    fone: somenteDigitos(d.ddd_telefone_1) || null,
    simples: { optante: simNao(d.opcao_pelo_simples), desde: dataIso(d.data_opcao_pelo_simples), excluidoEm: dataIso(d.data_exclusao_do_simples) },
    mei: { optante: simNao(d.opcao_pelo_mei), desde: dataIso(d.data_opcao_pelo_mei), excluidoEm: dataIso(d.data_exclusao_do_mei) },
    regimes,
  };
}

function deCnpjWs(d) {
  const e = d.estabelecimento || {};
  const s = d.simples || {};
  return {
    razaoSocial: texto(d.razao_social), nomeFantasia: texto(e.nome_fantasia) || null,
    situacaoCadastral: texto(e.situacao_cadastral).toUpperCase() || null,
    abertura: dataIso(e.data_inicio_atividade),
    naturezaJuridica: texto(d.natureza_juridica?.descricao) || null,
    porte: porte(d.porte?.descricao),
    cnae: e.atividade_principal?.id ? { codigo: String(e.atividade_principal.id).padStart(7, '0'), descricao: texto(e.atividade_principal.descricao) } : null,
    endereco: {
      cep: somenteDigitos(e.cep).slice(0, 8), municipioIbge: municipioIbge(e.cidade?.ibge_id, e.cidade?.nome, e.estado?.sigla),
      logradouro: logradouroCompleto(e.tipo_logradouro, e.logradouro), numero: texto(e.numero),
      complemento: texto(e.complemento), bairro: texto(e.bairro),
    },
    email: texto(e.email).toLowerCase() || null,
    fone: somenteDigitos(`${e.ddd1 || ''}${e.telefone1 || ''}`) || null,
    // Sem o bloco "simples" a base não informou: não supor "não optante".
    simples: { optante: d.simples ? simNao(s.simples) : null, desde: dataIso(s.data_opcao_simples), excluidoEm: dataIso(s.data_exclusao_simples) },
    mei: { optante: d.simples ? simNao(s.mei) : null, desde: dataIso(s.data_opcao_mei), excluidoEm: dataIso(s.data_exclusao_mei) },
    regimes: [],
  };
}

// ReceitaWS: datas dd/mm/aaaa, CEP com pontuação e "status: ERROR" (HTTP 200) quando não acha.
const dataBr = (v) => { const m = texto(v).match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
function deReceitaWs(d) {
  if (texto(d.status).toUpperCase() === 'ERROR') {
    if (/inv[aá]lido|n[aã]o encontrado|not found/i.test(texto(d.message))) throw Object.assign(new Error('nao_encontrado'), { naoEncontrado: true });
    throw new Error('falha');
  }
  const ativ = Array.isArray(d.atividade_principal) ? d.atividade_principal[0] : null;
  return {
    razaoSocial: texto(d.nome), nomeFantasia: texto(d.fantasia) || null,
    situacaoCadastral: texto(d.situacao).toUpperCase() || null,
    abertura: dataBr(d.abertura),
    naturezaJuridica: texto(d.natureza_juridica) || null,
    porte: porte(d.porte),
    cnae: ativ?.code ? { codigo: somenteDigitos(ativ.code).padStart(7, '0'), descricao: texto(ativ.text) } : null,
    endereco: {
      cep: somenteDigitos(d.cep).slice(0, 8), municipioIbge: municipioIbge(null, d.municipio, d.uf),
      logradouro: texto(d.logradouro), numero: texto(d.numero), complemento: texto(d.complemento), bairro: texto(d.bairro),
    },
    email: texto(d.email).toLowerCase() || null,
    fone: somenteDigitos(texto(d.telefone).split('/')[0]) || null,
    simples: { optante: d.simples ? simNao(d.simples.optante) : null, desde: dataIso(d.simples?.data_opcao), excluidoEm: dataIso(d.simples?.data_exclusao) },
    mei: { optante: d.simei ? simNao(d.simei.optante) : null, desde: dataIso(d.simei?.data_opcao), excluidoEm: dataIso(d.simei?.data_exclusao) },
    regimes: [],
  };
}

// Vários serviços da base pública, em sequência: se um estiver fora, lento ou limitando, tenta o próximo.
export const PROVEDORES = [
  { nome: 'BrasilAPI', url: (c) => `https://brasilapi.com.br/api/cnpj/v1/${c}`, ler: deBrasilApi },
  { nome: 'Minha Receita', url: (c) => `https://minhareceita.org/${c}`, ler: deBrasilApi },
  { nome: 'CNPJ.ws', url: (c) => `https://publica.cnpj.ws/cnpj/${c}`, ler: deCnpjWs },
  { nome: 'ReceitaWS', url: (c) => `https://receitaws.com.br/v1/cnpj/${c}`, ler: deReceitaWs },
];

export function criarConsultaCnpj({ buscar = globalThis.fetch, provedores = PROVEDORES, timeoutMs = 8000, validadeMs = 24 * 3600_000, maxCache = 1000,
  avisar = process.env.NODE_ENV === 'test' ? () => {} : (m) => process.stderr.write(`[consulta CNPJ] ${m}\n`) } = {}) {
  // Cache só em memória: dados públicos, mas evita guardar CNPJ em claro no banco.
  const cache = new Map();

  async function consultarProvedor(p, cnpj) {
    let r;
    try {
      r = await buscar(p.url(cnpj), { headers: { Accept: 'application/json', 'User-Agent': 'NotaSemStress/0.1' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      // Sem acesso à internet a partir do servidor, firewall ou tempo esgotado: registra para o diagnóstico.
      avisar(`${p.nome}: sem resposta (${e?.cause?.code || e?.name || 'erro de rede'})`);
      return { tipo: 'falha' };
    }
    if (r.status === 404) return { tipo: 'nao_encontrado' };
    if (!r.ok) { avisar(`${p.nome}: HTTP ${r.status}`); return { tipo: 'falha' }; }
    try {
      const dados = p.ler(await r.json());
      return dados.razaoSocial ? { tipo: 'ok', dados } : { tipo: 'falha' };
    } catch (e) {
      if (e?.naoEncontrado) return { tipo: 'nao_encontrado' };
      avisar(`${p.nome}: resposta inesperada`);
      return { tipo: 'falha' };
    }
  }

  return async function consultar(valor) {
    const cnpj = normalizarCnpj(valor);
    if (!cnpjValido(cnpj)) throw new ErroApp(422, 'CNPJ inválido. Confira os números.');
    const guardado = cache.get(cnpj);
    if (guardado && Date.now() - guardado.em < validadeMs) return guardado.resultado;
    let naoEncontrado = false;
    for (const [i, p] of provedores.entries()) {
      const r = await consultarProvedor(p, cnpj);
      if (r.tipo === 'nao_encontrado') { naoEncontrado = true; continue; }
      if (r.tipo !== 'ok') continue;
      const d = r.dados;
      // Sem Simples/MEI informado, completa o enquadramento com os próximos serviços (o resto fica deste).
      const semEnquadramento = (x) => { const q = enquadramento(x); return q.opSimpNac == null && q.apuracao == null; };
      for (const extra of provedores.slice(i + 1)) {
        if (!semEnquadramento(d)) break;
        const e = await consultarProvedor(extra, cnpj);
        if (e.tipo !== 'ok' || semEnquadramento(e.dados)) continue;
        Object.assign(d, { simples: e.dados.simples, mei: e.dados.mei, regimes: e.dados.regimes?.length ? e.dados.regimes : d.regimes });
      }
      const resultado = {
        cnpj, ...d,
        ativa: d.situacaoCadastral ? semAcento(d.situacaoCadastral) === 'ativa' : null,
        municipio: municipio(d.endereco.municipioIbge),
        enquadramento: enquadramento(d),
        fonte: p.nome,
        consultadoEm: new Date().toISOString(),
      };
      if (cache.size >= maxCache) cache.delete(cache.keys().next().value);
      cache.set(cnpj, { em: Date.now(), resultado });
      return resultado;
    }
    if (naoEncontrado) throw new ErroApp(404, 'CNPJ não encontrado na base pública da Receita. Confira o número ou preencha os dados manualmente.');
    throw new ErroApp(503, 'Não conseguimos falar com a base pública do CNPJ agora (o servidor do app precisa de acesso à internet). Toque em "Buscar dados" para tentar de novo, ou preencha manualmente.');
  };
}
