process.env.NODE_ENV = 'test';
process.env.NOTAVEZ_ESPERA_REENVIO_MS = '0';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gerarCertificadoTeste } from './apoio/certificado-teste.js';
const { abrirCentral } = await import('../src/db/banco.js');
const { criarContas } = await import('../src/db/contas.js');
const { novaChaveConta, cifrar, indiceCego } = await import('../src/security/cripto.js');
const { randomUUID } = await import('node:crypto');
const { criarServicoEmissao } = await import('../src/fiscal/emissao.js');
const { lerCertificado } = await import('../src/fiscal/certificado.js');
const { ambientesSefin } = await import('../src/config.js');
const cert = gerarCertificadoTeste();
const rascunho = { competencia: '2026-09-01', cTribNac: '010101', descricao: 'Serviço de teste', valor: '150.00', tomador: { tipo: 'NENHUM' } };
function fixture(t, cliente = {}) {
  const central = abrirCentral(':memory:');
  const u = randomUUID();
  central.run('INSERT INTO usuarios (id, email, senha_hash, chave_conta, criado_em) VALUES (?,?,?,?,?)', u, 'teste@example.test', 'irrelevante', novaChaveConta(u), '2026-01-01');
  const contas = criarContas({ central, pasta: null });
  t.after(() => { contas.fechar(); central.fechar(); });
  const { db, repo } = contas.abrir(u);
  const p = { tipoDocumento: 'CNPJ', documento: '11222333000181', nome: 'Teste', municipioIbge: '3550308', opSimpNac: '2', ambiente: 'producao_restrita' };
  const id = repo.salvarPrestador(u, p);
  repo.salvarCertificado(id, { ...cert, info: lerCertificado(cert.pfx, cert.senha) });
  const chamadas = [];
  const service = criarServicoEmissao({ repo, fabricaCliente: (o) => {
    chamadas.push({ operacao: 'cliente', baseUrl: o.baseUrl, certPem: o.certPem });
    return { enviarDps: async (xml) => { chamadas.push({ operacao: 'envio', xml }); return { tipo: 'incerta' }; },
      consultarDps: async (id) => { chamadas.push({ operacao: 'consulta', id }); return { tipo: 'incerta' }; },
      consultarNfse: async () => ({ tipo: 'incerta' }), ...cliente };
  } });
  t.after(() => service.fecharClientes());
  return { db, repo, service, u, central, p: repo.prestador(id), perfil: p, chamadas, notaId: repo.criarNota(id, rascunho) };
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
  f.repo.salvarPrestador(f.u, { ...f.perfil, ambiente: 'producao' });
  const renovado = gerarCertificadoTeste({ nome: 'RENOVADO' });
  f.repo.salvarCertificado(f.p.id, { ...renovado, info: lerCertificado(renovado.pfx, renovado.senha) });
  await f.service.verificar(f.repo.prestador(f.p.id), f.notaId);
  assert.equal(f.chamadas[0].baseUrl, ambientesSefin.producao_restrita.sefin);
  assert.equal(f.chamadas[0].certPem, renovado.certPem);
  assert.equal(enviado, '<original/>');
  assert.equal(f.repo.notaPorId(f.notaId).ambiente, 'producao_restrita');
  assert.throws(() => f.repo.salvarPrestador(f.u, { ...f.perfil, documento: '11444777000161' }), /pendentes/);
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
  f.repo.salvarPrestador(f.u, { ...f.perfil, nome: 'Outra revisão' });
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
test('migração do banco único: cada usuário ganha banco e chave próprios, sem perder notas incertas', async (t) => {
  const pasta = mkdtempSync(join(tmpdir(), 'notavez-migracao-'));
  t.after(() => rmSync(pasta, { recursive: true, force: true }));
  const arquivo = join(pasta, 'notavez.db');
  // Banco no formato antigo (um só arquivo, chave do servidor), sem as colunas mais novas.
  const antigo = new DatabaseSync(arquivo);
  antigo.exec(readFileSync(new URL('./apoio/schema-banco-unico.sql', import.meta.url), 'utf8')
    .replace('  versao INTEGER NOT NULL DEFAULT 1,\n', '')
    .replace(/^  (contexto_emitente_cifrado|processamento_token|processamento_ate|proxima_verificacao_em|verificacoes).*\n/gm, '')
    .replace('ON notas(ambiente, id_dps_indice)', 'ON notas(id_dps_indice)'));
  const [u1, u2] = [randomUUID(), randomUUID()];
  const run = (sql, ...p) => antigo.prepare(sql).run(...p);
  const agora = '2026-01-01T00:00:00.000Z';
  for (const [u, email, cnpj, nome] of [[u1, 'um@example.test', '11444777000161', 'Legado Um'], [u2, 'dois@example.test', '11222333000181', 'Legado Dois']]) {
    run('INSERT INTO usuarios VALUES (?,?,?,?)', u, email, 'hash', agora);
    run(`INSERT INTO prestadores (id, usuario_id, documento_cifrado, documento_indice, tipo_documento, nome, municipio_ibge, op_simp_nac, contato_cifrado, criado_em, atualizado_em)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, `p-${u}`, u, cifrar(cnpj), indiceCego(cnpj), 'CNPJ', nome, '3304557', '2', cifrar({ email: null, fone: null }), agora, agora);
    run('INSERT INTO clientes (id, prestador_id, dados_cifrados, documento_indice, criado_em, atualizado_em) VALUES (?,?,?,?,?,?)', `c-${u}`, `p-${u}`, cifrar({ tipo: 'CPF', documento: '52998224725', nome: `Cliente de ${nome}` }), indiceCego('52998224725'), agora, agora);
    run('INSERT INTO servicos (id, prestador_id, apelido, c_trib_nac, descricao, criado_em, atualizado_em) VALUES (?,?,?,?,?,?,?)', `s-${u}`, `p-${u}`, 'Site', '010101', 'Criação de site', agora, agora);
    run('INSERT INTO certificados (id, prestador_id, pfx_cifrado, senha_cifrada, titular, documento_cifrado, emissor, valido_de, valido_ate, criado_em) VALUES (?,?,?,?,?,?,?,?,?,?)',
      `k-${u}`, `p-${u}`, cifrar(cert.pfx), cifrar(cert.senha), 'TITULAR', cifrar(cnpj), 'AC', agora, '2099-01-01T00:00:00.000Z', agora);
  }
  // Nota do usuário 1 com envio incerto: a identidade vem da DPS gravada.
  run(`INSERT INTO notas (id, prestador_id, situacao, rascunho_cifrado, valor, competencia, ambiente, serie, n_dps, id_dps_cifrado, id_dps_indice, dps_xml_cifrado, tentativas, criado_em, atualizado_em)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'n-1', `p-${u1}`, 'enviando', cifrar(rascunho), '150.00', '2026-09-01', 'producao_restrita', '1', '7',
  cifrar('DPSLEGADA'), indiceCego('DPSLEGADA'), cifrar('<DPS><infDPS><tpAmb>2</tpAmb><cLocEmi>3550308</cLocEmi><prest><CNPJ>11222333000181</CNPJ></prest></infDPS></DPS>'), 1, agora, agora);
  run('INSERT INTO chamadas_api (nota_id, operacao, resultado, criado_em) VALUES (?,?,?,?)', 'n-1', 'envio', 'incerta', agora);
  run('INSERT INTO auditoria (usuario_id, prestador_id, acao, ip, criado_em) VALUES (?,?,?,?,?)', u1, `p-${u1}`, 'rascunho.criado', '203.0.113.9', agora);
  run('INSERT INTO sessoes (token_hash, usuario_id, criado_em, expira_em) VALUES (?,?,?,?)', 'sessao-antiga', u1, agora, '2099-01-01T00:00:00.000Z');
  antigo.close();

  const central = abrirCentral(arquivo);
  const contas = criarContas({ central, pasta: join(pasta, 'contas') });
  t.after(() => { contas.fechar(); central.fechar(); });
  contas.preparar();
  // O catálogo central não guarda mais dados das contas; login e sessões continuam.
  for (const tabela of ['prestadores', 'notas', 'clientes', 'servicos', 'certificados', 'chamadas_api']) {
    assert.equal(central.get("SELECT count(*) n FROM sqlite_master WHERE type = 'table' AND name = ?", tabela).n, 0, tabela);
  }
  assert.equal(central.get('SELECT count(*) n FROM sessoes').n, 1);
  assert.equal(central.get('SELECT count(*) n FROM auditoria').n, 0, 'auditoria das contas foi para o banco de cada conta');
  assert.ok(central.get('SELECT chave_conta FROM usuarios WHERE id = ?', u1).chave_conta.startsWith('k1.'));
  assert.deepEqual(contas.catalogo.contasPendentes(), [u1], 'nota incerta continua na verificação periódica');

  const um = contas.abrir(u1);
  const dois = contas.abrir(u2);
  const nota = um.repo.notaPorId('n-1');
  assert.equal(nota.valor, '150.00');
  assert.equal(nota.idDps, 'DPSLEGADA');
  assert.equal(nota.contextoEmitente.documento, '11222333000181', 'identidade vem da DPS, não do perfil atual');
  assert.equal(um.repo.prestador(`p-${u1}`).nome, 'Legado Um');
  assert.equal(um.repo.cliente(`p-${u1}`, `c-${u1}`).nome, 'Cliente de Legado Um');
  assert.equal(um.repo.clientePorDocumento(`p-${u1}`, '52998224725').id, `c-${u1}`, 'índice cego recalculado com a chave da conta');
  assert.equal(um.repo.servico(`p-${u1}`, `s-${u1}`).descricao, 'Criação de site');
  assert.deepEqual(um.repo.materialCertificado(um.repo.certificadoAtivo(`p-${u1}`)).pfx, cert.pfx, 'PFX binário preservado');
  assert.equal(um.repo.chamadas('n-1').length, 1);
  assert.equal(um.db.cripto.decifrar(um.db.get('SELECT ip FROM auditoria').ip), '203.0.113.9');
  // Separação: cada banco só tem a própria conta.
  assert.equal(dois.repo.notaPorId('n-1') ?? null, null);
  assert.equal(dois.repo.prestador(`p-${u1}`) ?? null, null);
  assert.equal(dois.repo.prestador(`p-${u2}`).nome, 'Legado Dois');
  assert.equal(um.db.get('SELECT count(*) n FROM prestadores').n, 1);
  // Unicidade do Id da DPS agora é por ambiente.
  const prod = um.repo.criarNota(`p-${u1}`, rascunho);
  assert.ok(um.repo.transicionar(prod, 'rascunho', 'enviando', { ambiente: 'producao', idDps: 'DPSLEGADA' }));
  const duplicada = um.repo.criarNota(`p-${u1}`, rascunho);
  assert.throws(() => um.repo.transicionar(duplicada, 'rascunho', 'enviando', { ambiente: 'producao', idDps: 'DPSLEGADA' }), /UNIQUE/);
  // Reabrir não migra de novo nem perde nada.
  contas.fechar(); central.fechar();
  const central2 = abrirCentral(arquivo);
  const contas2 = criarContas({ central: central2, pasta: join(pasta, 'contas') });
  contas2.preparar();
  assert.equal(contas2.abrir(u1).db.get('SELECT count(*) n FROM notas').n, 3);
  contas2.fechar(); central2.fechar();
});

test('certificado renovado ou perfil modificado durante preparação impede claim de dados antigos', async (t) => {
  for (const alterar of ['perfil', 'certificado']) {
    const f = fixture(t);
    const original = f.repo.proximoNumeroDps;
    f.repo.proximoNumeroDps = (...args) => {
      if (alterar === 'perfil') f.repo.salvarPrestador(f.u, { ...f.perfil, nome: 'Perfil mudou' });
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
  const { auth } = app.ctx;
  const perfis = [];
  for (const email of ['a@teste.invalid', 'b@teste.invalid']) {
    const conta = auth.cadastrar(email, 'senha-segura', email);
    // Cada conta: banco, chave e serviço de emissão próprios.
    const { repo, emissao } = app.ctx.contas.abrir(conta.usuarioId);
    const id = repo.salvarPrestador(conta.usuarioId, { tipoDocumento: 'CNPJ', documento: '11222333000181', nome: email, municipioIbge: '3550308', opSimpNac: '2', ambiente: 'producao_restrita' });
    repo.salvarCertificado(id, { ...cert, info: lerCertificado(cert.pfx, cert.senha) });
    const p = repo.prestador(id);
    const notaId = repo.criarNota(id, rascunho);
    repo.transicionar(notaId, 'rascunho', 'pendente', { ambiente: p.ambiente, contextoEmitente: p, idDps: email, dpsXml: '<original/>', tentativas: 1, ultimoEnvioEm: '2026-01-01T00:00:00.000Z' });
    await emissao.verificar(p, notaId);
    perfis.push({ p, notaId, token: conta.token, repo, emissao });
  }
  const headers = { cookie: `nv_sessao=${perfis[0].token}`, 'x-notavez': '1' };
  const renovacao = await app.inject({ method: 'POST', url: '/api/certificado', headers,
    payload: { consentimento: true, pfxBase64: cert.pfx.toString('base64'), senha: cert.senha } });
  assert.equal(renovacao.statusCode, 200);
  assert.deepEqual(clientes.map(c => c.fechado), [true, false]);
  await perfis[0].emissao.verificar(perfis[0].p, perfis[0].notaId);
  assert.deepEqual(clientes.map(c => c.fechado), [true, false, false]);
  const remocao = await app.inject({ method: 'DELETE', url: '/api/certificado', headers });
  assert.equal(remocao.statusCode, 200);
  assert.deepEqual(clientes.map(c => c.fechado), [true, false, true]);
  assert.ok(perfis[1].repo.certificadoAtivo(perfis[1].p.id));
});
