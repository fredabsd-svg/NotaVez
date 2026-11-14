// Cadastro de empresas em lote: leitura da lista (texto e planilha), conferências automáticas,
// revisão pela IA da conta e salvamento com os padrões fiscais de cada regime.
process.env.NODE_ENV = 'test';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';

const { criarApp } = await import('../src/app.js');
const { lerLista, prepararEmpresa, regimeDoTexto, corpoDoCadastro, AVISO_PADRAO } = await import('../src/cadastro/lote-empresas.js');
const { lerRevisoes } = await import('../src/ia/servico.js');
const { ErroApp } = await import('../src/util/erros.js');

// CNPJ válido a partir dos 12 primeiros caracteres (aceita o alfanumérico).
function cnpj(base) {
  const v = (ch) => ch.charCodeAt(0) - 48;
  const dv = (s, pesos) => { const r = [...s].reduce((t, ch, i) => t + v(ch) * pesos[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
  const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base}${d1}${dv(`${base}${d1}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])}`;
}
const fmt = (c) => c.replace(/^(\w{2})(\w{3})(\w{3})(\w{4})(\w{2})$/, '$1.$2.$3/$4-$5');
const SIMPLES = cnpj('112223330001');      // 11222333000181
const PRESUMIDO = cnpj('445556660001');
const BAIXADA = cnpj('778889990001');
const COMERCIO = cnpj('012345670001');      // começa com zero: a planilha costuma perder
const SEM_REGIME = cnpj('998887770001');
const ALFA = cnpj('12ABC3450001');
const MEI = cnpj('556667770001');

// Base pública simulada (mesmo formato de criarConsultaCnpj).
const enq = (opSimpNac, apuracao, descricao) => ({ opSimpNac, apuracao, descricao });
const BASE = {
  [SIMPLES]: { razaoSocial: 'ESTUDIO WEB LTDA', situacaoCadastral: 'ATIVA', ativa: true, naturezaJuridica: 'Sociedade Empresária Limitada', porte: 'ME',
    cnae: { codigo: '6201501', descricao: 'Desenvolvimento de programas de computador sob encomenda' }, endereco: { municipioIbge: '3550308' }, email: 'contato@estudio.test', fone: '1133334444',
    simples: { optante: true, desde: '2020-01-01' }, mei: { optante: false }, regimes: [], enquadramento: enq('3', null, 'ME/EPP optante do Simples Nacional'), fonte: 'teste' },
  [PRESUMIDO]: { razaoSocial: 'CONSULTORIA FISCAL SA', situacaoCadastral: 'ATIVA', ativa: true, naturezaJuridica: 'Sociedade Anônima Fechada', porte: 'DEMAIS',
    cnae: { codigo: '6920601', descricao: 'Atividades de contabilidade' }, endereco: { municipioIbge: '3304557' }, simples: { optante: false }, mei: { optante: false },
    regimes: [{ ano: 2025, forma: 'LUCRO PRESUMIDO' }], enquadramento: enq('1', 'presumido', 'Lucro Presumido (ECF 2025)'), fonte: 'teste' },
  [BAIXADA]: { razaoSocial: 'ANTIGA LTDA', situacaoCadastral: 'BAIXADA', ativa: false, cnae: { codigo: '7020400', descricao: 'Consultoria' }, endereco: { municipioIbge: '3550308' },
    simples: { optante: false }, mei: { optante: false }, regimes: [], enquadramento: enq('1', null, 'Não optante'), fonte: 'teste' },
  [COMERCIO]: { razaoSocial: 'LOJA DE PECAS LTDA', situacaoCadastral: 'ATIVA', ativa: true, cnae: { codigo: '4530703', descricao: 'Comércio a varejo de peças' }, endereco: { municipioIbge: '3550308' },
    simples: { optante: false }, mei: { optante: false }, regimes: [], enquadramento: enq('1', null, 'Não optante do Simples (confirme Presumido ou Real)'), fonte: 'teste' },
  [SEM_REGIME]: { razaoSocial: 'SEM REGIME LTDA', situacaoCadastral: 'ATIVA', ativa: true, cnae: { codigo: '7319002', descricao: 'Promoção de vendas' }, endereco: { municipioIbge: '3550308' },
    simples: { optante: null }, mei: { optante: null }, regimes: [], enquadramento: enq(null, null, 'Não informado pela base pública'), fonte: 'teste' },
  [ALFA]: { razaoSocial: 'NOVA ALFANUMERICA LTDA', situacaoCadastral: 'ATIVA', ativa: true, cnae: { codigo: '6311900', descricao: 'Tratamento de dados' }, endereco: { municipioIbge: '3550308' },
    simples: { optante: true }, mei: { optante: false }, regimes: [], enquadramento: enq('3', null, 'ME/EPP optante do Simples Nacional'), fonte: 'teste' },
  [MEI]: { razaoSocial: 'JOAO DA SILVA 52998224725', situacaoCadastral: 'ATIVA', ativa: true, naturezaJuridica: 'Empresário (Individual)', porte: 'ME',
    cnae: { codigo: '9602501', descricao: 'Cabeleireiros' }, endereco: { municipioIbge: '3550308' }, simples: { optante: true }, mei: { optante: true }, regimes: [],
    enquadramento: enq('2', null, 'MEI (Simples Nacional - SIMEI)'), fonte: 'teste' },
};
const consultas = [];
let foraDoAr = false;
async function consultarCnpj(c) {
  consultas.push(c);
  if (foraDoAr) throw new ErroApp(503, 'Base pública fora do ar.');
  const d = BASE[c];
  if (!d) throw new ErroApp(404, 'CNPJ não encontrado na base pública da Receita.');
  return { cnpj: c, nomeFantasia: null, abertura: '2020-01-01', ...d, municipio: { nome: d.endereco.municipioIbge === '3304557' ? 'Rio de Janeiro' : 'São Paulo', uf: d.endereco.municipioIbge === '3304557' ? 'RJ' : 'SP' } };
}

const pedidosIa = [];
let respostaIa = null;
const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, consultarCnpj,
  chamarIa: async (op) => { pedidosIa.push(op); return { texto: respostaIa(op), chamadas: [], fim: 'fim', nativo: null, modeloUsado: 'revisor-teste' }; } });
after(() => app.close());
let ipSeq = 0;
function sessao() {
  let cookie = '';
  const ip = `203.0.113.${++ipSeq}`;
  return async (method, url, payload) => {
    const r = await app.inject({ method, url, payload, remoteAddress: ip, headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}) } });
    if (r.headers['set-cookie']) cookie = [r.headers['set-cookie']].flat().map((c) => c.split(';')[0]).join('; ');
    let body; try { body = r.json(); } catch { body = r.body; }
    return { status: r.statusCode, body };
  };
}

test('regimeDoTexto entende como os escritórios escrevem o regime', () => {
  assert.equal(regimeDoTexto('Simples Nacional'), 'simples');
  assert.equal(regimeDoTexto('SN'), 'simples');
  assert.equal(regimeDoTexto('SIMEI'), 'mei');
  assert.equal(regimeDoTexto('MEI'), 'mei');
  assert.equal(regimeDoTexto('Lucro Presumido'), 'presumido');
  assert.equal(regimeDoTexto('LP'), 'presumido');
  assert.equal(regimeDoTexto('Lucro REAL'), 'real');
  assert.equal(regimeDoTexto('Imune'), null);
  assert.equal(regimeDoTexto(''), null);
});

test('lerLista: texto colado com pontuação, sem pontuação, sem o zero à esquerda, alfanumérico, inválido e repetido', async () => {
  const texto = [
    `${fmt(SIMPLES)} Simples`,
    `${PRESUMIDO}; Lucro Presumido`,
    COMERCIO.replace(/^0/, ''), // a planilha perdeu o zero
    `${fmt(ALFA).toLowerCase()}`,
    `${fmt(SIMPLES)}`, // repetido
    '11.222.333/0001-00', // dígito errado
    `${MEI}, ${SEM_REGIME}`,
  ].join('\n');
  const r = await lerLista({ texto });
  assert.deepEqual(r.linhas.map((l) => l.cnpj), [SIMPLES, PRESUMIDO, COMERCIO, ALFA, MEI, SEM_REGIME]);
  assert.equal(r.linhas[0].regimeDeclarado, 'simples');
  assert.equal(r.linhas[1].regimeDeclarado, 'presumido');
  assert.equal(r.linhas[4].regimeDeclarado, null, 'dois CNPJs na mesma linha: o texto não define o regime de nenhum');
  assert.equal(r.repetidos, 1);
  assert.deepEqual(r.invalidos, ['11.222.333/0001-00']);
  await assert.rejects(lerLista({ texto: 'nada aqui' }), /Nenhum CNPJ/);
});

test('lerLista: planilha Excel com cabeçalho (CNPJ, Razão social, Regime, Inscrição municipal, E-mail)', async () => {
  const sst = ['CNPJ', 'Razão Social', 'Regime', 'Inscrição Municipal', 'E-mail', 'Estúdio Web', 'Simples', 'Consultoria Fiscal', 'Lucro Real'];
  const c = (ref, i) => `<c r="${ref}" t="s"><v>${i}</v></c>`;
  const xlsx = zipSync({
    'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="Clientes" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8(`<sst>${sst.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>
      <row r="1">${c('A1', 0)}${c('B1', 1)}${c('C1', 2)}${c('D1', 3)}${c('E1', 4)}</row>
      <row r="2"><c r="A2"><v>${SIMPLES}</v></c>${c('B2', 5)}${c('C2', 6)}<c r="D2"><v>123456</v></c><c r="E2" t="inlineStr"><is><t>Fiscal@Estudio.test</t></is></c></row>
      <row r="3"><c r="A3" t="inlineStr"><is><t>${fmt(PRESUMIDO)}</t></is></c>${c('B3', 7)}${c('C3', 8)}</row>
    </sheetData></worksheet>`),
  });
  const r = await lerLista({ arquivo: { nome: 'empresas.xlsx', base64: Buffer.from(xlsx).toString('base64') } });
  assert.equal(r.origem, 'empresas.xlsx');
  assert.deepEqual(r.linhas.map((l) => [l.cnpj, l.regimeDeclarado, l.inscricaoMunicipal, l.email, l.nome]), [
    [SIMPLES, 'simples', '123456', 'fiscal@estudio.test', 'Estúdio Web'],
    [PRESUMIDO, 'real', null, null, 'Consultoria Fiscal'],
  ]);
  // CSV com ponto e vírgula também.
  const csv = `CNPJ;Regime\n${fmt(MEI)};MEI\n`;
  const r2 = await lerLista({ arquivo: { nome: 'lista.csv', base64: Buffer.from(csv).toString('base64') } });
  assert.deepEqual(r2.linhas.map((l) => [l.cnpj, l.regimeDeclarado]), [[MEI, 'mei']]);
});

test('prepararEmpresa: conferências automáticas, padrões do regime e o que exige revisão', async () => {
  const ctx = { consultarCnpj };
  const s = await prepararEmpresa(ctx, { cnpj: SIMPLES });
  assert.equal(s.situacao, 'pronta');
  assert.equal(s.regime, 'simples');
  assert.equal(s.perfil.municipioIbge, '3550308');
  assert.deepEqual(s.avisos, [], 'sem nada a conferir além dos parâmetros padrão (lembrete que a tela mostra pelo regime)');
  assert.match(AVISO_PADRAO.simples, /6,00%/);
  assert.equal((await prepararEmpresa(ctx, { cnpj: MEI })).regime, 'mei');

  const baixada = await prepararEmpresa(ctx, { cnpj: BAIXADA });
  assert.equal(baixada.situacao, 'bloqueada');
  assert.match(baixada.problemas[0], /BAIXADA/);

  const conflito = await prepararEmpresa(ctx, { cnpj: SIMPLES, regimeDeclarado: 'presumido' });
  assert.equal(conflito.situacao, 'revisar');
  assert.equal(conflito.regime, 'presumido', 'o regime da planilha é a escolha do usuário');
  assert.match(conflito.avisos[0], /planilha diz Lucro Presumido.*Simples/);

  const comercio = await prepararEmpresa(ctx, { cnpj: COMERCIO });
  assert.equal(comercio.regime, 'presumido');
  assert.match(comercio.avisos.join(' '), /marcada como Lucro Presumido/);
  assert.match(comercio.avisos.join(' '), /comércio/);
  // Planilha diz Real e a base só sabe que não é Simples: sem conflito.
  assert.equal((await prepararEmpresa(ctx, { cnpj: COMERCIO, regimeDeclarado: 'real' })).avisos.some((a) => /planilha diz/.test(a)), false);

  const semRegime = await prepararEmpresa(ctx, { cnpj: SEM_REGIME });
  assert.equal(semRegime.situacao, 'revisar');
  assert.equal(semRegime.regime, null);

  assert.equal((await prepararEmpresa(ctx, { cnpj: SIMPLES }, { existentes: new Set([SIMPLES]) })).situacao, 'ja_cadastrada');
  const naoAchou = await prepararEmpresa(ctx, { cnpj: cnpj('333333330001') });
  assert.equal(naoAchou.situacao, 'erro');
  assert.equal(naoAchou.temporario, false);
  foraDoAr = true;
  try { assert.equal((await prepararEmpresa(ctx, { cnpj: SIMPLES })).temporario, true); } finally { foraDoAr = false; }

  assert.deepEqual(corpoDoCadastro(s.perfil, 'real'), { documento: SIMPLES, nome: 'ESTUDIO WEB LTDA', municipioIbge: '3550308', inscricaoMunicipal: null, email: 'contato@estudio.test', fone: '1133334444',
    opSimpNac: '1', apuracao: 'real', cstPisCofins: '01', aliqPis: '1.65', aliqCofins: '7.60', pTotTribFed: '9.25', pTotTribEst: '0.00', pTotTribMun: '5.00' });
});

test('lerRevisoes: JSON puro ou em bloco de código; empresa que faltou fica para conferir', () => {
  const r = lerRevisoes('Segue:\n```json\n{"empresas":[{"cnpj":"11.222.333/0001-81","veredito":"aprovar","resumo":"ok","problemas":[],"regimeSugerido":null},{"cnpj":"X","veredito":"talvez"}]}\n```', [SIMPLES, PRESUMIDO]);
  assert.equal(r[0].veredito, 'aprovar');
  assert.equal(r[1].veredito, 'revisar');
  assert.equal(r[1].semResposta, true);
  const lixo = lerRevisoes('não sei', [SIMPLES]);
  assert.equal(lixo[0].veredito, 'revisar');
  assert.match(lixo[0].resumo, /formato esperado/);
  const sugestao = lerRevisoes(JSON.stringify({ empresas: [{ cnpj: SIMPLES, veredito: 'revisar', resumo: 'x', problemas: ['a', 1, ''], regimeSugerido: 'real' }] }), [SIMPLES]);
  assert.deepEqual(sugestao[0].problemas, ['a']);
  assert.equal(sugestao[0].regimeSugerido, 'real');
});

test('fluxo completo pela API: ler, consultar, revisar com a IA e salvar com o regime confirmado', async () => {
  const api = sessao();
  assert.equal((await api('POST', '/api/conta/cadastrar', { email: 'escritorio@exemplo.test', senha: 'senha-segura-1' })).status, 200);
  // Já tem uma empresa: ela aparece como "já cadastrada".
  assert.equal((await api('POST', '/api/empresas', { documento: MEI, nome: 'Já existe', municipioIbge: '3550308', opSimpNac: '2' })).status, 200);

  const lida = await api('POST', '/api/empresas/lote/ler', { texto: `${fmt(SIMPLES)} Simples\n${PRESUMIDO}\n${BAIXADA}\n${MEI}` });
  assert.equal(lida.status, 200);
  assert.deepEqual(lida.body.linhas.map((l) => l.jaCadastrada), [false, false, false, true]);
  assert.match(lida.body.avisosPadrao.presumido, /11,33%/);

  const preparadas = [];
  for (const l of lida.body.linhas) {
    const r = await api('POST', '/api/empresas/lote/consultar', l);
    assert.equal(r.status, 200);
    preparadas.push(r.body.empresa);
  }
  assert.deepEqual(preparadas.map((p) => p.situacao), ['pronta', 'pronta', 'bloqueada', 'ja_cadastrada']);

  // Sem IA configurada, a revisão pede a configuração.
  const semIa = await api('POST', '/api/ia/revisar-empresas', { empresas: preparadas.slice(0, 2) });
  assert.equal(semIa.status, 409);
  assert.equal(semIa.body.codigo, 'IA_NAO_CONFIGURADA');
  assert.equal((await api('PUT', '/api/ia/config', { provedor: 'anthropic', modelo: 'claude-opus-5-5', chave: 'sk-ant-segredo-1234abcd' })).status, 200);

  respostaIa = () => JSON.stringify({ empresas: [
    { cnpj: SIMPLES, veredito: 'aprovar', resumo: 'Simples ativo, software sob encomenda (Anexo III com Fator R).', problemas: [], regimeSugerido: null },
    { cnpj: PRESUMIDO, veredito: 'revisar', resumo: 'S.A. de contabilidade no Presumido: confira o ISS do Rio.', problemas: ['ISS do Rio de Janeiro para contabilidade é 5%? confirmar'], regimeSugerido: null },
  ] });
  const rev = await api('POST', '/api/ia/revisar-empresas', { empresas: preparadas.slice(0, 2) });
  assert.equal(rev.status, 200);
  assert.deepEqual(rev.body.revisoes.map((r) => r.veredito), ['aprovar', 'revisar']);
  assert.equal(rev.body.modelo, 'revisor-teste');
  // O que foi para a IA: dados como dados, sem ferramentas, com os parâmetros do regime escolhido.
  const pedido = pedidosIa.at(-1);
  assert.deepEqual(pedido.ferramentas, []);
  assert.match(pedido.sistemaFixo, /SOMENTE com um JSON/);
  const enviado = JSON.parse(/<cadastros>\n([\s\S]*)\n<\/cadastros>/.exec(pedido.historico[0].texto)[1]);
  assert.equal(enviado[0].regimeEscolhido, 'simples');
  assert.equal(enviado[0].parametrosFiscais.pTotTribSN, '6.00');
  assert.equal(enviado[1].basePublica.ecf[0].forma, 'LUCRO PRESUMIDO');
  assert.equal((await api('POST', '/api/ia/revisar-empresas', { empresas: Array(21).fill(preparadas[0]) })).status, 422, 'no máximo 20 por vez');

  // Salva: a segunda com o regime trocado para Real na tela; a bloqueada e a repetida não vão.
  const salvar = await api('POST', '/api/empresas/lote/salvar', { empresas: [
    { perfil: preparadas[0].perfil, regime: 'simples', veredito: 'aprovar' },
    { perfil: preparadas[1].perfil, regime: 'real', veredito: 'revisar' },
    { perfil: { ...preparadas[0].perfil }, regime: 'simples' },
    { perfil: { documento: MEI, nome: 'x', municipioIbge: '3550308' }, regime: 'mei' },
    { perfil: { documento: cnpj('202020200001'), nome: 'Sem município' }, regime: 'simples' },
    { perfil: preparadas[0].perfil, regime: 'inventado' },
  ] });
  assert.equal(salvar.status, 200);
  assert.equal(salvar.body.criadas, 2);
  assert.deepEqual(salvar.body.resultados.map((r) => r.ok), [true, true, false, false, false, false]);
  assert.match(salvar.body.resultados[2].erro, /Já está cadastrada/);
  assert.match(salvar.body.resultados[4].erro, /município/);

  const empresas = (await api('GET', '/api/empresas')).body.empresas;
  const est = empresas.find((e) => e.nome === 'ESTUDIO WEB LTDA');
  const cons = empresas.find((e) => e.nome === 'CONSULTORIA FISCAL SA');
  assert.equal(est.opSimpNac, '3');
  assert.equal(cons.opSimpNac, '1');
  assert.match(cons.regime, /Real/);
  const p = await app.ctx.repo.prestador(cons.id);
  assert.equal(p.apuracao, 'real');
  assert.equal(p.aliqCofins, '7.60');
  const auditoria = await app.ctx.db.get("SELECT detalhes FROM auditoria WHERE acao = 'empresa.criada' AND prestador_id = ?", cons.id);
  assert.match(String(auditoria.detalhes), /"emLote":true/);
  assert.match(String(auditoria.detalhes), /"revisaoIa":"revisar"/);

  // Procuração sem o certificado do escritório: recusa antes de salvar.
  assert.equal((await api('POST', '/api/empresas/lote/salvar', { usaProcuracao: true, empresas: [{ perfil: { ...preparadas[0].perfil, documento: ALFA }, regime: 'simples' }] })).status, 409);
});
