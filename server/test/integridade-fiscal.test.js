process.env.NODE_ENV = 'test';
process.env.NOTAVEZ_ESPERA_REENVIO_MS = '0';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { gerarCertificadoTeste } from './apoio/certificado-teste.js';
const { abrirBanco } = await import('../src/db/banco.js');
const { criarRepositorio } = await import('../src/db/repositorio.js');
const { criarServicoEmissao } = await import('../src/fiscal/emissao.js');
const { lerCertificado } = await import('../src/fiscal/certificado.js');
const { ambientesSefin } = await import('../src/config.js');
const cert = gerarCertificadoTeste();
const rascunho = { competencia: '2026-09-01', cTribNac: '010101', descricao: 'Serviço de teste', valor: '150.00', tomador: { tipo: 'NENHUM' } };
async function fixture(t, cliente = {}) {
  const db = await abrirBanco(':memory:');
  t.after(() => db.fechar());
  // Conta própria de cada fixture: o mesmo teste pode rodar contra um Postgres compartilhado (DATABASE_URL).
  const uid = randomUUID();
  await db.run("INSERT INTO usuarios (id, email, senha_hash, criado_em) VALUES (?, ?, 'irrelevante', '2026-01-01')", uid, `${uid}@example.test`);
  const repo = criarRepositorio(db);
  const p = { tipoDocumento: 'CNPJ', documento: '11222333000181', nome: 'Teste', municipioIbge: '3550308', opSimpNac: '2', ambiente: 'producao_restrita' };
  const id = await repo.salvarPrestador(uid, null, p);
  await repo.salvarCertificado(id, { ...cert, info: lerCertificado(cert.pfx, cert.senha) });
  const chamadas = [];
  const service = criarServicoEmissao({ repo, fabricaCliente: (o) => {
    chamadas.push({ operacao: 'cliente', baseUrl: o.baseUrl, certPem: o.certPem });
    return { enviarDps: async (xml) => { chamadas.push({ operacao: 'envio', xml }); return { tipo: 'incerta' }; },
      consultarDps: async (id) => { chamadas.push({ operacao: 'consulta', id }); return { tipo: 'incerta' }; },
      consultarNfse: async () => ({ tipo: 'incerta' }), ...cliente };
  } });
  t.after(() => service.fecharClientes());
  return { db, repo, service, uid, p: await repo.prestador(id), perfil: p, chamadas, notaId: await repo.criarNota(id, rascunho) };
}
async function abandonar(f, id = f.notaId, estado = 'enviando', idDps = 'DPSORIGINAL') {
  assert.ok(await f.repo.transicionar(id, 'rascunho', estado, { ambiente: f.p.ambiente, contextoEmitente: f.p, idDps, dpsXml: '<original/>', tentativas: 1, ultimoEnvioEm: '2026-01-01T00:00:00.000Z', processamentoToken: 'processo-encerrado', processamentoAte: '2026-01-01T00:00:00.000Z' }));
}
test('retoma enviando abandonado consultando DPS original, sem reenviar consulta inconclusiva', async (t) => {
  const f = await fixture(t); await abandonar(f);
  const n = await f.service.verificar(f.p, f.notaId);
  assert.equal(n.situacao, 'pendente');
  assert.equal(n.idDps, 'DPSORIGINAL');
  assert.deepEqual(f.chamadas.filter(c => c.operacao !== 'cliente'), [{ operacao: 'consulta', id: 'DPSORIGINAL' }]);
  assert.equal((await f.repo.notaPorId(f.notaId)).processamentoToken, null);
});
test('posse não vencida impede outro processo consultar ou reenviar', async (t) => {
  const f = await fixture(t); await abandonar(f);
  await f.repo.transicionar(f.notaId, 'enviando', 'enviando', { processamentoAte: new Date(Date.now() + 60_000).toISOString() });
  await f.service.verificar(f.p, f.notaId);
  await f.service.verificarPendentes();
  assert.equal(f.chamadas.length, 0);
});
test('perfil muda ambiente e certificado renova: consulta e reenvio mantêm contexto e XML originais', async (t) => {
  let enviado;
  const f = await fixture(t, { consultarDps: async () => ({ tipo: 'nao_encontrada' }), enviarDps: async xml => { enviado = xml; return { tipo: 'incerta' }; } });
  await abandonar(f, f.notaId, 'pendente');
  await f.repo.salvarPrestador(f.uid, f.p.id, { ...f.perfil, ambiente: 'producao' });
  const renovado = gerarCertificadoTeste({ nome: 'RENOVADO' });
  await f.repo.salvarCertificado(f.p.id, { ...renovado, info: lerCertificado(renovado.pfx, renovado.senha) });
  await f.service.verificar(await f.repo.prestador(f.p.id), f.notaId);
  assert.equal(f.chamadas[0].baseUrl, ambientesSefin.producao_restrita.sefin);
  assert.equal(f.chamadas[0].certPem, renovado.certPem);
  assert.equal(enviado, '<original/>');
  assert.equal((await f.repo.notaPorId(f.notaId)).ambiente, 'producao_restrita');
  await assert.rejects(f.repo.salvarPrestador(f.uid, f.p.id, { ...f.perfil, documento: '11444777000161' }), /pendentes/);
});
test('certificado incompatível ou vencido nunca consulta nem reenvia uma pendência', async (t) => {
  const f = await fixture(t); await abandonar(f);
  for (const info of [ { ...lerCertificado(cert.pfx, cert.senha), cnpj: '11444777000161' }, { ...lerCertificado(cert.pfx, cert.senha), validoAte: '2020-01-01' } ]) {
    await f.repo.salvarCertificado(f.p.id, { ...cert, info });
    await assert.rejects(f.service.verificar(f.p, f.notaId), e => e.status === 403);
  }
  assert.equal(f.chamadas.length, 0);
});
test('edição durante preparação fiscal provoca conflito CAS sem enviar XML desatualizado', async (t) => {
  const f = await fixture(t);
  const original = f.repo.proximoNumeroDps;
  f.repo.proximoNumeroDps = async (...args) => {
    assert.ok(await f.repo.atualizarRascunho(f.p.id, f.notaId, { ...rascunho, valor: '999.00' }, 1));
    return await original(...args);
  };
  await assert.rejects(f.service.emitir(f.p, f.notaId), e => e.status === 409);
  assert.equal((await f.repo.notaPorId(f.notaId)).valor, '999.00');
  assert.equal((await f.repo.notaPorId(f.notaId)).situacao, 'rascunho');
  assert.equal(f.chamadas.length, 0);
});
test('revisão aprovada é invalidada por edição e por mudança de perfil', async (t) => {
  const f = await fixture(t);
  const revisado = await f.service.validarNota(f.p, f.notaId, 1);
  assert.equal(revisado.ok, true);
  await f.repo.atualizarRascunho(f.p.id, f.notaId, { ...rascunho, valor: '999.00' }, 1);
  await assert.rejects(f.service.emitir(f.p, f.notaId, revisado), e => e.status === 409);
  const novo = await f.service.validarNota(f.p, f.notaId, 2);
  await f.repo.salvarPrestador(f.uid, f.p.id, { ...f.perfil, nome: 'Outra revisão' });
  await assert.rejects(f.service.emitir(await f.repo.prestador(f.p.id), f.notaId, novo), e => e.status === 409);
  assert.equal(f.chamadas.length, 0);
});
// A NFS-e oficial traz dentro dela a DPS que a originou, como foi enviada.
const nfseDe = (dpsXml, chave = '1'.repeat(50)) => `<NFSe><infNFSe Id="NFS${chave}"><nNFSe>7</nNFSe>${String(dpsXml).replace(/^<\?xml[^>]*>/, '')}</infNFSe></NFSe>`;
test('resultado externo seguido por falha de persistência preserva identidade e permite reconciliação', async (t) => {
  let consultas = 0; let enviada;
  const f = await fixture(t, { enviarDps: async (xml) => { enviada = xml; return { tipo: 'emitida', chaveAcesso: '1'.repeat(50), nfseXml: nfseDe(xml) }; },
    consultarDps: async () => { consultas++; return { tipo: 'encontrada', chaveAcesso: '1'.repeat(50) }; },
    consultarNfse: async () => ({ tipo: 'ok', nfseXml: nfseDe(enviada) }) });
  const original = f.repo.transicionar;
  f.repo.transicionar = async (...args) => { if (args[2] === 'emitida') throw new Error('disco falhou'); return await original(...args); };
  await assert.rejects(f.service.emitir(f.p, f.notaId), e => e.status === 503 && e.extra.resultadoIncerto && !!e.extra.operacao.idDps);
  const pendente = await f.repo.notaPorId(f.notaId);
  assert.equal(pendente.situacao, 'pendente');
  assert.ok(pendente.idDps && await f.repo.xmlDps(f.notaId));
  f.repo.transicionar = original;
  const emitida = await f.service.verificar(f.p, f.notaId);
  assert.equal(emitida.situacao, 'emitida');
  assert.equal(emitida.idDps, pendente.idDps);
  assert.equal(consultas, 1);
  assert.equal(f.chamadas.filter(c => c.operacao === 'cliente').length, 1);
});
test('DPS encontrada na Receita só conclui a nota se for a DPS enviada pelo app', async (t) => {
  // Outro sistema da empresa já usou a mesma série e número: a Receita recusa por duplicidade e a
  // consulta pelo Id devolve a nota DELE (outra data de emissão, outro valor).
  const deOutroSistema = '<DPS><infDPS Id="DPSX"><dhEmi>2025-03-10T09:00:00-03:00</dhEmi><valores><vServPrest><vServ>999.00</vServ></vServPrest></valores></infDPS></DPS>';
  let resposta = { tipo: 'incerta' };
  const f = await fixture(t, { enviarDps: async () => ({ tipo: 'duplicada', erros: [{ codigo: 'E0014', descricao: 'DPS já existe' }] }),
    consultarDps: async () => ({ tipo: 'encontrada', chaveAcesso: '2'.repeat(50) }),
    consultarNfse: async () => resposta });
  // Sem o XML da nota encontrada não dá para afirmar de quem ela é: continua pendente, sem chave.
  let n = await f.service.emitir(f.p, f.notaId);
  assert.equal(n.situacao, 'pendente');
  assert.equal(n.chaveAcesso, null);
  // Com o XML: não é a DPS do app. A nota do app não foi emitida e volta a poder ser enviada, com outro número.
  resposta = { tipo: 'ok', nfseXml: nfseDe(deOutroSistema, '2'.repeat(50)) };
  await f.db.run('UPDATE notas SET processamento_ate = NULL WHERE id = ?', f.notaId);
  n = await f.service.verificar(f.p, f.notaId);
  assert.equal(n.situacao, 'rejeitada');
  assert.equal(n.chaveAcesso, null, 'a chave da nota do outro sistema não é atribuída à nota do app');
  assert.equal(n.idDps, null);
  assert.equal(n.erros[0].codigo, 'DPS_DE_OUTRO_SISTEMA');
  assert.match(n.erros[0].proximoPasso, /Série da DPS/);
  assert.equal(await f.repo.xmlNfse(f.notaId), null);
});
test('worker avança além das primeiras 100 pendências sem certificado', async (t) => {
  const f = await fixture(t); await f.repo.removerCertificado(f.p.id);
  for (let i = 0; i < 101; i++) await abandonar(f, await f.repo.criarNota(f.p.id, rascunho), 'pendente', `DPS${i}`);
  await f.service.verificarPendentes();
  assert.equal((await f.db.get('SELECT COUNT(*) n FROM notas WHERE verificacoes = 1')).n, 100);
  await f.service.verificarPendentes();
  assert.equal((await f.db.get('SELECT COUNT(*) n FROM notas WHERE verificacoes = 1')).n, 101);
});
test('Id da DPS é único por ambiente e o banco numa pasta sobrevive a reabrir', async (t) => {
  const pasta = mkdtempSync(join(tmpdir(), 'notavez-pglite-'));
  t.after(() => rmSync(pasta, { recursive: true, force: true }));
  let db = await abrirBanco(pasta); let repo = criarRepositorio(db);
  await db.run("INSERT INTO usuarios (id, email, senha_hash, criado_em) VALUES ('u','teste@example.test','hash','2026-01-01')");
  const idP = await repo.salvarPrestador('u', null, { tipoDocumento: 'CNPJ', documento: '11444777000161', nome: 'Legado', municipioIbge: '3304557', opSimpNac: '2' });
  const restrita = await repo.criarNota(idP, rascunho);
  assert.ok(await repo.transicionar(restrita, 'rascunho', 'enviando', { ambiente: 'producao_restrita', idDps: 'DPSREPETIDA' }));
  const prod = await repo.criarNota(idP, rascunho);
  assert.ok(await repo.transicionar(prod, 'rascunho', 'enviando', { ambiente: 'producao', idDps: 'DPSREPETIDA' }), 'mesmo Id em outro ambiente é permitido');
  const duplicada = await repo.criarNota(idP, rascunho);
  await assert.rejects(repo.transicionar(duplicada, 'rascunho', 'enviando', { ambiente: 'producao', idDps: 'DPSREPETIDA' }), /duplicate key|unique/i);
  assert.equal((await repo.prestador(idP)).versao, 1);
  await db.fechar();
  db = await abrirBanco(pasta); repo = criarRepositorio(db);
  assert.equal((await db.get('SELECT COUNT(*) n FROM notas')).n, 3);
  assert.equal((await repo.notaPorId(prod)).valor, '150.00');
  await db.fechar();
});
test('certificado renovado ou perfil modificado durante preparação impede claim de dados antigos', async (t) => {
  for (const alterar of ['perfil', 'certificado']) {
    const f = await fixture(t);
    const original = f.repo.proximoNumeroDps;
    f.repo.proximoNumeroDps = async (...args) => {
      if (alterar === 'perfil') await f.repo.salvarPrestador(f.uid, f.p.id, { ...f.perfil, nome: 'Perfil mudou' });
      else await f.repo.salvarCertificado(f.p.id, { ...cert, info: lerCertificado(cert.pfx, cert.senha) });
      return await original(...args);
    };
    await assert.rejects(f.service.emitir(f.p, f.notaId), e => e.status === 409);
    assert.equal(f.chamadas.length, 0);
  }
});
test('CAS entre duas instâncias impede dupla emissão da mesma nota', async (t) => {
  let liberar; let iniciou;
  const inicio = new Promise(r => { iniciou = r; });
  const fim = new Promise(r => { liberar = r; });
  const f = await fixture(t, { enviarDps: async () => { iniciou(); await fim; return { tipo: 'incerta' }; } });
  const primeiro = f.service.emitir(f.p, f.notaId);
  await inicio;
  const outro = criarServicoEmissao({ repo: f.repo, fabricaCliente: () => { throw new Error('Não deveria chamar'); } });
  await assert.rejects(outro.emitir(f.p, f.notaId), e => e.status === 409);
  liberar(); await primeiro;
  assert.equal((await f.repo.notaPorId(f.notaId)).tentativas, 1);
});
test('remoção ou renovação do A1 durante consulta impede reenvio com certificado anterior', async (t) => {
  for (const alterar of ['remover', 'renovar']) {
    let f; let envios = 0;
    f = await fixture(t, {
      consultarDps: async () => {
        if (alterar === 'remover') await f.repo.removerCertificado(f.p.id);
        else await f.repo.salvarCertificado(f.p.id, { ...cert, info: lerCertificado(cert.pfx, cert.senha) });
        return { tipo: 'nao_encontrada' };
      },
      enviarDps: async () => { envios++; return { tipo: 'incerta' }; },
    });
    await abandonar(f, f.notaId, 'pendente');
    await assert.rejects(f.service.verificar(f.p, f.notaId), e => e.status === 409);
    const n = await f.repo.notaPorId(f.notaId);
    assert.equal(envios, 0, alterar);
    assert.equal(n.tentativas, 1);
    assert.equal(n.situacao, 'pendente');
    assert.equal(n.idDps, 'DPSORIGINAL');
    assert.equal(n.processamentoToken, null);
  }
});
test('A1 vencido enquanto consulta DPS não é usado para reenviar', async (t) => {
  let envios = 0;
  const f = await fixture(t, {
    consultarDps: async () => {
      t.mock.timers.enable({ apis: ['Date'], now: new Date(lerCertificado(cert.pfx, cert.senha).validoAte).getTime() + 1 });
      return { tipo: 'nao_encontrada' };
    },
    enviarDps: async () => { envios++; return { tipo: 'incerta' }; },
  });
  await abandonar(f, f.notaId, 'pendente');
  await assert.rejects(f.service.verificar(f.p, f.notaId), e => e.status === 403);
  assert.equal(envios, 0);
  assert.equal((await f.repo.notaPorId(f.notaId)).tentativas, 1);
  assert.equal((await f.repo.notaPorId(f.notaId)).processamentoToken, null);
});
test('remoção concorrente depois de validar A1 perde CAS do reenvio sem consumir tentativa', async (t) => {
  let envios = 0;
  const f = await fixture(t, {
    consultarDps: async () => ({ tipo: 'nao_encontrada' }),
    enviarDps: async () => { envios++; return { tipo: 'incerta' }; },
  });
  await abandonar(f, f.notaId, 'pendente');
  const transicionar = f.repo.transicionar;
  f.repo.transicionar = async (...args) => {
    // Representa outro processo removendo o A1 antes do UPDATE condicional.
    if (args[3]?.tentativas === 2) await f.repo.removerCertificado(f.p.id);
    return transicionar(...args);
  };
  const n = await f.service.verificar(f.p, f.notaId);
  assert.equal(envios, 0);
  assert.equal(n.situacao, 'pendente');
  assert.equal(n.tentativas, 1);
  assert.equal(n.idDps, 'DPSORIGINAL');
  assert.equal((await f.repo.notaPorId(f.notaId)).processamentoToken, null);
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
    const conta = await auth.cadastrar(email, 'senha-segura', email);
    const id = await repo.salvarPrestador(conta.usuarioId, null, { tipoDocumento: 'CNPJ', documento: '11222333000181', nome: email, municipioIbge: '3550308', opSimpNac: '2', ambiente: 'producao_restrita' });
    await repo.salvarCertificado(id, { ...cert, info: lerCertificado(cert.pfx, cert.senha) });
    const p = await repo.prestador(id);
    const notaId = await repo.criarNota(id, rascunho);
    await repo.transicionar(notaId, 'rascunho', 'pendente', { ambiente: p.ambiente, contextoEmitente: p, idDps: email, dpsXml: '<original/>', tentativas: 1, ultimoEnvioEm: '2026-01-01T00:00:00.000Z' });
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
  assert.ok(await repo.certificadoAtivo(perfis[1].p.id));
});
