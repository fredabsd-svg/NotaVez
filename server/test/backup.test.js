// Backup e restauração: os 9 cenários exigidos, com dados representativos criados pelos fluxos reais do app
// (emissão na Receita simulada, notas tomadas e canceladas pela sincronização, certificados, assistente).
// A comparação "antes × depois" usa uma fotografia independente do código de backup (test/apoio/fotografia.js).
process.env.NODE_ENV = 'test';
// Chave mestra fixa neste processo: o teste de queda real usa um segundo processo no mesmo banco.
process.env.NOTAVEZ_MASTER_KEY ||= (await import('node:crypto')).randomBytes(32).toString('base64');
process.env.NOTAVEZ_ESPERA_REENVIO_MS = '0';
process.env.NOTAVEZ_TIMEOUT_SEFIN_MS = '1500';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gerarCertificadoTeste } from './apoio/certificado-teste.js';
import { iniciarSefinSimulada } from './apoio/sefin-simulada.js';

const { fotografia, conferirIndices, hash } = await import('./apoio/fotografia.js');
const { criarApp } = await import('../src/app.js');
const { criarClienteSefin } = await import('../src/fiscal/sefin/cliente.js');
const { ambientesSefin } = await import('../src/config.js');
const { cifrar, indiceCego } = await import('../src/security/cripto.js');
const { novoId } = await import('../src/db/banco.js');
const formato = await import('../src/backup/formato.js');
const { conferirCobertura, validarConteudo, hashLinhas } = await import('../src/backup/dados.js');

const CNPJ = '11222333000181';
const OUTRO = '11444777000161';
const SENHA = 'senha-do-backup-2026';
const CHAVE_IA = 'sk-ant-segredo-muito-secreto-9876';
const SENHA_EMAIL = 'senha-do-email-de-envio-42';
const cert = gerarCertificadoTeste({ cnpj: CNPJ, nome: 'ESTUDIO WEB LTDA' });
const sha = (t) => createHash('sha256').update(t).digest('hex');
const PARTE = 1_900_000;

let sefin; let app;
const sondas = {};
const respostaIa = { texto: 'Olá! Sou o assistente.', chamadas: [], fim: 'fim', nativo: null, modeloUsado: 'modelo-teste' };
before(async () => {
  sefin = await iniciarSefinSimulada({ caPem: cert.caPem, caChavePem: cert.caChavePem, certClientePem: cert.certPem });
  Object.assign(ambientesSefin.producao_restrita, { sefin: sefin.baseUrl, parametros: sefin.baseParametros, adn: sefin.baseAdn });
  app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, pausaEntreEmpresasMs: 0, intervaloSincronizacaoMs: 0,
    fabricaCliente: (o) => criarClienteSefin({ ...o, ca: sefin.ca, timeoutMs: 1500 }), chamarIa: async () => respostaIa, sondasBackup: sondas });
});
after(async () => { await app.close(); await sefin.fechar(); });

let ips = 0;
function sessao() {
  const remoteAddress = `203.0.113.${++ips}`;
  let cookie = '';
  const api = async (method, url, payload, headers = {}) => {
    if (method === 'POST' && url.endsWith('/emitir') && payload === undefined) {
      const v = await api('POST', url.replace(/emitir$/, 'validar'), undefined, headers);
      payload = { versao: v.body.versao, revisao: v.body.revisao };
    }
    const r = await app.inject({ method, url, payload, remoteAddress, headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}), ...headers } });
    if (r.headers['set-cookie']) cookie = [r.headers['set-cookie']].flat().map((c) => c.split(';')[0]).join('; ');
    let body; try { body = r.json(); } catch { body = r.body; }
    return { status: r.statusCode, body };
  };
  api.semCsrf = async (method, url, payload) => (await app.inject({ method, url, payload, remoteAddress, headers: { cookie } })).statusCode;
  api.cookie = () => cookie;
  return api;
}
const usuarioId = async (email) => (await app.ctx.db.get('SELECT id FROM usuarios WHERE email = ?', email)).id;
const foto = async (email) => fotografia(app.ctx.db, await usuarioId(email));

// Conta representativa: 2 empresas (MEI com certificado A1 e Simples por procuração), clientes, serviços,
// nota emitida na Receita (com DPS e NFS-e), rascunho, nota emitida fora do app, tomadas (uma cancelada),
// posição de leitura do ADN, certificado do escritório, assistente configurado com conversa e auditoria.
async function contaRepresentativa(email) {
  sefin.estado.distribuicao.length = 0;
  const api = sessao();
  assert.equal((await api('POST', '/api/conta/cadastrar', { email, senha: 'senha-segura-1' })).status, 200);
  const e1 = (await api('POST', '/api/empresas', { documento: CNPJ, nome: 'Estúdio Web', municipioIbge: '3550308', opSimpNac: '2', email: 'fiscal@estudio.test', fone: '11999990000' })).body.empresaId;
  const h1 = { 'x-notavez-prestador': e1 };
  assert.equal((await api('POST', '/api/certificado', { pfxBase64: cert.pfx.toString('base64'), senha: cert.senha, consentimento: true }, h1)).status, 200);
  const cli = (await api('POST', '/api/clientes', { documento: '529.982.247-25', nome: 'Maria da Silva', email: 'maria@exemplo.com' }, h1)).body.cliente;
  const cliPj = await api('POST', '/api/clientes', { documento: '11.444.777/0001-61', nome: 'Cliente Empresa Ltda',
    endereco: { cep: '01001000', municipioIbge: '3550308', logradouro: 'Praça da Sé', numero: '100', bairro: 'Sé' } }, h1);
  assert.equal(cliPj.status, 200, JSON.stringify(cliPj.body));
  const serv = (await api('POST', '/api/servicos', { apelido: 'Site', cTribNac: '010101', descricao: 'Criação e manutenção de site', valorPadrao: '350,00' }, h1)).body.servico;
  const nota = (await api('POST', '/api/notas', { rascunho: { clienteId: cli.id, servicoId: serv.id, valor: '350.00' } }, h1)).body.nota;
  const emitida = await api('POST', `/api/notas/${nota.id}/emitir`, undefined, h1);
  assert.equal(emitida.body.nota?.situacao || emitida.body.situacao, 'emitida', JSON.stringify(emitida.body).slice(0, 300));
  assert.equal((await api('POST', '/api/notas', { rascunho: { clienteId: cli.id, servicoId: serv.id, descricao: 'Rascunho guardado' } }, h1)).status, 200);
  // Receita: duas tomadas (uma depois cancelada) e uma emitida fora do app.
  const t1 = sefin.adicionarTomada({ tomador: CNPJ, valor: '120.00', nome: 'FORNECEDOR A' });
  sefin.adicionarTomada({ tomador: CNPJ, valor: '80.00', nome: 'FORNECEDOR B', issRetido: true });
  sefin.adicionarTomada({ prestador: CNPJ, tomador: OUTRO, valor: '999.00', serie: '1', numero: 900 });
  sefin.cancelarTomada(t1.chave);
  const sinc = await api('POST', '/api/tomadas/sincronizar', {}, h1);
  assert.equal(sinc.status, 200, JSON.stringify(sinc.body));
  // Escritório: certificado do procurador e uma segunda empresa por procuração.
  assert.equal((await api('POST', '/api/procurador/certificado', { pfxBase64: cert.pfx.toString('base64'), senha: cert.senha, consentimento: true })).status, 200);
  const e2 = (await api('POST', '/api/empresas', { documento: OUTRO, nome: 'Consultoria Simples', municipioIbge: '3304557', opSimpNac: '3', regApTribSN: '1', pTotTribSN: '6.00', usaProcuracao: true })).body.empresaId;
  const h2 = { 'x-notavez-prestador': e2 };
  const cli2 = await api('POST', '/api/clientes', { documento: '529.982.247-25', nome: 'Maria (outra empresa)' }, h2);
  assert.equal(cli2.status, 200, JSON.stringify(cli2.body));
  const serv2 = await api('POST', '/api/servicos', { apelido: 'Consultoria', cTribNac: '170101', descricao: 'Consultoria contábil' }, h2);
  assert.equal(serv2.status, 200, JSON.stringify(serv2.body));
  // Assistente: configuração com chave e uma conversa.
  assert.equal((await api('PUT', '/api/ia/config', { provedor: 'anthropic', modelo: 'claude-opus-5-5', chave: CHAVE_IA })).status, 200);
  const conv = (await api('POST', '/api/ia/conversas', {})).body.conversa;
  assert.equal((await api('POST', `/api/ia/conversas/${conv.id}/mensagens`, { texto: 'Quanto faturei este mês?' })).status, 200);
  // E-mail das notas: configuração de envio (com senha) e um envio registrado na nota emitida.
  const cfgEmail = await api('PUT', '/api/email/config', { host: 'smtp.exemplo.test', porta: 465, seguranca: 'ssl', usuario: 'contato@estudio.test',
    senha: SENHA_EMAIL, remetenteEmail: 'contato@estudio.test', remetenteNome: 'Estúdio Web', copiaParaMim: true });
  assert.equal(cfgEmail.status, 200, JSON.stringify(cfgEmail.body));
  await app.ctx.repo.registrarEnvioEmail(e1, nota.id, { para: ['maria@exemplo.com'], cco: ['contato@estudio.test'], assunto: 'Nota fiscal nº 1 - 11/2026', anexos: ['pdf', 'xml'] });
  return { api, e1, e2, h1, h2, notaId: nota.id };
}

async function criarBackup(api, senha = SENHA) {
  const r = await api('POST', '/api/backup', { senha });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.backup;
}
// Baixa como o app: parte por parte, junta e confere o SHA-256 antes de "salvar".
async function baixar(api, b) {
  let texto = '';
  for (let i = 0; i < b.partes; i++) {
    const r = await app.inject({ method: 'GET', url: `/api/backup/${b.id}/partes/${i}`, headers: { cookie: api.cookie() } });
    assert.equal(r.statusCode, 200);
    texto += r.body;
  }
  assert.equal(sha(texto), b.sha256, 'o arquivo montado no aparelho confere com o SHA-256 do servidor');
  assert.equal((await api('POST', `/api/backup/${b.id}/baixado`, { sha256: sha(texto) })).status, 200);
  return texto;
}
// Envia como o app: partes de ~1,9 MB.
async function enviar(api, texto, { declararSha = sha(texto), nome = 'backup.nsbackup' } = {}) {
  const partes = Math.max(1, Math.ceil(texto.length / PARTE));
  const ini = await api('POST', '/api/backup/envios', { nome, bytes: texto.length, sha256: declararSha, partes });
  assert.equal(ini.status, 200, JSON.stringify(ini.body));
  for (let i = 0; i < partes; i++) {
    const p = await api('PUT', `/api/backup/${ini.body.backup.id}/partes/${i}`, { dados: texto.slice(i * PARTE, (i + 1) * PARTE) });
    if (p.status !== 200) return { id: ini.body.backup.id, recusa: p };
  }
  return { id: ini.body.backup.id };
}
// Reabre um backup, aplica uma alteração no conteúdo e cifra de novo (para simular versões e adulterações).
async function regravar(texto, alterar, { senha = SENHA, recalcularManifesto = true } = {}) {
  const { cabecalho, conteudo } = await formato.abrirArquivo(texto, senha);
  const c = JSON.parse(conteudo);
  alterar(c);
  if (recalcularManifesto) for (const [n, linhas] of Object.entries(c.tabelas)) c.manifesto[n] = { linhas: linhas.length, sha256: hashLinhas(linhas) };
  return (await formato.criarArquivo(JSON.stringify(c), senha, { criadoEm: cabecalho.criadoEm, app: cabecalho.app, esquema: c.esquema })).texto;
}

// ------------------------------------------------------------------------------------------------ 0. estrutura
test('formato do arquivo: ida e volta, cabeçalho autenticado e limites contra arquivos maliciosos', async () => {
  const a = await formato.criarArquivo('{"ola":"mundo"}', SENHA, { criadoEm: '2026-11-15T10:00:00Z', app: '0.1.0', esquema: 1 });
  assert.equal((await formato.abrirArquivo(a.texto, SENHA)).conteudo, '{"ola":"mundo"}');
  await assert.rejects(formato.abrirArquivo(a.texto, 'outra-senha-qualquer'), (e) => e.extra.codigo === 'BACKUP_SENHA_INCORRETA');
  await assert.rejects(formato.criarArquivo('{}', 'curta', { criadoEm: 'x', app: 'x', esquema: 1 }), (e) => e.extra.codigo === 'BACKUP_SENHA_CURTA');
  // Parâmetro de custo absurdo no cabeçalho (ataque de negação de serviço) é recusado antes de derivar a chave.
  const obj = JSON.parse(a.texto);
  obj.kdf.N = 2 ** 24;
  assert.throws(() => formato.lerCabecalho(JSON.stringify(obj)), (e) => e.extra.codigo === 'BACKUP_CORROMPIDO');
  assert.equal(formato.canonico({ b: 1, a: [2, { d: 3, c: null }] }), '{"a":[2,{"c":null,"d":3}],"b":1}');
});

test('o backup cobre todas as colunas das tabelas da conta (coluna nova sem regra faria o backup recusar)', async () => {
  assert.deepEqual(await conferirCobertura(app.ctx.db), []);
});

// ------------------------------------------------------------------------------------------------ 1, 2, 3
test('1-3) backup de dados representativos, restauração completa num servidor isolado (outra chave) e comparação', async () => {
  const { api, e1 } = await contaRepresentativa('origem@exemplo.test');
  const antes = await foto('origem@exemplo.test');
  assert.ok(antes.notas.length >= 3 && antes.notas_tomadas.length === 2 && antes.certificados.length === 1 && antes.certificados_procurador.length === 1
    && antes.ia_conversas.length === 1 && antes.ia_config.length === 1 && antes.distribuicao_dfe.length >= 1 && antes.clientes.length === 3
    && antes.email_config.length === 1 && antes.notas_emails.length === 1, 'dados representativos');
  const b = await criarBackup(api);
  assert.equal(b.situacao, 'guardado');
  assert.ok(b.verificadoEm, 'só responde depois de verificar');
  assert.match(b.nomeArquivo, /^nota-sem-stress_backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.nsbackup$/);
  const texto = await baixar(api, b);
  assert.deepEqual(await foto('origem@exemplo.test'), antes, 'gerar o backup não altera nenhum dado');

  // Servidor isolado: outro processo, outro banco e outra chave mestra; conta nova; envio em partes pela API.
  const pasta = mkdtempSync(join(tmpdir(), 'nss-backup-'));
  try {
    writeFileSync(join(pasta, 'b.nsbackup'), texto);
    const saida = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'test/apoio/restaurar-isolado.mjs', join(pasta, 'b.nsbackup'), SENHA], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, DATABASE_URL: '' } }); // banco próprio, sempre
    const r = JSON.parse(saida);
    assert.equal(r.ok, true, saida.slice(0, 500));
    assert.equal(r.conferido.mesmaConta, false);
    // 3) Comparação: tabela por tabela, campo por campo (decifrado), igual ao original.
    for (const t of Object.keys(antes)) assert.deepEqual(r.fotografia[t], antes[t], `tabela ${t} idêntica depois da restauração`);
    assert.equal(r.hashFotografia, hash(antes));
    assert.deepEqual(r.indices, [], 'índices de busca recalculados com a chave do novo servidor');
    assert.equal(r.ia.configurado, true);
    assert.equal(r.ia.chaveFinal, `••••${CHAVE_IA.slice(-4)}`);
    assert.equal(r.email.configurado, true);
    assert.equal(r.email.temSenha, true, 'a senha do e-mail de envio volta (cifrada com a chave do novo servidor)');
    assert.equal(r.email.host, 'smtp.exemplo.test');
    const est = r.funcionamento['11.222.333/0001-81'];
    assert.ok(est.notas >= 3 && est.tomadas === 2 && est.clientes === 2 && est.buscaCliente === 1 && est.danfse === true && est.certificado === true, JSON.stringify(est));
    assert.equal(est.clienteRepetido, 409, 'cadastro repetido barrado: índice do documento funciona');
    const xmlOriginal = await app.inject({ method: 'GET', url: `/api/notas/${antes.ordem_das_notas[0]}/xml`, headers: { cookie: api.cookie(), 'x-notavez-prestador': e1 } });
    assert.equal(est.xmlSha, sha(xmlOriginal.body), 'XML oficial da NFS-e idêntico');
    assert.ok(r.funcionamento['11.444.777/0001-61'].certificado, 'empresa por procuração com o certificado do escritório');
  } finally { rmSync(pasta, { recursive: true, force: true }); }
});

test('2) restauração no mesmo servidor depois de perder dados: tudo volta e o app continua emitindo', async () => {
  const { api, e1, h1, notaId } = await contaRepresentativa('perda@exemplo.test');
  const antes = await foto('perda@exemplo.test');
  const b = await criarBackup(api);
  const maiorDps = Number((await app.ctx.db.get('SELECT max(CAST(n_dps AS INTEGER)) AS n FROM notas WHERE prestador_id = ?', e1)).n);
  // Simula o desastre: cliente apagado, nota alterada, empresa excluída.
  const u = await usuarioId('perda@exemplo.test');
  await app.ctx.db.run('DELETE FROM clientes WHERE prestador_id = ?', e1);
  await app.ctx.db.run("UPDATE notas SET valor = '0.01' WHERE id = ?", notaId);
  await app.ctx.db.run("DELETE FROM prestadores WHERE usuario_id = ? AND id <> ?", u, e1);
  assert.notDeepEqual(await foto('perda@exemplo.test'), antes);

  const conf = await api('POST', `/api/backup/${b.id}/conferir`, { senha: SENHA });
  assert.equal(conf.status, 200);
  assert.equal(conf.body.mesmaConta, true);
  assert.equal(conf.body.podeRestaurar, true);
  assert.equal(conf.body.conteudo.empresas.length, 2);
  const r = await api('POST', `/api/backup/${b.id}/restaurar`, { senha: SENHA, confirmacao: 'RESTAURAR' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.seguranca.tipo, 'seguranca');
  assert.deepEqual(await foto('perda@exemplo.test'), antes, 'estado idêntico ao do backup');
  assert.deepEqual(await conferirIndices(app.ctx.db, u), []);
  // O app continua funcionando: nova nota emitida, com número de DPS que nunca volta atrás.
  const lista = (await api('GET', '/api/clientes', undefined, h1)).body.clientes;
  const serv = (await api('GET', '/api/servicos', undefined, h1)).body.servicos[0];
  const nova = (await api('POST', '/api/notas', { rascunho: { clienteId: lista[0].id, servicoId: serv.id, valor: '10.00' } }, h1)).body.nota;
  const emitida = await api('POST', `/api/notas/${nova.id}/emitir`, undefined, h1);
  assert.equal(emitida.body.nota?.situacao || emitida.body.situacao, 'emitida');
  const nDps = Number((await app.ctx.db.get('SELECT n_dps FROM notas WHERE id = ?', nova.id)).n_dps);
  assert.ok(nDps > maiorDps, `DPS nova (${nDps}) depois da última usada (${maiorDps})`);
  // A auditoria registra as operações, sem apagar o histórico anterior.
  const acoes = (await app.ctx.db.all('SELECT acao FROM auditoria WHERE usuario_id = ?', u)).map((a) => a.acao);
  for (const a of ['backup.criado', 'backup.restaurado', 'emissao.emitida', 'empresa.criada', 'tomadas.sincronizadas']) assert.ok(acoes.includes(a), a);
});

// ------------------------------------------------------------------------------------------------ 4 e 7
test('4/7) arquivo corrompido, adulterado, incompleto, de senha errada ou que não é backup: recusado e nada muda', async () => {
  const { api } = await contaRepresentativa('corrompido@exemplo.test');
  const b = await criarBackup(api);
  const texto = await baixar(api, b);
  const antes = await foto('corrompido@exemplo.test');
  const espera = async (txt, codigo, opcoes = {}, senha = SENHA) => {
    const e = await enviar(api, txt, opcoes);
    if (e.recusa) { assert.equal(e.recusa.body.codigo, codigo, JSON.stringify(e.recusa.body)); return; }
    const c = await api('POST', `/api/backup/${e.id}/conferir`, { senha });
    assert.equal(c.body.codigo, codigo, JSON.stringify(c.body).slice(0, 300));
    const r = await api('POST', `/api/backup/${e.id}/restaurar`, { senha, confirmacao: 'RESTAURAR' });
    assert.notEqual(r.status, 200);
  };
  const obj = JSON.parse(texto);
  const meio = Math.floor(obj.dados.length / 2);
  // Um caractere trocado no conteúdo cifrado.
  await espera(JSON.stringify({ ...obj, dados: `${obj.dados.slice(0, meio)}${obj.dados[meio] === 'A' ? 'B' : 'A'}${obj.dados.slice(meio + 1)}` }), 'BACKUP_CORROMPIDO');
  // Cabeçalho adulterado (data trocada): a tag do GCM autentica o cabeçalho.
  await espera(JSON.stringify({ ...obj, criadoEm: '2020-01-01T00:00:00.000Z' }), 'BACKUP_CORROMPIDO');
  // Arquivo cortado pela metade (download interrompido).
  await espera(texto.slice(0, Math.floor(texto.length / 2)), 'BACKUP_CORROMPIDO');
  // Senha errada.
  await espera(texto, 'BACKUP_SENHA_INCORRETA', {}, 'senha-errada-123456');
  // Não é um backup.
  await espera('{"qualquer":"json"}', 'BACKUP_DESCONHECIDO');
  // Chegou diferente do que o aparelho declarou (falha de transmissão).
  await espera(texto, 'BACKUP_CORROMPIDO', { declararSha: sha(`${texto}x`) });
  // Conteúdo alterado DENTRO do arquivo, mas cifrado de novo com a senha certa: o manifesto não confere.
  await espera(await regravar(texto, (c) => { c.tabelas.servicos[0].descricao = 'ALTERADO'; }, { recalcularManifesto: false }), 'BACKUP_INVALIDO');
  // Referência quebrada (nota de uma empresa que não está no backup), mesmo com manifesto recalculado.
  await espera(await regravar(texto, (c) => { c.tabelas.notas[0].prestador_id = 'empresa-inexistente'; }), 'BACKUP_INVALIDO');
  // Envio incompleto (faltou uma parte).
  const grande = `${texto.slice(0, -1)}${' '.repeat(PARTE)}}`;
  const ini = await api('POST', '/api/backup/envios', { nome: 'x.nsbackup', bytes: grande.length, sha256: sha(grande), partes: Math.ceil(grande.length / PARTE) });
  await api('PUT', `/api/backup/${ini.body.backup.id}/partes/0`, { dados: grande.slice(0, PARTE) });
  const incompleto = await api('POST', `/api/backup/${ini.body.backup.id}/conferir`, { senha: SENHA });
  assert.equal(incompleto.body.codigo, 'BACKUP_INCOMPLETO');
  // Sem a confirmação explícita, nada acontece.
  assert.equal((await api('POST', `/api/backup/${b.id}/restaurar`, { senha: SENHA })).status, 422);
  // 7) Nenhuma tentativa mexeu nos dados atuais.
  assert.deepEqual(await foto('corrompido@exemplo.test'), antes);
  const backups = (await api('GET', '/api/backup')).body.backups;
  assert.equal(backups.filter((x) => x.tipo === 'seguranca').length, 0, 'nada chegou à fase de troca (nem o backup de segurança foi preciso)');
});

// ------------------------------------------------------------------------------------------------ 5 e 7
test('5/7) interrupção no meio da restauração (falha simulada) e divergência na conferência: tudo desfeito', async () => {
  const { api, e1 } = await contaRepresentativa('interrompida@exemplo.test');
  const b = await criarBackup(api);
  // Depois do backup, o estado atual muda (é este estado que precisa sobreviver às falhas).
  await api('POST', '/api/clientes', { documento: '390.533.447-05', nome: 'Cliente Novo Depois Do Backup' }, { 'x-notavez-prestador': e1 });
  const antes = await foto('interrompida@exemplo.test');
  try {
    // Queda no meio da inserção das notas (depois de já ter apagado e inserido empresas, clientes...).
    sondas.aposLote = (tabela) => { if (tabela === 'notas') throw new Error('queda simulada do servidor'); };
    const r = await api('POST', `/api/backup/${b.id}/restaurar`, { senha: SENHA, confirmacao: 'RESTAURAR' });
    assert.equal(r.status, 500);
    assert.equal(r.body.codigo, 'BACKUP_RESTAURACAO_FALHOU');
    assert.ok(r.body.seguranca?.id, 'o backup de segurança foi criado antes de mexer');
    assert.deepEqual(await foto('interrompida@exemplo.test'), antes, 'rollback: nem um registro a mais ou a menos');
    // Divergência detectada na conferência final (ex.: escrita concorrente/defeito): também desfaz.
    delete sondas.aposLote;
    sondas.antesDaVerificacao = async (db) => { await db.run("UPDATE servicos SET descricao = 'mexido' WHERE prestador_id = ?", e1); };
    const v = await api('POST', `/api/backup/${b.id}/restaurar`, { senha: SENHA, confirmacao: 'RESTAURAR' });
    assert.equal(v.body.codigo, 'BACKUP_VERIFICACAO');
    assert.deepEqual(await foto('interrompida@exemplo.test'), antes);
  } finally { delete sondas.aposLote; delete sondas.antesDaVerificacao; }
  // A trava foi liberada e o backup de segurança restaura o estado de antes da tentativa.
  const lista = (await api('GET', '/api/backup')).body;
  assert.equal(lista.emAndamento, null);
  const seguranca = lista.backups.find((x) => x.tipo === 'seguranca');
  const ok = await api('POST', `/api/backup/${b.id}/restaurar`, { senha: SENHA, confirmacao: 'RESTAURAR' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.notDeepEqual(await foto('interrompida@exemplo.test'), antes, 'agora sim, voltou ao backup');
  const volta = await api('POST', `/api/backup/${seguranca.id}/restaurar`, { senha: SENHA, confirmacao: 'RESTAURAR' });
  assert.equal(volta.status, 200, JSON.stringify(volta.body));
  assert.deepEqual(await foto('interrompida@exemplo.test'), antes, 'o backup de segurança devolve o estado anterior');
});

test('5) queda REAL do servidor no meio da restauração (processo morto com SIGKILL e transação aberta): o banco desfaz tudo',
  { skip: !process.env.DATABASE_URL && 'precisa de um PostgreSQL de verdade (DATABASE_URL): com o banco embutido não há outro processo para derrubar' }, async () => {
    const { api } = await contaRepresentativa('queda@exemplo.test');
    const b = await criarBackup(api);
    await api('POST', '/api/servicos', { apelido: 'Depois do backup', cTribNac: '010101', descricao: 'Criado depois do backup' }, { 'x-notavez-prestador': (await api('GET', '/api/empresas')).body.empresas[0].id });
    const antes = await foto('queda@exemplo.test');
    const filho = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'test/apoio/restauracao-interrompida.mjs', 'queda@exemplo.test', 'senha-segura-1', b.id, SENHA], { stdio: ['ignore', 'pipe', 'pipe'] });
    let saida = '';
    await new Promise((ok, falha) => {
      const limite = setTimeout(() => falha(new Error(`o servidor não chegou ao meio da restauração: ${saida}`)), 60_000);
      filho.stdout.on('data', (d) => { saida += d; if (saida.includes('NO_MEIO')) { clearTimeout(limite); ok(); } });
      filho.on('exit', () => { clearTimeout(limite); falha(new Error(`o servidor terminou antes: ${saida}`)); });
    });
    // Neste instante, dentro da transação, os dados da conta já foram apagados e parte do backup inserida.
    filho.removeAllListeners('exit');
    filho.kill('SIGKILL');
    await new Promise((ok) => { filho.on('exit', ok); });
    // O PostgreSQL desfaz a transação da conexão que caiu: aguarda e confere.
    let depois;
    for (let i = 0; i < 50; i++) {
      depois = await foto('queda@exemplo.test');
      if (hash(depois) === hash(antes)) break;
      await new Promise((ok) => { setTimeout(ok, 200); });
    }
    assert.deepEqual(depois, antes, 'depois da queda, a conta está exatamente como antes');
    // A trava da operação que caiu expira sozinha (15 min); aqui o prazo é antecipado para seguir o teste.
    const u = await usuarioId('queda@exemplo.test');
    assert.ok(await app.ctx.db.get('SELECT 1 AS x FROM backup_operacoes WHERE usuario_id = ?', u), 'a operação que caiu deixou a trava');
    assert.equal((await api('POST', `/api/backup/${b.id}/restaurar`, { senha: SENHA, confirmacao: 'RESTAURAR' })).body.codigo, 'BACKUP_EM_ANDAMENTO');
    await app.ctx.db.run('UPDATE backup_operacoes SET expira_em = 0 WHERE usuario_id = ?', u);
    const r = await api('POST', `/api/backup/${b.id}/restaurar`, { senha: SENHA, confirmacao: 'RESTAURAR' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

// ------------------------------------------------------------------------------------------------ 6
test('6) backup de versão anterior (sem tabelas e colunas que vieram depois) restaura com padrões; versão mais nova é recusada', async () => {
  const { api } = await contaRepresentativa('versoes@exemplo.test');
  const b = await criarBackup(api);
  const texto = await baixar(api, b);
  const antigo = await regravar(texto, (c) => {
    for (const t of ['ia_conversas', 'ia_config', 'certificados_procurador', 'email_config', 'notas_emails']) { delete c.tabelas[t]; delete c.manifesto[t]; }
    c.esquema = 1;
    for (const p of c.tabelas.prestadores) delete p.usa_procuracao;
    for (const n of c.tabelas.notas) { delete n.canal; delete n.importada_conferida; }
    for (const d of c.tabelas.distribuicao_dfe) { delete d.falha_em; delete d.falha_cifrada; }
    c.app = '0.0.9';
  });
  const e = await enviar(api, antigo, { nome: 'antigo.nsbackup' });
  const r = await api('POST', `/api/backup/${e.id}/restaurar`, { senha: SENHA, confirmacao: 'RESTAURAR' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const depois = await foto('versoes@exemplo.test');
  assert.equal(depois.ia_conversas.length, 0);
  assert.equal(depois.email_config.length, 0);
  assert.ok(depois.prestadores.every((p) => JSON.parse(p).usa_procuracao === 0), 'padrão aplicado');
  assert.ok(depois.notas.every((n) => JSON.parse(n).importada_conferida === 0));
  // Versão mais nova: recusada sem mexer em nada.
  const antes = await foto('versoes@exemplo.test');
  const novo = await enviar(api, await regravar(texto, (c) => { c.esquema = 99; }));
  assert.equal((await api('POST', `/api/backup/${novo.id}/conferir`, { senha: SENHA })).body.codigo, 'BACKUP_VERSAO_NOVA');
  const obj = JSON.parse(texto);
  const formatoNovo = await enviar(api, JSON.stringify({ ...obj, formato: 2 }));
  assert.equal(formatoNovo.recusa?.body.codigo, 'BACKUP_VERSAO_NOVA');
  assert.deepEqual(await foto('versoes@exemplo.test'), antes);
});

// ------------------------------------------------------------------------------------------------ 7 (outras contas)
test('7) restaurar o backup de A na conta B enquanto A existe: recusado, A e B intactas; contas não se misturam', async () => {
  const a = await contaRepresentativa('conta-a@exemplo.test');
  const bA = await criarBackup(a.api);
  const textoA = await baixar(a.api, bA);
  const fotoA = await foto('conta-a@exemplo.test');
  const contaB = sessao();
  await contaB('POST', '/api/conta/cadastrar', { email: 'conta-b@exemplo.test', senha: 'senha-segura-1' });
  await contaB('POST', '/api/empresas', { documento: '45997418000153', nome: 'Empresa da B', municipioIbge: '3550308', opSimpNac: '2' });
  const fotoB = await foto('conta-b@exemplo.test');
  const e = await enviar(contaB, textoA);
  const c = await contaB('POST', `/api/backup/${e.id}/conferir`, { senha: SENHA });
  assert.equal(c.body.podeRestaurar, false);
  assert.ok(c.body.conflitos.total > 0);
  const r = await contaB('POST', `/api/backup/${e.id}/restaurar`, { senha: SENHA, confirmacao: 'RESTAURAR' });
  assert.equal(r.body.codigo, 'BACKUP_CONFLITO');
  assert.deepEqual(await foto('conta-a@exemplo.test'), fotoA);
  assert.deepEqual(await foto('conta-b@exemplo.test'), fotoB);
});

// ------------------------------------------------------------------------------------------------ 8
test('8) grande volume: 4.000 notas e 4.000 tomadas com XML, arquivo em várias partes, sem perda nem duplicação', { timeout: 600_000 }, async () => {
  const api = sessao();
  await api('POST', '/api/conta/cadastrar', { email: 'volume@exemplo.test', senha: 'senha-segura-1' });
  const u = await usuarioId('volume@exemplo.test');
  const db = app.ctx.db;
  const empresas = [];
  for (const [doc, nome] of [['45997418000153', 'Volume A'], ['19131243000197', 'Volume B']]) {
    empresas.push((await api('POST', '/api/empresas', { documento: doc, nome, municipioIbge: '3550308', opSimpNac: '2' })).body.empresaId);
  }
  const t0 = Date.now();
  const xml = () => `<NFSe><infNFSe><xDesc>${randomBytes(600).toString('base64')}</xDesc></infNFSe></NFSe>`;
  const agora = new Date().toISOString();
  for (const [k, pid] of empresas.entries()) {
    for (let lote = 0; lote < 2000; lote += 200) {
      const notas = []; const tomadas = []; const clientes = [];
      for (let i = lote; i < lote + 200; i++) {
        const chave = `${k}${String(i).padStart(49, '0')}`;
        notas.push([novoId(), pid, 'emitida', cifrar({ descricao: `Nota ${i}`, valor: '10.00' }), '10.00', '2026-10-01', 'producao_restrita', cifrar(chave), indiceCego(chave), String(i), cifrar(xml()), agora, agora, 'sincronizada']);
        tomadas.push([novoId(), pid, 'producao_restrita', i + 1, cifrar(`T${chave}`), indiceCego(`T${chave}`), cifrar({ emitente: { nome: `F${i}` } }), '2026-10-01', '20.00', cifrar(xml()), agora]);
        if (i < lote + 50) { const d = String(10000000000 + k * 100000 + i); clientes.push([novoId(), pid, cifrar({ tipo: 'CPF', documento: d, nome: `Cliente ${i}` }), indiceCego(d), agora, agora]); }
      }
      await db.run(`INSERT INTO notas (id, prestador_id, situacao, rascunho_cifrado, valor, competencia, ambiente, chave_cifrada, chave_indice, n_nfse, nfse_xml_cifrado, criado_em, atualizado_em, canal) VALUES ${notas.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`, ...notas.flat());
      await db.run(`INSERT INTO notas_tomadas (id, prestador_id, ambiente, nsu, chave_cifrada, chave_indice, resumo_cifrado, competencia, valor, xml_cifrado, baixada_em) VALUES ${tomadas.map(() => '(?,?,?,?,?,?,?,?,?,?,?)').join(',')}`, ...tomadas.flat());
      await db.run(`INSERT INTO clientes (id, prestador_id, dados_cifrados, documento_indice, criado_em, atualizado_em) VALUES ${clientes.map(() => '(?,?,?,?,?,?)').join(',')}`, ...clientes.flat());
    }
  }
  const antes = await fotografia(db, u);
  assert.equal(antes.notas.length, 4000);
  assert.equal(antes.notas_tomadas.length, 4000);
  const t1 = Date.now();
  const b = await criarBackup(api);
  const t2 = Date.now();
  assert.ok(b.partes >= 2, `arquivo em ${b.partes} partes (${(b.bytes / 1024 / 1024).toFixed(1)} MB)`);
  const texto = await baixar(api, b);
  // Perde tudo e restaura a partir do arquivo enviado em partes.
  await db.run('DELETE FROM prestadores WHERE usuario_id = ?', u);
  const e = await enviar(api, texto, { nome: 'grande.nsbackup' });
  const t3 = Date.now();
  const r = await api('POST', `/api/backup/${e.id}/restaurar`, { senha: SENHA, confirmacao: 'RESTAURAR' });
  const t4 = Date.now();
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  const depois = await fotografia(db, u);
  assert.deepEqual(depois, antes, 'mesmos registros, sem perda nem duplicação');
  assert.equal(new Set(depois.notas).size, 4000);
  console.log(`  volume: ${antes.notas.length} notas + ${antes.notas_tomadas.length} tomadas + ${antes.clientes.length} clientes; arquivo ${(b.bytes / 1024 / 1024).toFixed(1)} MB em ${b.partes} partes; `
    + `carga ${((t1 - t0) / 1000).toFixed(1)} s, backup ${((t2 - t1) / 1000).toFixed(1)} s, restauração (com backup de segurança) ${((t4 - t3) / 1000).toFixed(1)} s`);
});

// ------------------------------------------------------------------------------------------------ 9
test('9) permissões e sigilo: só o dono vê e usa; nada sensível em claro no arquivo, no banco ou na auditoria', async () => {
  const { api } = await contaRepresentativa('dono@exemplo.test');
  const b = await criarBackup(api);
  const texto = await baixar(api, b);
  const intruso = sessao();
  await intruso('POST', '/api/conta/cadastrar', { email: 'intruso@exemplo.test', senha: 'senha-segura-1' });
  assert.equal((await intruso('GET', '/api/backup')).body.backups.length, 0);
  assert.equal((await app.inject({ method: 'GET', url: `/api/backup/${b.id}/partes/0`, headers: { cookie: intruso.cookie() } })).statusCode, 404);
  for (const [m, url, corpo] of [['POST', `/api/backup/${b.id}/conferir`, { senha: SENHA }], ['POST', `/api/backup/${b.id}/restaurar`, { senha: SENHA, confirmacao: 'RESTAURAR' }],
    ['POST', `/api/backup/${b.id}/baixado`, { sha256: b.sha256 }], ['DELETE', `/api/backup/${b.id}`], ['PUT', `/api/backup/${b.id}/partes/0`, { dados: 'x' }]]) {
    assert.equal((await intruso(m, url, corpo)).status, 404, `${m} ${url}`);
  }
  // Sem sessão: 401. Sem o cabeçalho anti-CSRF: 403.
  assert.equal((await app.inject({ method: 'GET', url: '/api/backup' })).statusCode, 401);
  assert.equal(await api.semCsrf('POST', '/api/backup', { senha: SENHA }), 403);
  // Senha fraca não gera backup.
  assert.equal((await api('POST', '/api/backup', { senha: 'curta' })).body.codigo, 'BACKUP_SENHA_CURTA');
  // Nada sensível em claro no arquivo baixado.
  for (const segredo of [cert.senha, CHAVE_IA, SENHA_EMAIL, 'contato@estudio.test', 'maria@exemplo.com', 'Maria da Silva', '52998224725', CNPJ, '<NFSe', 'fiscal@estudio.test', SENHA]) {
    assert.ok(!texto.includes(segredo), `o arquivo não contém "${segredo}" em claro`);
  }
  // Nem no banco (partes guardadas cifradas também com a chave do servidor) nem na auditoria: a senha nunca é guardada.
  const guardado = JSON.stringify(await app.ctx.db.all('SELECT * FROM backups')) + JSON.stringify(await app.ctx.db.all('SELECT * FROM backup_partes'))
    + JSON.stringify(await app.ctx.db.all("SELECT * FROM auditoria WHERE acao LIKE 'backup.%'"));
  assert.ok(!guardado.includes(SENHA), 'a senha do backup não aparece no banco');
  assert.ok(!guardado.includes(texto.slice(0, 200)), 'as partes no banco não são o arquivo em claro');
  // Duas operações ao mesmo tempo na mesma conta: uma espera a outra (sem misturar dados).
  const [x, y] = await Promise.all([api('POST', '/api/backup', { senha: SENHA }), api('POST', '/api/backup', { senha: SENHA })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal([x, y].find((z) => z.status === 409).body.codigo, 'BACKUP_EM_ANDAMENTO');
});

test('retenção: guarda o arquivo dos 5 backups manuais mais recentes; os anteriores ficam só no histórico', async () => {
  const api = sessao();
  await api('POST', '/api/conta/cadastrar', { email: 'retencao@exemplo.test', senha: 'senha-segura-1' });
  for (let i = 0; i < 7; i++) await criarBackup(api);
  const lista = (await api('GET', '/api/backup')).body;
  assert.equal(lista.backups.length, 7);
  assert.equal(lista.backups.filter((b) => b.disponivel).length, 5);
  assert.equal(lista.backups.at(-1).situacao, 'removido');
  assert.ok(lista.ultimo, 'último backup verificado aparece na tela');
  const removido = lista.backups.at(-1);
  assert.equal((await app.inject({ method: 'GET', url: `/api/backup/${removido.id}/partes/0`, headers: { cookie: api.cookie() } })).statusCode, 410);
});

test('validação direta: conteúdo bem formado passa; tabela desconhecida e campo cifrado ilegível são recusados', () => {
  const vazio = { esquema: 1, tabelas: { prestadores: [] }, manifesto: { prestadores: { linhas: 0, sha256: hashLinhas([]) } } };
  assert.equal(validarConteudo(vazio).tabelas.prestadores.length, 0);
  assert.throws(() => validarConteudo({ ...vazio, tabelas: { ...vazio.tabelas, invasora: [] } }), /tabela desconhecida/);
  const linhaRuim = [{ id: 'x', prestador_id: 'p', dados_cifrados: 'não é json', criado_em: 'a', atualizado_em: 'b' }];
  const p = [{ id: 'p', serie_dps: '1', versao: 1, ambiente: 'producao_restrita', criado_em: 'a', atualizado_em: 'b', usa_procuracao: 0 }];
  assert.throws(() => validarConteudo({ esquema: 1, tabelas: { prestadores: p, clientes: linhaRuim },
    manifesto: { prestadores: { linhas: 1, sha256: hashLinhas(p) }, clientes: { linhas: 1, sha256: hashLinhas(linhaRuim) } } }), /não é um JSON válido/);
});
