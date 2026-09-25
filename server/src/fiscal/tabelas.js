// Tabelas oficiais (Anexos A, B e I do Portal Nacional da NFS-e), geradas por
// scripts/atualizar_tabelas.py. Atualize os JSON sem mexer no código.
import { readFileSync } from 'node:fs';

const ler = (n) => JSON.parse(readFileSync(new URL(`../data/${n}`, import.meta.url), 'utf8'));
export const municipios = ler('municipios.json');
export const servicosNacionais = ler('servicos-nacionais.json');
export const versoesTabelas = ler('versoes.json');
export const sinonimosServicos = Object.fromEntries(Object.entries(ler('sinonimos-servicos.json')).filter(([k]) => !k.startsWith('_')));

const porIbge = new Map(municipios.map((m) => [m.ibge, m]));
const porCodigo = new Map(servicosNacionais.map((s) => [s.codigo, s]));

export const municipio = (ibge) => porIbge.get(String(ibge ?? '')) || null;
export const servicoNacional = (codigo) => porCodigo.get(String(codigo ?? '')) || null;

const semAcento = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function buscarMunicipios(q, limite = 20) {
  const t = semAcento(q || '').trim();
  if (t.length < 2) return [];
  const [nome, uf] = t.split(/\s*[-/,]\s*/);
  return municipios
    .filter((m) => semAcento(m.nome).includes(nome) && (!uf || m.uf.toLowerCase() === uf))
    .sort((a, b) => semAcento(a.nome).startsWith(nome) === semAcento(b.nome).startsWith(nome) ? a.nome.localeCompare(b.nome) : semAcento(a.nome).startsWith(nome) ? -1 : 1)
    .slice(0, limite);
}

export function buscarServicos(q, limite = 30) {
  const t = semAcento(q || '').trim();
  if (!t) return [];
  const digitos = t.replace(/\D/g, '');
  const palavras = t.split(/\s+/).filter(Boolean);
  return servicosNacionais
    .filter((s) => (digitos.length >= 2 && s.codigo.startsWith(digitos.padStart(digitos.length > 4 ? 6 : 4, '0').slice(0, digitos.length > 4 ? 6 : 4)))
      || palavras.every((p) => [p, ...(sinonimosServicos[p] || []).map(semAcento)].some((x) => semAcento(`${s.descricao} ${s.item}`).includes(x))))
    .slice(0, limite);
}
