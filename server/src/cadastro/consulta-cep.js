// Consulta de CEP (dados públicos dos Correios): ViaCEP e, se falhar, BrasilAPI. Devolve o endereço e o código
// IBGE do município, usado para conferir que o CEP da obra é do município do local da prestação (regra E0380).
import { ErroApp } from '../util/erros.js';
import { municipios } from '../fiscal/tabelas.js';

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const ibgePorNome = (cidade, uf) => municipios.find((m) => m.uf === String(uf || '').toUpperCase() && semAcento(m.nome) === semAcento(cidade))?.ibge || null;

const PROVEDORES = [
  { nome: 'ViaCEP', url: (c) => `https://viacep.com.br/ws/${c}/json/`,
    ler: (d) => (d?.erro ? null : { logradouro: d.logradouro, bairro: d.bairro, cidade: d.localidade, uf: d.uf, ibge: d.ibge }) },
  { nome: 'BrasilAPI', url: (c) => `https://brasilapi.com.br/api/cep/v1/${c}`,
    ler: (d) => (d?.city ? { logradouro: d.street, bairro: d.neighborhood, cidade: d.city, uf: d.state, ibge: null } : null) },
];

export function criarConsultaCep({ buscar = globalThis.fetch, provedores = PROVEDORES, timeoutMs = 6000, maxCache = 2000 } = {}) {
  const cache = new Map();
  return async function consultar(valor) {
    const cep = String(valor || '').replace(/\D/g, '');
    if (!/^\d{8}$/.test(cep)) throw new ErroApp(422, 'CEP inválido: são 8 números.');
    if (cache.has(cep)) return cache.get(cep);
    let algumRespondeu = false;
    for (const p of provedores) {
      let r;
      try { r = await buscar(p.url(cep), { headers: { Accept: 'application/json', 'User-Agent': 'NotaSemStress/0.1' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); } catch { continue; }
      if (r.status === 404 || r.status === 400) { algumRespondeu = true; continue; }
      if (!r.ok) continue;
      algumRespondeu = true;
      let d;
      try { d = p.ler(await r.json()); } catch { continue; }
      if (!d) continue;
      const ibge = /^\d{7}$/.test(String(d.ibge || '')) ? String(d.ibge) : ibgePorNome(d.cidade, d.uf);
      const resultado = { cep, logradouro: String(d.logradouro || '').trim(), bairro: String(d.bairro || '').trim(), municipio: d.cidade || null, uf: d.uf || null, municipioIbge: ibge };
      if (cache.size >= maxCache) cache.delete(cache.keys().next().value);
      cache.set(cep, resultado);
      return resultado;
    }
    if (algumRespondeu) throw new ErroApp(404, 'CEP não encontrado. Confira os números ou preencha o endereço à mão.');
    throw new ErroApp(503, 'A consulta de CEP não respondeu agora. Preencha o endereço à mão.');
  };
}
