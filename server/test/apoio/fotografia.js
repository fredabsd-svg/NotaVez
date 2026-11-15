// Fotografia INDEPENDENTE dos dados de uma conta (não usa o código de backup): lê as tabelas direto do banco,
// decifra todos os campos cifrados e descarta só o que muda legitimamente entre servidores (dono da linha,
// índices cegos recalculados e a ordem interna das notas, cuja sequência relativa é conferida à parte).
import { createHash } from 'node:crypto';
import { decifrarBuffer, indiceCego } from '../../src/security/cripto.js';

const TABELAS = {
  prestadores: 'conta', certificados: 'empresa', clientes: 'empresa', servicos: 'empresa', notas: 'empresa',
  notas_tomadas: 'empresa', distribuicao_dfe: 'empresa', certificados_procurador: 'conta', ia_config: 'conta', ia_conversas: 'conta',
};
const VOLATEIS = new Set(['usuario_id', 'ordem', 'documento_indice', 'id_dps_indice', 'chave_indice']);
const cifrada = (k) => /_cifrad[oa]s?$/.test(k);

const ordenado = (v) => (v === null || typeof v !== 'object' ? v : Array.isArray(v) ? v.map(ordenado)
  : Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordenado(v[k])])));
export const json = (v) => JSON.stringify(ordenado(v));
export const hash = (v) => createHash('sha256').update(json(v)).digest('hex');

export async function fotografia(db, usuarioId) {
  const foto = {};
  const onde = { conta: 'usuario_id = ?', empresa: 'prestador_id IN (SELECT id FROM prestadores WHERE usuario_id = ?)' };
  for (const [t, escopo] of Object.entries(TABELAS)) {
    const linhas = await db.all(`SELECT * FROM ${t} WHERE ${onde[escopo]}`, usuarioId);
    foto[t] = linhas.map((l) => Object.fromEntries(Object.entries(l).filter(([k]) => !VOLATEIS.has(k))
      .map(([k, v]) => [k, cifrada(k) && v ? decifrarBuffer(v).toString('base64') : v])))
      .map(json).sort();
  }
  foto.ordem_das_notas = (await db.all(`SELECT id FROM notas WHERE ${onde.empresa} ORDER BY ordem`, usuarioId)).map((r) => r.id);
  return foto;
}

// Os índices cegos de busca batem com os dados decifrados (prova de que foram recalculados com a chave do servidor).
export async function conferirIndices(db, usuarioId) {
  const problemas = [];
  const dec = (v) => (v ? decifrarBuffer(v).toString('utf8') : null);
  for (const p of await db.all('SELECT * FROM prestadores WHERE usuario_id = ?', usuarioId)) {
    if (p.documento_indice !== indiceCego(dec(p.documento_cifrado))) problemas.push(`prestador ${p.id}`);
  }
  const emp = 'prestador_id IN (SELECT id FROM prestadores WHERE usuario_id = ?)';
  for (const c of await db.all(`SELECT * FROM clientes WHERE ${emp}`, usuarioId)) {
    const d = JSON.parse(dec(c.dados_cifrados));
    if ((c.documento_indice ?? null) !== (d.documento ? indiceCego(d.documento) : null)) problemas.push(`cliente ${c.id}`);
  }
  for (const n of await db.all(`SELECT * FROM notas WHERE ${emp}`, usuarioId)) {
    if ((n.chave_indice ?? null) !== (n.chave_cifrada ? indiceCego(dec(n.chave_cifrada)) : null)) problemas.push(`nota ${n.id} chave`);
    if ((n.id_dps_indice ?? null) !== (n.id_dps_cifrado ? indiceCego(dec(n.id_dps_cifrado)) : null)) problemas.push(`nota ${n.id} dps`);
  }
  for (const t of await db.all(`SELECT * FROM notas_tomadas WHERE ${emp}`, usuarioId)) {
    if (t.chave_indice !== indiceCego(dec(t.chave_cifrada))) problemas.push(`tomada ${t.id}`);
  }
  return problemas;
}
