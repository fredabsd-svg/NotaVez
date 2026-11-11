process.env.NODE_ENV = 'test';
process.env.NOTAVEZ_ESPERA_REENVIO_MS = '0';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gerarCertificadoTeste } from './apoio/certificado-teste.js';
const { abrirBanco } = await import('../src/db/banco.js');
const { criarRepositorio } = await import('../src/db/repositorio.js');
const { criarServicoEmissao } = await import('../src/fiscal/emissao.js');
const { lerCertificado } = await import('../src/fiscal/certificado.js');
const { ambientesSefin } = await import('../src/config.js');
const cert = gerarCertificadoTeste();
const rascunho = { competencia: '2026-09-01', cTribNac: '010101', descricao: 'Serviço de teste', valor: '150.00', tomador: { tipo: 'NENHUM' } };
function fixture(t, cliente = {}) {
  const db = abrirBanco(':memory:');
  t.after(() => db.fechar());
  db.run("INSERT INTO usuarios VALUES ('u','teste@example.test','irrelevante','2026-01-01')");
  const repo = criarRepositorio(db);
  const p = { tipoDocumento: 'CNPJ', documento: '11222333000181', nome: 'Teste', municipioIbge: '3550308', opSimpNac: '2', ambiente: 'producao_restrita' };
  const id = repo.salvarPrestador('u', p);
  repo.salvarCertificado(id, { ...cert, info: lerCertificado(cert.pfx, cert.senha) });
  const chamadas = [];
  const service = criarServicoEmissao({ repo, fabricaCliente: (o) => {
    chamadas.push({ operacao: 'cliente', baseUrl: o.baseUrl, certPem: o.certPem });
    return { enviarDps: async (xml) => { chamadas.push({ operacao: 'envio', xml }); return { tipo: 'incerta' }; },
      consultarDps: async (id) => { chamadas.push({ operacao: 'consulta', id }); return { tipo: 'incerta' }; },
      consultarNfse: async () => ({ tipo: 'incerta' }), ...cliente };
  } });
  t.after(() => service.fecharClientes());
  return { db, repo, service, p: repo.prestador(id), perfil: p, chamadas, notaId: repo.criarNota(id, rascunho) };
}
function abandonar(f, id = f.notaId, estado = 'enviando', idDps = 'DPSORIGINAL') {
  assert.ok(f.repo.transicionar(id, 'rascunho', estado, { ambiente: f.p.ambiente, contextoEmitente: f.p, idDps, dpsXml: '<original/>', tentativas: 1, ultimoEnvioEm: '2026-01-01T00:00:00.000Z', processamentoToken: 'processo-encerrado', processamentoAte: '2026-01-01T00:00:00.000Z' }));
}
test('retoma enviando abandonado consultando DPS original, sem reenviar consulta inconclusiva', async (t) => {
  const f = fixture(t); abandonar(f);
  const n = await f.service.verificar(f.p, f.notaId);
  assert.equal(n.situacao, 'pendente');
  assert.equal(n.idDps, 'DPSORIGINAL');
  assert.deepEqual(f.chamadas.filter(c => c.operacao !== 'cliente'), [{ operacao: 'consulta', id: 'DPSORIGINAL' }]);
  assert.equal(f.repo.notaPorId(f.notaId).processamentoToken, null);
});
test('posse não vencida impede outro processo consultar ou reenviar', async (t) => {
  const f = fixture(t); abandonar(f);
  f.repo.transicionar(f.notaId, 'enviando', 'enviando', { processamentoAte: new Date(Date.now() + 60_000).toISOString() });
  await f.service.verificar(f.p, f.notaId);
  await f.service.verificarPendentes();
  assert.equal(f.chamadas.length, 0);
});
test('perfil muda ambiente e certificado renova: consulta e reenvio mantêm contexto e XML originais', async (t) => {
  let enviado;
  const f = fixture(t, { consultarDps: async () => ({ tipo: 'nao_encontrada' }), enviarDps: async xml => { enviado = xml; return { tipo: 'incerta' }; } });
  abandonar(f, f.notaId, 'pendente');
  f.repo.salvarPrestador('u', { ...f.perfil, ambiente: 'producao' });
  const renovado = gerarCertificadoTeste({ nome: 'RENOVADO' });
  f.repo.salvarCertificado(f.p.id, { ...renovado, info: lerCertificado(renovado.pfx, renovado.senha) });
  await f.service.verificar(f.repo.prestador(f.p.id), f.notaId);
  assert.equal(f.chamadas[0].baseUrl, ambientesSefin.producao_restrita.sefin);
  assert.equal(f.chamadas[0].certPem, renovado.certPem);
  assert.equal(enviado, '<original/>');
  assert.equal(f.repo.notaPorId(f.notaId).ambiente, 'producao_restrita');
  assert.throws(() => f.repo.salvarPrestador('u', { ...f.perfil, documento: '11444777000161' }), /pendentes/);
});
test('certificado incompatível ou vencido nunca consulta nem reenvia uma pendência', async (t) => {
  const f = fixture(t); abandonar(f);
  for (const info of [ { ...lerCertificado(cert.pfx, cert.senha), cnpj: '11444777000161' }, { ...lerCertificado(cert.pfx, cert.senha), validoAte: '2020-01-01' } ]) {
    f.repo.salvarCertificado(f.p.id, { ...cert, info });
    await assert.rejects(f.service.verificar(f.p, f.notaId), e => e.status === 403);
  }
  assert.equal(f.chamadas.length, 0);
});
test('edição durante preparação fiscal provoca conflito CAS sem enviar XML desatualizado', async (t) => {
  const f = fixture(t);
  const original = f.repo.proximoNumeroDps;
  f.repo.proximoNumeroDps = (...args) => {
    assert.ok(f.repo.atualizarRascunho(f.p.id, f.notaId, { ...rascunho, valor: '999.00' }, 1));
    return original(...args);
  };
  await assert.rejects(f.service.emitir(f.p, f.notaId), e => e.status === 409);
  assert.equal(f.repo.notaPorId(f.notaId).valor, '999.00');
  assert.equal(f.repo.notaPorId(f.notaId).situacao, 'rascunho');
  assert.equal(f.chamadas.length, 0);
});
test('revisão aprovada é invalidada por edição e por mudança de perfil', async (t) => {
  const f = fixture(t);
  const revisado = await f.service.validarNota(f.p, f.notaId, 1);
  assert.equal(revisado.ok, true);
  f.repo.atualizarRascunho(f.p.id, f.notaId, { ...rascunho, valor: '999.00' }, 1);
  await assert.rejects(f.service.emitir(f.p, f.notaId, revisado), e => e.status === 409);
  const novo = await f.service.validarNota(f.p, f.notaId, 2);
  f.repo.salvarPrestador('u', { ...f.perfil, nome: 'Outra revisão' });
  await assert.rejects(f.service.emitir(f.repo.prestador(f.p.id), f.notaId, novo), e => e.status === 409);
  assert.equal(f.chamadas.length, 0);
});
test('resultado externo seguido por falha de persistência preserva identidade e permite reconciliação', async (t) => {
  let consultas = 0;
  const f = fixture(t, { enviarDps: async () => ({ tipo: 'emitida', chaveAcesso: '1'.repeat(50), nfseXml: '<NFSe><infNFSe/></NFSe>' }), consultarDps: async () => { consultas++; return { tipo: 'encontrada', chaveAcesso: '1'.repeat(50) }; } });
  const original = f.repo.transicionar;
  f.repo.transicionar = (...args) => { if (args[2] === 'emitida') throw new Error('disco falhou'); return original(...args); };
  await assert.rejects(f.service.emitir(f.p, f.notaId), e => e.status === 503 && e.extra.resultadoIncerto && !!e.extra.operacao.idDps);
  const pendente = f.repo.notaPorId(f.notaId);
  assert.equal(pendente.situacao, 'pendente');
  assert.ok(pendente.idDps && f.repo.xmlDps(f.notaId));
  f.repo.transicionar = original;
  const emitida = await f.service.verificar(f.p, f.notaId);
  assert.equal(emitida.situacao, 'emitida');
  assert.equal(emitida.idDps, pendente.idDps);
  assert.equal(consultas, 1);
  assert.equal(f.chamadas.filter(c => c.operacao === 'cliente').length, 1);
});
test('worker avança além das primeiras 100 pendências sem certificado', async (t) => {
  const f = fixture(t); f.repo.removerCertificado(f.p.id);
  for (let i = 0; i < 101; i++) abandonar(f, f.repo.criarNota(f.p.id, rascunho), 'pendente', `DPS${i}`);
  await f.service.verificarPendentes();
  assert.equal(f.db.get('SELECT COUNT(*) n FROM notas WHERE verificacoes = 1').n, 100);
  await f.service.verificarPendentes();
  assert.equal(f.db.get('SELECT COUNT(*) n FROM notas WHERE verificacoes = 1').n, 101);
});
test('migração preserva banco antigo, recupera contexto da DPS e separa unicidade por ambiente', (t) => {
  const pasta = mkdtempSync(join(tmpdir(), 'notavez-migracao-'));
  t.after(() => rmSync(pasta, { recursive: true, force: true }));
  const arquivo = join(pasta, 'existente.db');
  const antigo = new DatabaseSync(arquivo);
  const schemaAntigo = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8')
    .replace('  versao INTEGER NOT NULL DEFAULT 1,\n', '')
    .replace(/^  (contexto_emitente_cifrado|processamento_token|processamento_ate|proxima_verificacao_em|verificacoes).*\n/gm, '')
    .replace('ON notas(ambiente, id_dps_indice)', 'ON notas(id_dps_indice)');
  antigo.exec(schemaAntigo);
  const adapter = { get: (sql, ...p) => antigo.prepare(sql).get(...p), run: (sql, ...p) => antigo.prepare(sql).run(...p) };
  adapter.run("INSERT INTO usuarios VALUES ('u','teste@example.test','hash','2026-01-01')");
  const repoAntigo = criarRepositorio(adapter);
  const idP = repoAntigo.salvarPrestador('u', { tipoDocumento: 'CNPJ', documento: '11444777000161', nome: 'Legado', municipioIbge: '3304557', opSimpNac: '2' });
  const idNota = repoAntigo.criarNota(idP, rascunho);
  repoAntigo.transicionar(idNota, 'rascunho', 'enviando', { ambiente: 'producao_restrita', idDps: 'DPSLEGADA', dpsXml: '<DPS><infDPS><tpAmb>2</tpAmb><cLocEmi>3550308</cLocEmi><prest><CNPJ>11222333000181</CNPJ></prest></infDPS></DPS>' });
  antigo.close();
  const db = abrirBanco(arquivo); const repo = criarRepositorio(db);
  assert.equal(repo.notaPorId(idNota).valor, '150.00');
  assert.equal(repo.notaPorId(idNota).contextoEmitente.documento, '11222333000181', 'identidade vem da DPS, não do perfil atual');
  assert.equal(repo.prestador(idP).versao, 1);
  const prod = repo.criarNota(idP, rascunho);
  assert.ok(repo.transicionar(prod, 'rascunho', 'enviando', { ambiente: 'producao', idDps: 'DPSLEGADA' }));
  const duplicate = repo.criarNota(idP, rascunho);
  assert.throws(() => repo.transicionar(duplicate, 'rascunho', 'enviando', { ambiente: 'producao', idDps: 'DPSLEGADA' }), /UNIQUE/);
  db.fechar();
  const reaberto = abrirBanco(arquivo);
  assert.equal(reaberto.get('SELECT COUNT(*) n FROM notas').n, 3);
  reaberto.fechar();
});
test('certificado renovado ou perfil modificado durante preparação impede claim de dados antigos', async (t) => {
  for (const alterar of ['perfil', 'certificado']) {
    const f = fixture(t);
    const original = f.repo.proximoNumeroDps;
    f.repo.proximoNumeroDps = (...args) => {
      if (alterar === 'perfil') f.repo.salvarPrestador('u', { ...f.perfil, nome: 'Perfil mudou' });
      else f.repo.salvarCertificado(f.p.id, { ...cert, info: lerCertificado(cert.pfx, cert.senha) });
      return original(...args);
    };
    await assert.rejects(f.service.emitir(f.p, f.notaId), e => e.status === 409);
    assert.equal(f.chamadas.length, 0);
  }
});
test('CAS entre duas instâncias impede dupla emissão da mesma nota', async (t) => {
  let liberar; let iniciou;
  const inicio = new Promise(r => { iniciou = r; });
  const fim = new Promise(r => { liberar = r; });
  const f = fixture(t, { enviarDps: async () => { iniciou(); await fim; return { tipo: 'incerta' }; } });
  const primeiro = f.service.emitir(f.p, f.notaId);
  await inicio;
  const outro = criarServicoEmissao({ repo: f.repo, fabricaCliente: () => { throw new Error('Não deveria chamar'); } });
  await assert.rejects(outro.emitir(f.p, f.notaId), e => e.status === 409);
  liberar(); await primeiro;
  assert.equal(f.repo.notaPorId(f.notaId).tentativas, 1);
});
test('remoção ou renovação do A1 durante consulta impede reenvio com certificado anterior', async (t) => {
  for (const alterar of ['remover', 'renovar']) {
    let f; let envios = 0;
    f = fixture(t, {
      consultarDps: async () => {
        if (alterar === 'remover') f.repo.removerCertificado(f.p.id);
        else f.repo.salvarCertificado(f.p.id, { ...cert, info: lerCertificado(cert.pfx, cert.senha) });
        return { tipo: 'nao_encontrada' };
      },
      enviarDps: async () => { envios++; return { tipo: 'incerta' }; },
    });
    abandonar(f, f.notaId, 'pendente');
    await assert.rejects(f.service.verificar(f.p, f.notaId), e => e.status === 409);
    const n = f.repo.notaPorId(f.notaId);
    assert.equal(envios, 0, alterar);
    assert.equal(n.tentativas, 1);
    assert.equal(n.situacao, 'pendente');
    assert.equal(n.idDps, 'DPSORIGINAL');
    assert.equal(n.processamentoToken, null);
  }
});
test('A1 vencido enquanto consulta DPS não é usado para reenviar', async (t) => {
  let envios = 0;
  const f = fixture(t, {
    consultarDps: async () => {
      t.mock.timers.enable({ apis: ['Date'], now: new Date(lerCertificado(cert.pfx, cert.senha).validoAte).getTime() + 1 });
      return { tipo: 'nao_encontrada' };
    },
    enviarDps: async () => { envios++; return { tipo: 'incerta' }; },
  });
  abandonar(f, f.notaId, 'pendente');
  await assert.rejects(f.service.verificar(f.p, f.notaId), e => e.status === 403);
  assert.equal(envios, 0);
  assert.equal(f.repo.notaPorId(f.notaId).tentativas, 1);
  assert.equal(f.repo.notaPorId(f.notaId).processamentoToken, null);
});
test('remoção concorrente depois de validar A1 perde CAS do reenvio sem consumir tentativa', async (t) => {
  let envios = 0;
  const f = fixture(t, {
    consultarDps: async () => ({ tipo: 'nao_encontrada' }),
    enviarDps: async () => { envios++; return { tipo: 'incerta' }; },
  });
  abandonar(f, f.notaId, 'pendente');
  const transicionar = f.repo.transicionar;
  f.repo.transicionar = (...args) => {
    // Representa outro processo removendo o A1 antes do UPDATE condicional.
    if (args[3]?.tentativas === 2) f.repo.removerCertificado(f.p.id);
    return transicionar(...args);
  };
  const n = await f.service.verificar(f.p, f.notaId);
  assert.equal(envios, 0);
  assert.equal(n.situacao, 'pendente');
  assert.equal(n.tentativas, 1);
  assert.equal(n.idDps, 'DPSORIGINAL');
  assert.equal(f.repo.notaPorId(f.notaId).processamentoToken, null);
});
test('rotas de renovação e remoção fecham somente os clientes fiscais do titular', async (t) => {
  const { criarApp } = await import('../src/app.js');
  const clientes = [];
  const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, entregarRecuperacao: null,
    fabricaCliente: () => {
      const cliente = { fechado: false, consultarDps: async () => ({ tipo: 'falha' }), fechar() { this.fechado = true; } };
      clientes.push(cliente);
      return cliente;
    },
  });
  t.after(() => app.close());
  const { auth, repo, emissao } = app.ctx;
  const perfis = [];
  for (const email of ['a@teste.invalid', 'b@teste.invalid']) {
    const conta = auth.cadastrar(email, 'senha-segura', email);
    const id = repo.salvarPrestador(conta.usuarioId, { tipoDocumento: 'CNPJ', documento: '11222333000181', nome: email, municipioIbge: '3550308', opSimpNac: '2', ambiente: 'producao_restrita' });
    repo.salvarCertificado(id, { ...cert, info: lerCertificado(cert.pfx, cert.senha) });
    const p = repo.prestador(id);
    const notaId = repo.criarNota(id, rascunho);
    repo.transicionar(notaId, 'rascunho', 'pendente', { ambiente: p.ambiente, contextoEmitente: p, idDps: email, dpsXml: '<original/>', tentativas: 1, ultimoEnvioEm: '2026-01-01T00:00:00.000Z' });
    await emissao.verificar(p, notaId);
    perfis.push({ p, notaId, token: conta.token });
  }
  const headers = { cookie: `nv_sessao=${perfis[0].token}`, 'x-notavez': '1' };
  const renovacao = await app.inject({ method: 'POST', url: '/api/certificado', headers,
    payload: { consentimento: true, pfxBase64: cert.pfx.toString('base64'), senha: cert.senha } });
  assert.equal(renovacao.statusCode, 200);
  assert.deepEqual(clientes.map(c => c.fechado), [true, false]);
  await emissao.verificar(perfis[0].p, perfis[0].notaId);
  assert.deepEqual(clientes.map(c => c.fechado), [true, false, false]);
  const remocao = await app.inject({ method: 'DELETE', url: '/api/certificado', headers });
  assert.equal(remocao.statusCode, 200);
  assert.deepEqual(clientes.map(c => c.fechado), [true, false, true]);
  assert.ok(repo.certificadoAtivo(perfis[1].p.id));
});
