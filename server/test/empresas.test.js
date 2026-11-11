// Várias empresas por conta, consulta de CNPJ e notas tomadas (ADN simulado).
process.env.NODE_ENV = 'test';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gerarCertificadoTeste } from './apoio/certificado-teste.js';
import { iniciarSefinSimulada } from './apoio/sefin-simulada.js';

const { criarApp } = await import('../src/app.js');
const { criarClienteSefin } = await import('../src/fiscal/sefin/cliente.js');
const { ambientesSefin } = await import('../src/config.js');
const { criarConsultaCnpj, enquadramento } = await import('../src/cadastro/consulta-cnpj.js');

const CNPJ_A = '11222333000181';
const CNPJ_B = '11444777000161';
const cert = gerarCertificadoTeste({ cnpj: CNPJ_A });
const consultas = [];
// Base pública simulada: A é MEI, B é Lucro Presumido; o resto não existe.
const basePublica = async (url) => {
  consultas.push(url);
  const cnpj = url.split('/').pop();
  if (cnpj === CNPJ_A) {
    return Response.json({ razao_social: 'MARIA SILVA SERVICOS', nome_fantasia: 'MARIA', descricao_situacao_cadastral: 'ATIVA', codigo_municipio_ibge: 3550308, municipio: 'SAO PAULO', uf: 'SP',
      cep: '01001-000', descricao_tipo_de_logradouro: 'RUA', logradouro: 'DAS FLORES', numero: '10', bairro: 'CENTRO', ddd_telefone_1: '1133334444', email: 'MARIA@EXEMPLO.COM',
      opcao_pelo_simples: true, opcao_pelo_mei: true, porte: 'MICRO EMPRESA', cnae_fiscal: 6201501, cnae_fiscal_descricao: 'Desenvolvimento de programas' });
  }
  if (cnpj === CNPJ_B) {
    return Response.json({ razao_social: 'CONSULTORIA B LTDA', descricao_situacao_cadastral: 'ATIVA', codigo_municipio_ibge: 3304557, municipio: 'RIO DE JANEIRO', uf: 'RJ',
      opcao_pelo_simples: false, opcao_pelo_mei: false, porte: 'DEMAIS', regime_tributario: [{ ano: 2023, forma_de_tributacao: 'LUCRO REAL' }, { ano: 2024, forma_de_tributacao: 'LUCRO PRESUMIDO' }] });
  }
  return new Response('{}', { status: 404 });
};

let sefin; let app;
before(async () => {
  sefin = await iniciarSefinSimulada({ caPem: cert.caPem, caChavePem: cert.caChavePem, certClientePem: cert.certPem });
  Object.assign(ambientesSefin.producao_restrita, { sefin: sefin.baseUrl, parametros: sefin.baseParametros, adn: sefin.baseAdn });
  app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, fabricaCliente: (o) => criarClienteSefin({ ...o, ca: sefin.ca }),
    consultarCnpj: criarConsultaCnpj({ buscar: basePublica }) });
});
after(async () => { await app.close(); await sefin.fechar(); });

let ip = 0;
function sessao() {
  const remoteAddress = `192.0.2.${++ip}`;
  let cookie = '';
  return async (method, url, payload, headers = {}) => {
    const r = await app.inject({ method, url, payload, remoteAddress, headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}), ...headers } });
    const sc = r.headers['set-cookie'];
    if (sc) cookie = (Array.isArray(sc) ? sc : [sc]).map((c) => c.split(';')[0]).join('; ');
    return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body, headers: r.headers };
  };
}
const perfil = (documento, extra = {}) => ({ documento, nome: `Empresa ${documento}`, municipioIbge: '3550308', opSimpNac: '2', ...extra });

test('enquadramento: MEI, Simples, Presumido/Real pela última ECF e base sem informação', () => {
  assert.equal(enquadramento({ mei: { optante: true }, simples: { optante: true } }).opSimpNac, '2');
  assert.equal(enquadramento({ mei: { optante: false }, simples: { optante: true } }).opSimpNac, '3');
  const real = enquadramento({ simples: { optante: false }, regimes: [{ ano: 2024, forma: 'LUCRO REAL' }, { ano: 2022, forma: 'LUCRO PRESUMIDO' }] });
  assert.deepEqual([real.opSimpNac, real.apuracao], ['1', 'real']);
  assert.equal(enquadramento({ simples: { optante: null }, mei: { optante: null } }).opSimpNac, null, 'sem dado não supõe regime');
});

test('consulta de CNPJ preenche dados e enquadramento; valida, usa cache e trata ausência', async () => {
  const api = sessao();
  await api('POST', '/api/conta/cadastrar', { email: 'cnpj@teste.invalid', senha: 'senha-segura' });
  const r = await api('GET', '/api/cnpj/11.222.333%2F0001-81');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = r.body.cnpj;
  assert.equal(c.razaoSocial, 'MARIA SILVA SERVICOS');
  assert.equal(c.municipio.nome, 'São Paulo');
  assert.deepEqual(c.endereco, { cep: '01001000', municipioIbge: '3550308', logradouro: 'RUA DAS FLORES', numero: '10', complemento: '', bairro: 'CENTRO' });
  assert.equal(c.email, 'maria@exemplo.com');
  assert.equal(c.enquadramento.opSimpNac, '2');
  assert.equal(c.porte, 'ME');
  const antes = consultas.length;
  await api('GET', `/api/cnpj/${CNPJ_A}`);
  assert.equal(consultas.length, antes, 'segunda consulta vem do cache');
  const b = (await api('GET', `/api/cnpj/${CNPJ_B}`)).body.cnpj;
  assert.deepEqual([b.enquadramento.opSimpNac, b.enquadramento.apuracao], ['1', 'presumido']);
  assert.equal((await api('GET', '/api/cnpj/11222333000100')).status, 422);
  assert.equal((await api('GET', '/api/cnpj/19131243000197')).status, 404);
  assert.equal((await sessao()('GET', `/api/cnpj/${CNPJ_A}`)).status, 401, 'exige conta');
});

test('várias empresas: lista, seleção por cabeçalho conferida contra o dono, CNPJ único e remoção protegida', async () => {
  const api = sessao();
  await api('POST', '/api/conta/cadastrar', { email: 'escritorio@teste.invalid', senha: 'senha-segura' });
  assert.equal((await api('GET', '/api/conta')).body.empresas, 0);
  const a = await api('POST', '/api/empresas', perfil(CNPJ_A));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  // Uma só empresa: a conta já entra nela.
  const conta1 = (await api('GET', '/api/conta')).body;
  assert.equal(conta1.prestadorId, a.body.empresaId);
  const b = await api('POST', '/api/empresas', perfil(CNPJ_B, { opSimpNac: '1', apuracao: 'presumido', cstPisCofins: '01', aliqPis: '0,65', aliqCofins: '3', pTotTribFed: '13,45', pTotTribMun: '5' }));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const dup = await api('POST', '/api/empresas', perfil('11.444.777/0001-61'));
  assert.equal(dup.status, 409);
  assert.ok(dup.body.campos.documento);

  // Duas empresas e nenhuma pedida: o app mostra a lista.
  const conta2 = (await api('GET', '/api/conta')).body;
  assert.equal(conta2.prestadorId, null);
  assert.equal(conta2.empresas, 2);
  assert.equal((await api('GET', `/api/conta?empresa=${b.body.empresaId}`)).body.prestadorId, b.body.empresaId);
  const lista = (await api('GET', '/api/empresas')).body.empresas;
  assert.deepEqual(lista.map((e) => e.regime).sort(), ['Lucro Presumido', 'MEI']);
  assert.ok(lista.every((e) => e.documentoFormatado.includes('/')));

  // Dados de cada empresa ficam no ambiente dela.
  const comA = { 'x-notavez-prestador': a.body.empresaId };
  const comB = { 'x-notavez-prestador': b.body.empresaId };
  await api('POST', '/api/clientes', { documento: '529.982.247-25', nome: 'Cliente da A' }, comA);
  assert.equal((await api('GET', '/api/clientes', undefined, comA)).body.clientes.length, 1);
  assert.equal((await api('GET', '/api/clientes', undefined, comB)).body.clientes.length, 0);
  assert.equal((await api('GET', '/api/perfil', undefined, comB)).body.perfil.documento, CNPJ_B);
  assert.equal((await api('GET', `/api/perfil?empresa=${b.body.empresaId}`)).body.perfil.documento, CNPJ_B, 'links de download usam ?empresa=');
  const nota = await api('POST', '/api/notas', { rascunho: { valor: '10' } }, comB);
  assert.equal((await api('GET', `/api/notas/${nota.body.nota.id}`, undefined, comA)).status, 404);
  // Editar o perfil altera só a empresa ativa.
  assert.equal((await api('PUT', '/api/perfil', perfil(CNPJ_A, { nome: 'A renomeada' }), comA)).status, 200);
  assert.equal((await api('GET', '/api/perfil', undefined, comB)).body.perfil.nome, `Empresa ${CNPJ_B}`);
  // Sem empresa escolhida, o que depende dela pede a escolha.
  const semEmpresa = await api('GET', '/api/clientes', undefined, { 'x-notavez-prestador': '' });
  assert.equal(semEmpresa.status, 409);
  assert.equal(semEmpresa.body.acao, 'empresas');

  // Empresa de outra conta nunca é selecionável.
  const outra = sessao();
  await outra('POST', '/api/conta/cadastrar', { email: 'outra@teste.invalid', senha: 'senha-segura' });
  const alheia = await outra('GET', '/api/clientes', undefined, comA);
  assert.equal(alheia.status, 409);
  assert.equal(alheia.body.codigo, 'EMPRESA_INDISPONIVEL');
  assert.equal((await outra('GET', `/api/conta?empresa=${a.body.empresaId}`)).body.prestadorId, null);
  assert.equal((await outra('DELETE', `/api/empresas/${a.body.empresaId}`)).status, 404);

  // Remoção: só sem notas enviadas; rascunhos vão junto.
  app.ctx.db.run("UPDATE notas SET situacao = 'emitida' WHERE id = ?", nota.body.nota.id);
  assert.equal((await api('DELETE', `/api/empresas/${b.body.empresaId}`)).status, 409);
  app.ctx.db.run("UPDATE notas SET situacao = 'rascunho' WHERE id = ?", nota.body.nota.id);
  assert.equal((await api('DELETE', `/api/empresas/${b.body.empresaId}`)).status, 200);
  assert.equal(app.ctx.db.get('SELECT count(*) n FROM notas WHERE id = ?', nota.body.nota.id).n, 0);
  assert.equal((await api('GET', '/api/clientes', undefined, comB)).body.codigo, 'EMPRESA_INDISPONIVEL');
  assert.equal((await api('GET', '/api/empresas')).body.empresas.length, 1);
});

test('notas tomadas: baixa do ADN por NSU, só as da empresa como tomadora, cancelamento, filtros e documentos', async () => {
  const api = sessao();
  await api('POST', '/api/conta/cadastrar', { email: 'tomadas@teste.invalid', senha: 'senha-segura' });
  const { empresaId } = (await api('POST', '/api/empresas', perfil(CNPJ_A))).body;
  const h = { 'x-notavez-prestador': empresaId };
  const semCert = await api('POST', '/api/tomadas/sincronizar', {}, h);
  assert.equal(semCert.status, 409);
  assert.equal(semCert.body.acao, 'certificado');
  assert.equal((await api('POST', '/api/certificado', { pfxBase64: cert.pfx.toString('base64'), senha: cert.senha, consentimento: true }, h)).status, 200);

  const t1 = sefin.adicionarTomada({ tomador: CNPJ_A, nome: 'FORNECEDOR UM', valor: '450.00', competencia: '2026-09-10' });
  sefin.adicionarTomada({ tomador: CNPJ_B, nome: 'NOTA DE OUTRA EMPRESA', valor: '999.00' });
  const t3 = sefin.adicionarTomada({ tomador: CNPJ_A, nome: 'FORNECEDOR DOIS', valor: '1200.00', competencia: '2026-08-05', issRetido: true });
  sefin.cancelarTomada(t3.chave);
  for (let i = 0; i < 55; i++) sefin.adicionarTomada({ tomador: CNPJ_B, nome: `LOTE ${i}` });
  const t4 = sefin.adicionarTomada({ tomador: CNPJ_A, nome: 'DEPOIS DO PRIMEIRO LOTE', valor: '10.00', competencia: '2026-09-20' });

  const s = await api('POST', '/api/tomadas/sincronizar', {}, h);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.novas, 3);
  assert.equal(s.body.canceladas, 1);
  assert.equal(s.body.ultimoNsu, sefin.estado.distribuicao.length);
  assert.ok(sefin.estado.consultasDistribuicao.length >= 2, 'percorre mais de um lote');
  assert.equal(sefin.estado.consultasDistribuicao[0].cnpjConsulta, CNPJ_A);

  const lista = (await api('GET', '/api/tomadas', undefined, h)).body;
  assert.deepEqual(lista.tomadas.map((t) => t.emitente.nome).sort(), ['DEPOIS DO PRIMEIRO LOTE', 'FORNECEDOR DOIS', 'FORNECEDOR UM']);
  assert.equal(lista.tomadas.find((t) => t.chaveAcesso === t3.chave).situacao, 'cancelada');
  assert.equal(lista.tomadas.find((t) => t.chaveAcesso === t3.chave).issRetido, true);
  assert.deepEqual(lista.totais, { quantidade: 2, valor: '460.00', valorLiquido: '460.00' }, 'cancelada fica fora dos totais');
  assert.equal((await api('GET', '/api/tomadas?competencia=2026-09', undefined, h)).body.tomadas.length, 2);
  assert.equal((await api('GET', '/api/tomadas?q=dois', undefined, h)).body.tomadas.length, 1);

  // Repetir a consulta logo em seguida é barrado (o ADN limita o consumo); depois, não duplica.
  assert.equal((await api('POST', '/api/tomadas/sincronizar', {}, h)).status, 429);

  const id = lista.tomadas.find((t) => t.chaveAcesso === t1.chave).id;
  const det = (await api('GET', `/api/tomadas/${id}`, undefined, h)).body.tomada;
  assert.equal(det.valor, '450.00');
  assert.equal(det.emitente.documentoFormatado, '11.444.777/0001-61');
  const xml = await api('GET', `/api/tomadas/${id}/xml`, undefined, h);
  assert.match(xml.body, /FORNECEDOR UM/);
  const pdf = await api('GET', `/api/tomadas/${id}/danfse?empresa=${empresaId}`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.ok(t4);
});

test('falha do ADN não apaga o progresso e é informada', async () => {
  const api = sessao();
  await api('POST', '/api/conta/cadastrar', { email: 'falha-adn@teste.invalid', senha: 'senha-segura' });
  const { empresaId } = (await api('POST', '/api/empresas', perfil(CNPJ_A))).body;
  const h = { 'x-notavez-prestador': empresaId };
  await api('POST', '/api/certificado', { pfxBase64: cert.pfx.toString('base64'), senha: cert.senha, consentimento: true }, h);
  sefin.estado.falharDistribuicao = true;
  try {
    const r = await api('POST', '/api/tomadas/sincronizar', {}, h);
    assert.equal(r.status, 502);
    assert.equal((await api('GET', '/api/tomadas', undefined, h)).body.sincronizacao.ultimoNsu, 0);
  } finally { sefin.estado.falharDistribuicao = false; }
});
