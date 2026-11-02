// Uso local: dados fora da pasta do projeto, chave persistente, migração da pasta antiga e
// cópias de segurança automáticas que podem ser restauradas.
process.env.NODE_ENV = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const { prepararDadosLocais, iniciarBackupsAutomaticos } = await import('../src/dados-locais.js');

test('dados locais: pasta própria, chave mantida entre execuções e dados antigos trazidos sem apagar a origem', () => {
  const raiz = mkdtempSync(join(tmpdir(), 'nss-'));
  const antiga = join(raiz, 'projeto', 'dados-demo');
  mkdirSync(antiga, { recursive: true });
  const db = new DatabaseSync(join(antiga, 'notavez-demo.db'));
  db.exec("CREATE TABLE t (x); INSERT INTO t VALUES ('conta antiga')"); db.close();
  writeFileSync(join(antiga, 'chave-demo.txt'), Buffer.alloc(32, 7).toString('base64'));
  const salvo = { ...process.env };
  try {
    process.env.NOTAVEZ_DADOS_LOCAIS = join(raiz, 'casa', 'demo');
    delete process.env.NOTAVEZ_MASTER_KEY; delete process.env.NOTAVEZ_DB;
    const r = prepararDadosLocais('demo', { antigas: [antiga] });
    assert.equal(r.pasta, join(raiz, 'casa', 'demo'));
    assert.equal(process.env.NOTAVEZ_MASTER_KEY, Buffer.alloc(32, 7).toString('base64'), 'mantém a chave dos dados trazidos');
    const lido = new DatabaseSync(r.banco, { readOnly: true });
    assert.equal(lido.prepare('SELECT x FROM t').get().x, 'conta antiga');
    lido.close();
    assert.ok(existsSync(join(antiga, 'notavez-demo.db')), 'a origem não é apagada');
    // Segunda execução: mesma chave, mesmo banco.
    delete process.env.NOTAVEZ_MASTER_KEY; delete process.env.NOTAVEZ_DB;
    prepararDadosLocais('demo', { antigas: [antiga] });
    assert.equal(process.env.NOTAVEZ_MASTER_KEY, readFileSync(join(r.pasta, 'chave.txt'), 'utf8').trim());
  } finally { process.env = salvo; }
});

test('cópias de segurança automáticas: cria ao iniciar, íntegra, e guarda só as mais recentes', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'nss-bk-'));
  const banco = join(raiz, 'notavez.db');
  const db = new DatabaseSync(banco); db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t (x); INSERT INTO t VALUES ('nota 1')");
  const pastaBackups = join(raiz, 'backups');
  // Cópias antigas acima do limite saem.
  for (const n of ['2020-01-01-00-00-00', '2020-01-02-00-00-00', '2020-01-03-00-00-00']) { mkdirSync(join(pastaBackups, n), { recursive: true }); writeFileSync(join(pastaBackups, n, 'manifesto.json'), '{}'); }
  const parar = await iniciarBackupsAutomaticos({ banco, pastaBackups, manter: 2, avisar: () => {} });
  parar();
  db.close();
  const lista = readdirSync(pastaBackups).sort();
  assert.equal(lista.length, 2);
  const nova = lista.at(-1);
  assert.notEqual(nova.slice(0, 4), '2020');
  const copia = new DatabaseSync(join(pastaBackups, nova, 'notavez.db'), { readOnly: true });
  assert.equal(copia.prepare('SELECT x FROM t').get().x, 'nota 1', 'inclui o que ainda estava no WAL');
  copia.close();
  assert.equal(JSON.parse(readFileSync(join(pastaBackups, nova, 'manifesto.json'), 'utf8')).arquivo, 'notavez.db');
});
