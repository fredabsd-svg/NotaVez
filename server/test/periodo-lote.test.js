// Filtro por período de competências (de/até) nas listas de notas emitidas e tomadas,
// e o ZIP montado no aparelho para o download em lote (web/js/zip.js).
process.env.NODE_ENV = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';

const { criarApp } = await import('../src/app.js');
const { periodoDaConsulta } = await import('../src/routes/notas.js');
const { criarZip, crc32 } = await import('../../web/js/zip.js');

const CNPJ = '11222333000181';
function cliente(app, ip) {
  let cookie = '';
  return async (method, url, payload) => {
    const r = await app.inject({ method, url, payload, remoteAddress: ip, headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}) } });
    if (r.headers['set-cookie']) cookie = [r.headers['set-cookie']].flat().map((c) => c.split(';')[0]).join('; ');
    let body; try { body = r.json(); } catch { body = r.body; }
    return { status: r.statusCode, body };
  };
}

test('periodoDaConsulta: aceita só datas reais, troca as invertidas e ignora o resto', () => {
  assert.deepEqual(periodoDaConsulta({ de: '2026-01-01', ate: '2026-03-31' }), { de: '2026-01-01', ate: '2026-03-31' });
  assert.deepEqual(periodoDaConsulta({ de: '2026-03-31', ate: '2026-01-01' }), { de: '2026-01-01', ate: '2026-03-31' });
  assert.deepEqual(periodoDaConsulta({ de: '2026-02-30', ate: '31/03/2026' }), { de: undefined, ate: undefined });
  assert.deepEqual(periodoDaConsulta({ de: "2026-01-01' OR 1=1 --" }), { de: undefined, ate: undefined });
  assert.deepEqual(periodoDaConsulta({ ate: '2026-12-31' }), { de: undefined, ate: '2026-12-31' });
});

test('lista de notas e de tomadas por período de competências (mais de um mês)', async () => {
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false });
  try {
    const api = cliente(app, '192.0.2.120');
    await api('POST', '/api/conta/cadastrar', { email: 'periodo@exemplo.test', senha: 'senha-segura' });
    assert.equal((await api('POST', '/api/empresas', { documento: CNPJ, nome: 'Cliente', municipioIbge: '3550308', opSimpNac: '2' })).status, 200);
    const p = (await app.ctx.db.get('SELECT id, ambiente FROM prestadores'));
    const comps = ['2026-06-30', '2026-07-01', '2026-08-15', '2026-09-30', '2026-10-01'];
    for (const c of comps) await app.ctx.repo.criarNota(p.id, { descricao: `n${c}`, valor: '10.00', competencia: c });
    for (const [i, c] of comps.entries()) {
      await app.ctx.repo.salvarTomada(p.id, p.ambiente, { nsu: i + 1, chaveAcesso: String(i + 1).padStart(50, '0'), resumo: { emitente: { tipo: 'CNPJ', documento: '11444777000161', nome: `Fornecedor ${i}` } },
        nNfse: String(i + 1), competencia: c, emitidaEm: `${c}T10:00:00-03:00`, valor: '100.00', valorLiquido: '100.00', issRetido: false, xml: '<NFSe/>' });
    }
    const notas = (await api('GET', '/api/notas?de=2026-07-01&ate=2026-09-30')).body;
    assert.deepEqual(notas.notas.map((n) => n.competencia).sort(), ['2026-07-01', '2026-08-15', '2026-09-30'], 'as bordas do período entram');
    assert.equal(notas.limitado, false);
    const invertido = (await api('GET', '/api/notas?de=2026-09-30&ate=2026-07-01')).body;
    assert.equal(invertido.notas.length, 3, 'datas invertidas são trocadas');
    const soInicio = (await api('GET', '/api/notas?de=2026-09-01')).body;
    assert.deepEqual(soInicio.notas.map((n) => n.competencia).sort(), ['2026-09-30', '2026-10-01']);
    // O período tem prioridade sobre ?competencia= (um mês só).
    assert.equal((await api('GET', '/api/notas?competencia=2026-06&de=2026-07-01&ate=2026-10-31')).body.notas.length, 4);

    const tomadas = (await api('GET', '/api/tomadas?de=2026-07-01&ate=2026-09-30')).body;
    assert.deepEqual(tomadas.tomadas.map((t) => t.competencia).sort(), ['2026-07-01', '2026-08-15', '2026-09-30']);
    assert.equal(tomadas.totais.quantidade, 3);
    assert.equal(tomadas.totais.valor, '300.00');
    assert.equal(tomadas.limitado, false);
    assert.equal((await api('GET', '/api/tomadas?ate=2026-06-30')).body.tomadas.length, 1);
    assert.equal((await api('GET', '/api/tomadas?competencia=2026-08')).body.tomadas.length, 1, 'o filtro de um mês continua valendo');
  } finally { await app.close(); }
});

test('ZIP do download em lote: abre em leitor padrão, com XML comprimido, PDF guardado e nomes em UTF-8', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926, 'CRC-32 de referência');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><NFSe><xDescServ>${'Consultoria em gestão — ação '.repeat(200)}</xDescServ></NFSe>`;
  const pdf = new Uint8Array(4000).map((_, i) => (i * 31) % 251);
  const z = criarZip();
  await Promise.all([
    z.adicionar('XML/NFSe-0001.xml', xml),
    z.adicionar('PDF/DANFSe-0001.pdf', pdf, { comprimir: false }),
    z.adicionar('relação das notas.csv', '﻿"a";"b"\r\n'),
  ]);
  await z.adicionar('XML/NFSe-0001.xml', '<outro/>');
  assert.equal(z.quantidade, 4);
  const bytes = new Uint8Array(await z.gerar().arrayBuffer());
  const arquivos = unzipSync(bytes);
  assert.deepEqual(Object.keys(arquivos).sort(), ['PDF/DANFSe-0001.pdf', 'XML/NFSe-0001 (2).xml', 'XML/NFSe-0001.xml', 'relação das notas.csv']);
  assert.equal(strFromU8(arquivos['XML/NFSe-0001.xml']), xml);
  assert.deepEqual(arquivos['PDF/DANFSe-0001.pdf'], pdf);
  assert.ok(bytes.length < xml.length + pdf.length, 'o XML vai comprimido');
});
