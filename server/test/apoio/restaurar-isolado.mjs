// Servidor ISOLADO para o teste de restauração: outro processo, outro banco (PGlite em memória) e OUTRA chave
// mestra. Cria uma conta nova, envia o arquivo de backup em partes pela API, confere, restaura e devolve
// (em JSON, na saída padrão) a fotografia dos dados e as conferências de funcionamento.
//   node test/apoio/restaurar-isolado.mjs <arquivo.nsbackup> <senha>
process.env.NODE_ENV = 'test';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

process.env.NOTAVEZ_MASTER_KEY = randomBytes(32).toString('base64'); // chave diferente da do servidor de origem
const [arquivo, senha] = process.argv.slice(2);
const { criarApp } = await import('../../src/app.js');
const { fotografia, conferirIndices, hash } = await import('./fotografia.js');

const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false });
let cookie = '';
const api = async (method, url, payload, headers = {}) => {
  const r = await app.inject({ method, url, payload, remoteAddress: '198.51.100.200', headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}), ...headers } });
  if (r.headers['set-cookie']) cookie = [r.headers['set-cookie']].flat().map((c) => c.split(';')[0]).join('; ');
  let body; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};
const falhar = (etapa, r) => { process.stdout.write(JSON.stringify({ erro: etapa, status: r.status, body: r.body })); process.exit(2); };

try {
  let r = await api('POST', '/api/conta/cadastrar', { email: 'reinstalado@exemplo.test', senha: 'senha-segura-1' });
  if (r.status !== 200) falhar('cadastrar', r);
  const texto = readFileSync(arquivo, 'utf8');
  const PARTE = 1_900_000;
  const partes = Math.ceil(texto.length / PARTE);
  r = await api('POST', '/api/backup/envios', { nome: 'vindo-de-outro-servidor.nsbackup', bytes: texto.length, sha256: createHash('sha256').update(texto).digest('hex'), partes });
  if (r.status !== 200) falhar('envio', r);
  const id = r.body.backup.id;
  for (let i = 0; i < partes; i++) {
    const p = await api('PUT', `/api/backup/${id}/partes/${i}`, { dados: texto.slice(i * PARTE, (i + 1) * PARTE) });
    if (p.status !== 200) falhar(`parte ${i}`, p);
  }
  const conferido = await api('POST', `/api/backup/${id}/conferir`, { senha });
  if (conferido.status !== 200) falhar('conferir', conferido);
  const restaurado = await api('POST', `/api/backup/${id}/restaurar`, { senha, confirmacao: 'RESTAURAR' });
  if (restaurado.status !== 200) falhar('restaurar', restaurado);
  const usuarioId = (await app.ctx.db.get("SELECT id FROM usuarios WHERE email = 'reinstalado@exemplo.test'")).id;
  const foto = await fotografia(app.ctx.db, usuarioId);
  // O app funciona com os dados restaurados: listas, busca por documento (índice recalculado) e XML oficial.
  const empresas = (await api('GET', '/api/empresas')).body.empresas;
  const funcionamento = {};
  for (const e of empresas) {
    const h = { 'x-notavez-prestador': e.id };
    const notas = (await api('GET', '/api/notas', undefined, h)).body.notas;
    const emitida = notas.find((n) => n.situacao === 'emitida');
    const xml = emitida ? await app.inject({ method: 'GET', url: `/api/notas/${emitida.id}/xml`, headers: { cookie, ...h } }) : null;
    const pdf = emitida ? await app.inject({ method: 'GET', url: `/api/notas/${emitida.id}/danfse`, headers: { cookie, ...h } }) : null;
    funcionamento[e.documentoFormatado] = {
      notas: notas.length, tomadas: (await api('GET', '/api/tomadas', undefined, h)).body.tomadas.length,
      clientes: (await api('GET', '/api/clientes', undefined, h)).body.clientes.length,
      buscaCliente: (await api('GET', `/api/clientes?q=${encodeURIComponent('529.982.247-25')}`, undefined, h)).body.clientes?.length ?? null,
      // Cadastro repetido é barrado pelo índice cego do documento (recalculado com a chave deste servidor).
      clienteRepetido: (await api('POST', '/api/clientes', { documento: '529.982.247-25', nome: 'Repetida' }, h)).status,
      xmlSha: xml?.statusCode === 200 ? createHash('sha256').update(xml.body).digest('hex') : null,
      danfse: pdf ? pdf.statusCode === 200 && pdf.headers['content-type']?.includes('pdf') : null,
      certificado: !!e.certificadoValidoAte,
    };
  }
  process.stdout.write(JSON.stringify({
    ok: true, conferido: { mesmaConta: conferido.body.mesmaConta, conteudo: conferido.body.conteudo.contagens },
    restaurado: restaurado.body.contagens, hashFotografia: hash(foto), fotografia: foto,
    indices: await conferirIndices(app.ctx.db, usuarioId), ia: (await api('GET', '/api/ia/config')).body.config,
    email: (await api('GET', '/api/email/config')).body.config, funcionamento,
  }));
} finally { await app.close(); }
