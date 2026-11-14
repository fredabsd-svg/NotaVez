// Assistente de IA: configuração, laço modelo ↔ ferramentas contra a Sefin SIMULADA,
// confirmação de emissão, modo autônomo e os dois dialetos de API (com fetch falso).
process.env.NODE_ENV = 'test';
process.env.NOTAVEZ_ESPERA_REENVIO_MS = '0';
process.env.NOTAVEZ_TIMEOUT_SEFIN_MS = '1500';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gerarCertificadoTeste } from './apoio/certificado-teste.js';
import { iniciarSefinSimulada } from './apoio/sefin-simulada.js';

const { criarApp } = await import('../src/app.js');
const { criarClienteSefin } = await import('../src/fiscal/sefin/cliente.js');
const { ambientesSefin } = await import('../src/config.js');
const { chamarModelo } = await import('../src/ia/adaptadores.js');
const { validarBaseUrl } = await import('../src/ia/provedores.js');
const { SISTEMA_FIXO } = await import('../src/ia/prompt.js');
const { DEFINICOES } = await import('../src/ia/ferramentas.js');
const { recortar } = await import('../src/ia/servico.js');
const { chamarModelo: _c, listarModelos } = await import('../src/ia/adaptadores.js');
const { extrairAnexo } = await import('../src/ia/anexos.js');
const { zipSync, strToU8 } = await import('fflate');
const { default: PDFDocument } = await import('pdfkit');

const cert = gerarCertificadoTeste({ cnpj: '11222333000181' });
let sefin; let app;
// O "modelo" de cada teste: uma função que recebe o pedido montado pelo servidor.
let modelo = null;
const listagens = [];
const pedidos = [];

before(async () => {
  sefin = await iniciarSefinSimulada({ caPem: cert.caPem, caChavePem: cert.caChavePem, certClientePem: cert.certPem });
  ambientesSefin.producao_restrita.sefin = sefin.baseUrl;
  ambientesSefin.producao_restrita.parametros = sefin.baseParametros;
  app = await criarApp({
    banco: ':memory:', logger: false, servirWeb: false, fabricaCliente: (o) => criarClienteSefin({ ...o, ca: sefin.ca }),
    chamarIa: async (op) => { pedidos.push(op); return modelo(op); },
    listarModelosIa: async (op) => { listagens.push(op); return [{ id: 'modelo-novo', nome: 'Modelo Novo' }, { id: 'modelo-antigo', nome: 'Modelo Antigo', obsoleto: true }]; },
  });
});
after(async () => { await app.close(); await sefin.fechar(); });

let contador = 0;
function sessao() {
  const remoteAddress = `198.51.100.${++contador}`;
  let cookie = '';
  return async (method, url, payload) => {
    const r = await app.inject({ method, url, payload, remoteAddress, headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}) } });
    const sc = r.headers['set-cookie'];
    if (sc) cookie = (Array.isArray(sc) ? sc : [sc]).map((c) => c.split(';')[0]).join('; ');
    return { status: r.statusCode, body: r.headers['content-type']?.includes('json') ? r.json() : r.body };
  };
}

async function contaPronta(email) {
  const api = sessao();
  assert.equal((await api('POST', '/api/conta/cadastrar', { email, senha: 'senha-segura-1' })).status, 200);
  assert.equal((await api('PUT', '/api/perfil', { documento: '11.222.333/0001-81', nome: 'Empresa Teste', municipioIbge: '3550308', opSimpNac: '2' })).status, 200);
  assert.equal((await api('POST', '/api/certificado', { pfxBase64: cert.pfx.toString('base64'), senha: cert.senha, consentimento: true })).status, 200);
  assert.equal((await api('POST', '/api/clientes', { documento: '529.982.247-25', nome: 'Maria da Silva', email: 'maria@exemplo.com' })).status, 200);
  assert.equal((await api('POST', '/api/servicos', { apelido: 'Site', cTribNac: '010101', descricao: 'Criação e manutenção de site', valorPadrao: '350,00' })).status, 200);
  return api;
}

// Resultado (já parseado) da última rodada de ferramentas.
const ultimos = (op) => {
  const r = [...op.historico].reverse().find((m) => m.papel === 'ferramentas');
  return r ? r.resultados.map((x) => ({ nome: x.nome, erro: x.erro, dados: JSON.parse(x.conteudo) })) : [];
};
const pede = (...chamadas) => ({ texto: '', chamadas: chamadas.map(([nome, args], i) => ({ id: `t${Date.now()}_${i}`, nome, args })), fim: 'ferramentas', nativo: null, modeloUsado: 'roteiro' });
const diz = (texto) => ({ texto, chamadas: [], fim: 'fim', nativo: null, modeloUsado: 'roteiro' });

// Roteiro de quem pede "emita uma nota de R$ 350 para a Maria pelo serviço Site".
function roteiroEmissao() {
  let passo = 0;
  return (op) => {
    passo += 1;
    if (passo === 1) return pede(['buscar_clientes', { busca: 'maria' }], ['listar_servicos', {}]);
    if (passo === 2) {
      const [cli, serv] = ultimos(op);
      return pede(['criar_rascunho', { clienteId: cli.dados.clientes[0].id, servicoId: serv.dados.servicos[0].id, valor: '350.00' }]);
    }
    if (passo === 3) {
      const [r] = ultimos(op);
      assert.equal(r.dados.validacao.ok, true, JSON.stringify(r.dados.validacao));
      return pede(['emitir_nota', { notaId: r.dados.nota.id }]);
    }
    return diz('Pronto.');
  };
}

test('configuração: chave cifrada, nunca devolvida; sem configurar, o chat avisa', async () => {
  const api = sessao();
  await api('POST', '/api/conta/cadastrar', { email: 'ia-config@exemplo.com', senha: 'senha-segura-1' });
  const conv = await api('POST', '/api/ia/conversas', {});
  assert.equal(conv.status, 200);
  const semConfig = await api('POST', `/api/ia/conversas/${conv.body.conversa.id}/mensagens`, { texto: 'oi' });
  assert.equal(semConfig.status, 409);
  assert.equal(semConfig.body.codigo, 'IA_NAO_CONFIGURADA');

  const provedores = await api('GET', '/api/ia/provedores');
  const ids = provedores.body.provedores.map((p) => p.id);
  for (const id of ['anthropic', 'openai', 'xai', 'openrouter', 'deepseek', 'qwen', 'moonshot', 'zhipu', 'minimax', 'doubao', 'ernie', 'stepfun', 'personalizado']) assert.ok(ids.includes(id), id);

  assert.equal((await api('PUT', '/api/ia/config', { provedor: 'anthropic', modelo: 'claude-opus-5-5' })).status, 422, 'sem chave');
  const ok = await api('PUT', '/api/ia/config', { provedor: 'anthropic', modelo: 'claude-opus-5-5', chave: 'sk-ant-segredo-1234abcd' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.config.chaveFinal, '••••abcd');
  assert.ok(!JSON.stringify(ok.body).includes('segredo'));
  // Mesmo provedor sem chave nova: mantém a guardada. Outro provedor: exige outra.
  assert.equal((await api('PUT', '/api/ia/config', { provedor: 'anthropic', modelo: 'claude-sonnet-5-5', emissaoAutonoma: true })).status, 200);
  assert.equal((await api('PUT', '/api/ia/config', { provedor: 'deepseek', modelo: 'deepseek-chat' })).status, 422);
  const lida = await api('GET', '/api/ia/config');
  assert.equal(lida.body.config.modelo, 'claude-sonnet-5-5');
  assert.equal(lida.body.config.emissaoAutonoma, true);
  assert.ok(!JSON.stringify(lida.body).includes('segredo'));
  const linha = await app.ctx.db.get('SELECT chave_cifrada FROM ia_config');
  assert.ok(!linha.chave_cifrada.includes('segredo'), 'chave guardada cifrada');
  // Personalizado precisa de endereço público com https.
  assert.equal((await api('PUT', '/api/ia/config', { provedor: 'personalizado', modelo: 'meu-modelo', chave: 'chave-qualquer-123' })).status, 422);
});

test('endereço próprio: só https e servidor público (sem SSRF)', () => {
  assert.equal(validarBaseUrl('https://api.exemplo.com/v1/'), 'https://api.exemplo.com/v1');
  for (const u of ['http://api.exemplo.com/v1', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://10.0.0.5/v1', 'https://192.168.0.1', 'https://169.254.169.254/latest',
    'https://[::1]/v1', 'https://intranet/v1', 'https://user:senha@api.exemplo.com', 'ftp://api.exemplo.com']) assert.equal(validarBaseUrl(u), null, u);
});

test('modo com confirmação: a IA prepara, o usuário toca em "Emitir agora" e a nota sai', async () => {
  const api = await contaPronta('ia-confirma@exemplo.com');
  await api('PUT', '/api/ia/config', { provedor: 'anthropic', modelo: 'claude-opus-5-5', chave: 'sk-ant-teste-0000' });
  const conv = (await api('POST', '/api/ia/conversas', {})).body.conversa;
  modelo = roteiroEmissao();
  const antes = sefin.estado.recebidas.length;
  const r = await api('POST', `/api/ia/conversas/${conv.id}/mensagens`, { texto: 'Emita uma nota de R$ 350 para a Maria pelo serviço Site' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.erro, null);
  assert.equal(sefin.estado.recebidas.length, antes, 'nada enviado antes da confirmação');
  assert.equal(r.body.conversa.pendentes.length, 1);
  const pendente = r.body.conversa.pendentes[0];
  assert.equal(pendente.situacao, 'rascunho');
  assert.equal(pendente.valor, '350.00');
  assert.equal(pendente.homologacao, true, 'empresa em testes: o cartão não pode dizer produção');
  const ultimoItem = r.body.conversa.itens.at(-1);
  assert.equal(ultimoItem.tipo, 'assistente');
  assert.ok(ultimoItem.acoes.some((a) => a.ferramenta === 'emitir_nota'));

  // O system prompt levou o conhecimento fiscal e os parâmetros do emissor.
  const op = pedidos.at(-1);
  assert.equal(op.sistemaFixo, SISTEMA_FIXO);
  assert.match(op.sistemaVariavel, /Empresa Teste/);
  assert.match(op.sistemaVariavel, /MEI/);
  assert.match(op.sistemaVariavel, /COM CONFIRMAÇÃO/);
  assert.match(op.sistemaVariavel, /"Site" — código 010101/);
  assert.equal(op.ferramentas, DEFINICOES);
  assert.ok(!JSON.stringify(op.historico).includes('sk-ant'), 'a chave nunca entra na conversa');

  // Outra nota não pode ser confirmada por esta conversa.
  assert.equal((await api('POST', `/api/ia/conversas/${conv.id}/emissao`, { notaId: 'outra', emitir: true })).status, 409);
  const e = await api('POST', `/api/ia/conversas/${conv.id}/emissao`, { notaId: pendente.id, emitir: true });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.resultado.situacao, 'emitida');
  assert.equal(sefin.estado.recebidas.length, antes + 1);
  assert.equal(e.body.conversa.pendentes.length, 0);
  assert.equal(e.body.conversa.itens.at(-1).tipo, 'aviso');
  assert.match(e.body.conversa.itens.at(-1).texto, /^Você confirmou e a NFS-e nº \d+ foi emitida\.$/);
  const nota = await api('GET', `/api/notas/${pendente.id}`);
  assert.equal(nota.body.nota.situacao, 'emitida');
  assert.ok(nota.body.nota.chaveAcesso);
  // Confirmar de novo não reenvia.
  assert.equal((await api('POST', `/api/ia/conversas/${conv.id}/emissao`, { notaId: pendente.id, emitir: true })).status, 409);
  assert.equal(sefin.estado.recebidas.length, antes + 1);
  // A auditoria registra que a emissão veio do assistente, por confirmação.
  const aud = await app.ctx.db.all("SELECT detalhes FROM auditoria WHERE acao = 'emissao.solicitada' AND entidade_id = ?", pendente.id);
  assert.deepEqual(JSON.parse(aud[0].detalhes), { via: 'ia', autonoma: false });
});

test('rascunho alterado depois da revisão: a confirmação é recusada e nada é enviado', async () => {
  const api = await contaPronta('ia-mudou@exemplo.com');
  await api('PUT', '/api/ia/config', { provedor: 'openai', modelo: 'gpt-5', chave: 'sk-teste-openai-0000' });
  const conv = (await api('POST', '/api/ia/conversas', {})).body.conversa;
  modelo = roteiroEmissao();
  const r = await api('POST', `/api/ia/conversas/${conv.id}/mensagens`, { texto: 'emitir nota da Maria' });
  const pendente = r.body.conversa.pendentes[0];
  const n = (await api('GET', `/api/notas/${pendente.id}`)).body.nota;
  assert.equal((await api('PUT', `/api/notas/${pendente.id}`, { rascunho: { ...n.rascunho, valor: '999,00' }, versao: n.versao })).status, 200);
  const antes = sefin.estado.recebidas.length;
  const e = await api('POST', `/api/ia/conversas/${conv.id}/emissao`, { notaId: pendente.id, emitir: true });
  assert.equal(e.status, 200);
  assert.equal(e.body.resultado.situacao, 'nao_enviada');
  assert.equal(sefin.estado.recebidas.length, antes);
});

test('modo autônomo: a IA emite sozinha e relata número e chave', async () => {
  const api = await contaPronta('ia-autonomo@exemplo.com');
  await api('PUT', '/api/ia/config', { provedor: 'deepseek', modelo: 'deepseek-chat', chave: 'sk-teste-deepseek', emissaoAutonoma: true });
  const conv = (await api('POST', '/api/ia/conversas', {})).body.conversa;
  let emitida = null;
  const base = roteiroEmissao();
  modelo = (op) => {
    const ult = ultimos(op).find((x) => x.nome === 'emitir_nota');
    if (ult) { emitida = ult.dados; return diz(`Nota emitida: nº ${ult.dados.nota.numeroNfse}`); }
    return base(op);
  };
  const antes = sefin.estado.recebidas.length;
  const r = await api('POST', `/api/ia/conversas/${conv.id}/mensagens`, { texto: 'Emita uma nota de R$ 350 para a Maria pelo serviço Site' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sefin.estado.recebidas.length, antes + 1);
  assert.equal(emitida.situacao, 'emitida');
  assert.ok(emitida.nota.chaveAcesso);
  assert.match(pedidos.at(-1).sistemaVariavel, /AUTÔNOMO/);
  assert.equal(r.body.conversa.pendentes.length, 0);
  const item = r.body.conversa.itens.at(-1);
  assert.match(item.texto, /Nota emitida/);
  assert.equal(item.notas[0].situacao, 'emitida');

  // Pedir para emitir a mesma nota de novo não reenvia.
  modelo = (op) => (ultimos(op).length && op.historico.at(-1).papel === 'ferramentas' ? diz('ok') : pede(['emitir_nota', { notaId: item.notas[0].id }]));
  await api('POST', `/api/ia/conversas/${conv.id}/mensagens`, { texto: 'emita de novo' });
  assert.equal(sefin.estado.recebidas.length, antes + 1);
});

test('ferramentas nunca alcançam empresa de outra conta; erros voltam ao modelo sem derrubar a conversa', async () => {
  const outra = await contaPronta('ia-outra@exemplo.com');
  const empresaAlheia = (await outra('GET', '/api/empresas')).body.empresas[0].id;
  const api = await contaPronta('ia-dona@exemplo.com');
  await api('PUT', '/api/ia/config', { provedor: 'anthropic', modelo: 'claude-opus-5-5', chave: 'sk-ant-teste-1111' });
  const conv = (await api('POST', '/api/ia/conversas', {})).body.conversa;
  let visto = null;
  modelo = (op) => {
    if (op.historico.at(-1).papel === 'ferramentas') { visto = ultimos(op); return diz('Não encontrei.'); }
    return pede(['buscar_clientes', { empresaId: empresaAlheia }], ['ferramenta_inexistente', {}], ['ver_nota', { notaId: 'nao-existe' }]);
  };
  const r = await api('POST', `/api/ia/conversas/${conv.id}/mensagens`, { texto: 'liste os clientes da outra empresa' });
  assert.equal(r.status, 200);
  assert.ok(visto.every((x) => x.erro));
  assert.match(visto[0].dados.erro, /não encontrada/i);
  assert.ok(r.body.conversa.itens.at(-1).acoes.every((a) => a.erro));
});

test('erro do provedor: a conversa guarda o que aconteceu e a tela recebe o motivo', async () => {
  const api = await contaPronta('ia-erro@exemplo.com');
  await api('PUT', '/api/ia/config', { provedor: 'anthropic', modelo: 'claude-opus-5-5', chave: 'sk-ant-teste-2222' });
  const conv = (await api('POST', '/api/ia/conversas', {})).body.conversa;
  const { ErroIA } = await import('../src/ia/adaptadores.js');
  modelo = () => { throw new ErroIA('O provedor Anthropic recusou a chave de API (401).'); };
  const r = await api('POST', `/api/ia/conversas/${conv.id}/mensagens`, { texto: 'oi' });
  assert.equal(r.status, 200);
  assert.match(r.body.erro, /401/);
  assert.equal(r.body.conversa.itens[0].texto, 'oi');
  assert.equal(r.body.conversa.titulo, 'oi');
  const lista = await api('GET', '/api/ia/conversas');
  assert.equal(lista.body.conversas[0].id, conv.id);
  assert.equal((await api('DELETE', `/api/ia/conversas/${conv.id}`)).body.ok, true);
  assert.equal((await api('GET', `/api/ia/conversas/${conv.id}`)).status, 404);
});

test('recorte do histórico nunca separa a chamada de ferramenta do resultado', () => {
  const h = [];
  for (let i = 0; i < 30; i++) h.push({ papel: 'usuario', texto: `u${i}` }, { papel: 'assistente', chamadas: [{ id: `c${i}` }] }, { papel: 'ferramentas', resultados: [{ id: `c${i}` }] }, { papel: 'assistente', texto: 'ok' });
  const r = recortar(h, 10);
  assert.equal(r[0].papel, 'usuario');
  assert.ok(r.length <= 10);
});

// ---------------------------------------------------------------- dialetos (fetch falso)
function fetchFalso(respostas, capturados) {
  return async (url, init) => {
    capturados.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), corpo: init?.body ? JSON.parse(init.body) : null });
    const r = respostas.shift();
    return new Response(JSON.stringify(r.corpo), { status: r.status || 200, headers: { 'content-type': 'application/json', 'request-id': 'req_teste' } });
  };
}
const FERR = [{ nome: 'buscar_clientes', descricao: 'Procura clientes', parametros: { type: 'object', properties: { busca: { type: 'string' } }, required: [], additionalProperties: false } }];
const HIST = [
  { papel: 'usuario', texto: 'emita para a Maria' },
  { papel: 'assistente', texto: '', chamadas: [{ id: 'toolu_1', nome: 'buscar_clientes', args: { busca: 'maria' } }],
    nativo: { dialeto: 'anthropic', conteudo: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'toolu_1', name: 'buscar_clientes', input: { busca: 'maria' } }] } },
  { papel: 'ferramentas', resultados: [{ id: 'toolu_1', nome: 'buscar_clientes', conteudo: '{"clientes":[]}', erro: false }] },
  { papel: 'aviso', texto: 'O usuário confirmou.' },
];

test('dialeto Anthropic: SDK oficial, cache no prompt fixo, raciocínio devolvido intacto, fallback e tool_result', async () => {
  const cap = [];
  const fetch = fetchFalso([{ corpo: {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_sequence: null,
    content: [{ type: 'text', text: 'Vou procurar.' }, { type: 'tool_use', id: 'toolu_2', name: 'buscar_clientes', input: { busca: 'joão' } }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
  } }], cap);
  const r = await chamarModelo({ provedor: 'anthropic', modelo: 'claude-opus-5-5', chave: 'sk-ant-x', esforco: 'high', sistemaFixo: 'FIXO', sistemaVariavel: 'VAR', historico: HIST, ferramentas: FERR, fetch });
  const { url, headers, corpo } = cap[0];
  assert.match(url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.ok(headers['x-api-key'] === 'sk-ant-x' || headers.authorization === 'Bearer sk-ant-x', 'chave enviada pelo SDK');
  assert.ok(headers['anthropic-version']);
  assert.match(headers['anthropic-beta'] || '', /server-side-fallback-2026-07-01/);
  assert.equal(corpo.fallbacks, 'default');
  assert.equal(corpo.model, 'claude-opus-5-5');
  assert.deepEqual(corpo.output_config, { effort: 'high' });
  assert.equal(corpo.thinking, undefined, 'Opus 5.5: raciocínio sempre ligado, sem parâmetro');
  assert.equal(corpo.temperature, undefined);
  assert.deepEqual(corpo.system[0], { type: 'text', text: 'FIXO', cache_control: { type: 'ephemeral' } });
  assert.equal(corpo.system[1].text, 'VAR');
  assert.deepEqual(corpo.tool_choice, { type: 'auto' });
  assert.equal(corpo.tools[0].name, 'buscar_clientes');
  assert.equal(corpo.messages[1].content[0].type, 'thinking', 'bloco de raciocínio volta como veio');
  assert.equal(corpo.messages[2].content[0].type, 'tool_result');
  assert.equal(corpo.messages[2].content[0].tool_use_id, 'toolu_1');
  assert.match(corpo.messages[3].content, /Mensagem automática/);
  assert.equal(r.fim, 'ferramentas');
  assert.equal(r.texto, 'Vou procurar.');
  assert.deepEqual(r.chamadas, [{ id: 'toolu_2', nome: 'buscar_clientes', args: { busca: 'joão' } }]);
  assert.equal(r.nativo.dialeto, 'anthropic');

  // Modelo sem fallback do servidor: sem o cabeçalho beta.
  const cap2 = [];
  await chamarModelo({ provedor: 'anthropic', modelo: 'claude-haiku-5-5', chave: 'k', sistemaFixo: 'F', sistemaVariavel: 'V', historico: [{ papel: 'usuario', texto: 'oi' }], ferramentas: FERR,
    fetch: fetchFalso([{ corpo: { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'oi' }], usage: { input_tokens: 1, output_tokens: 1 } } }], cap2) });
  assert.equal(cap2[0].corpo.fallbacks, undefined);

  // Chave recusada: mensagem em português, sem detalhes internos.
  await assert.rejects(chamarModelo({ provedor: 'anthropic', modelo: 'claude-opus-5-5', chave: 'ruim', sistemaFixo: 'F', sistemaVariavel: 'V', historico: [{ papel: 'usuario', texto: 'oi' }], ferramentas: [],
    fetch: fetchFalso([{ status: 401, corpo: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }], []) }), /recusou a chave/);
});

test('dialeto OpenAI (OpenAI, Grok, OpenRouter, provedores chineses): funções, tool_calls e mensagens de ferramenta', async () => {
  for (const [provedor, base] of [['openai', 'https://api.openai.com/v1'], ['xai', 'https://api.x.ai/v1'], ['openrouter', 'https://openrouter.ai/api/v1'], ['deepseek', 'https://api.deepseek.com/v1'],
    ['qwen', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'], ['moonshot', 'https://api.moonshot.ai/v1'], ['zhipu', 'https://api.z.ai/api/paas/v4']]) {
    const cap = [];
    const fetch = fetchFalso([{ corpo: { model: 'm', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, reasoning_content: 'pensei',
      tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'buscar_clientes', arguments: '{"busca":"ana"}' } }] } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } }], cap);
    const r = await chamarModelo({ provedor, modelo: 'm', chave: 'sk-o', sistemaFixo: 'FIXO', sistemaVariavel: 'VAR', historico: HIST, ferramentas: FERR, fetch });
    const { url, headers, corpo } = cap[0];
    assert.equal(url, `${base}/chat/completions`, provedor);
    assert.equal(headers.authorization, 'Bearer sk-o');
    assert.equal(corpo.messages[0].role, 'system');
    assert.match(corpo.messages[0].content, /FIXO[\s\S]*VAR/);
    assert.equal(corpo.tools[0].function.name, 'buscar_clientes');
    assert.equal(corpo.messages[2].tool_calls[0].function.arguments, '{"busca":"maria"}');
    assert.equal(corpo.messages[3].role, 'tool');
    assert.equal(corpo.messages[3].tool_call_id, 'toolu_1');
    if (provedor === 'openai') assert.equal(corpo.max_completion_tokens, 16000); else assert.equal(corpo.max_completion_tokens, undefined);
    assert.equal(r.fim, 'ferramentas');
    assert.deepEqual(r.chamadas[0], { id: 'call_9', nome: 'buscar_clientes', args: { busca: 'ana' } });
    assert.equal(r.nativo.raciocinio, 'pensei');
  }
  // Argumentos quebrados não viram chamada silenciosa: ficam marcados para o servidor devolver erro ao modelo.
  const r = await chamarModelo({ provedor: 'minimax', modelo: 'MiniMax-M2', chave: 'k', sistemaFixo: 'F', sistemaVariavel: 'V', historico: [{ papel: 'usuario', texto: 'oi' }], ferramentas: FERR,
    fetch: fetchFalso([{ corpo: { choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'buscar_clientes', arguments: '{"busca":' } }] } }] } }], []) });
  assert.equal(r.chamadas[0].argsInvalidos, true);
  // Provedor personalizado usa o endereço informado.
  const cap = [];
  await chamarModelo({ provedor: 'personalizado', baseUrl: 'https://llm.exemplo.com/v1', modelo: 'x', chave: 'k', sistemaFixo: 'F', sistemaVariavel: 'V', historico: [{ papel: 'usuario', texto: 'oi' }], ferramentas: [],
    fetch: fetchFalso([{ corpo: { choices: [{ finish_reason: 'stop', message: { content: 'olá' } }] } }], cap) });
  assert.equal(cap[0].url, 'https://llm.exemplo.com/v1/chat/completions');
  assert.equal(cap[0].corpo.tools, undefined);
  await assert.rejects(chamarModelo({ provedor: 'deepseek', modelo: 'x', chave: 'k', sistemaFixo: 'F', sistemaVariavel: 'V', historico: [{ papel: 'usuario', texto: 'oi' }], ferramentas: [],
    fetch: fetchFalso([{ status: 404, corpo: { error: { message: 'Model Not Exist' } } }], []) }), /não encontrou o modelo/);
});

test('system prompt: conhecimento fiscal e regras do produto', () => {
  for (const termo of ['LC 116/2003', 'E0235', 'regApTribSN', 'Lucro Presumido', 'Lei 10.833/2003', 'IBS', 'CBS', 'cClassTrib', 'R$ 81.000,00', 'verificar_nota', 'NUNCA invente', 'Fator R'])
    assert.ok(SISTEMA_FIXO.includes(termo), termo);
});

// ---------------------------------------------------------------- modelos, anexos, identidade e ferramentas novas
test('modelos: lista vem do provedor com a chave guardada; troca rápida de modelo', async () => {
  const api = await contaPronta('ia-modelos@exemplo.com');
  assert.equal((await api('POST', '/api/ia/modelos', { provedor: 'anthropic' })).status, 422, 'sem chave nenhuma');
  await api('PUT', '/api/ia/config', { provedor: 'anthropic', modelo: 'claude-opus-5-5', chave: 'sk-ant-modelos-1234' });
  const r = await api('POST', '/api/ia/modelos', { provedor: 'anthropic' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.modelos.map((m) => m.id), ['modelo-novo', 'modelo-antigo']);
  assert.equal(listagens.at(-1).chave, 'sk-ant-modelos-1234', 'usou a chave guardada no servidor');
  assert.ok(!JSON.stringify(r.body).includes('sk-ant'), 'a chave não volta ao app');
  // Outro provedor: a chave guardada não vale; com a chave nova, lista.
  assert.equal((await api('POST', '/api/ia/modelos', { provedor: 'openai' })).status, 422);
  assert.equal((await api('POST', '/api/ia/modelos', { provedor: 'openai', chave: 'sk-openai-nova-123' })).status, 200);
  assert.equal(listagens.at(-1).chave, 'sk-openai-nova-123');
  const t = await api('PUT', '/api/ia/config/modelo', { modelo: 'modelo-novo' });
  assert.equal(t.status, 200);
  assert.equal(t.body.config.modelo, 'modelo-novo');
  assert.equal(t.body.config.provedor, 'anthropic');
  assert.equal((await api('PUT', '/api/ia/config/modelo', { modelo: 'x y z' })).status, 422);
});

test('listar modelos: Anthropic pela SDK; formato OpenAI filtra embeddings/áudio e, no OpenRouter, quem não usa ferramentas', async () => {
  const cap = [];
  const ant = await listarModelos({ provedor: 'anthropic', chave: 'k', fetch: fetchFalso([{ corpo: { data: [
    { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-10-01T00:00:00Z', lifecycle: 'active' },
    { type: 'model', id: 'claude-velho', display_name: 'Velho', created_at: '2024-01-01T00:00:00Z', lifecycle: 'retired' },
  ], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-velho' } }], cap) });
  assert.match(cap[0].url, /\/v1\/models/);
  assert.deepEqual(ant.map((m) => m.id), ['claude-opus-5-5']);
  assert.equal(ant[0].nome, 'Claude Opus 5.5');
  const oa = await listarModelos({ provedor: 'openai', chave: 'k', fetch: fetchFalso([{ corpo: { data: [
    { id: 'gpt-5', created: 1760000000 }, { id: 'text-embedding-3-large', created: 1 }, { id: 'whisper-1', created: 1 }, { id: 'gpt-5-mini', created: 1750000000 },
  ] } }], []) });
  assert.deepEqual(oa.map((m) => m.id), ['gpt-5', 'gpt-5-mini']);
  const or = await listarModelos({ provedor: 'openrouter', chave: 'k', fetch: fetchFalso([{ corpo: { data: [
    { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5', supported_parameters: ['tools', 'max_tokens'] },
    { id: 'algum/sem-ferramentas', name: 'Sem', supported_parameters: ['max_tokens'] },
  ] } }], []) });
  assert.deepEqual(or.map((m) => m.id), ['anthropic/claude-opus-5.5']);
  await assert.rejects(listarModelos({ provedor: 'deepseek', chave: 'ruim', fetch: fetchFalso([{ status: 401, corpo: { error: { message: 'bad key' } } }], []) }), /recusou a chave/);
});

function xlsxClientes() {
  return Buffer.from(zipSync({
    'xl/workbook.xml': strToU8('<workbook xmlns:r="r"><sheets><sheet name="Notas de novembro" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8('<sst><si><t>Cliente</t></si><si><t>CPF</t></si><si><t>Valor</t></si><si><t>Competência</t></si><si><r><t>Maria </t></r><r><t>da Silva</t></r></si><si><t>529.982.247-25</t></si></sst>'),
    'xl/styles.xml': strToU8('<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'),
    'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2"><v>350</v></c><c r="D2" s="1"><v>46325</v></c></row></sheetData></worksheet>'),
  })).toString('base64');
}

test('anexos: Excel, Word, PDF e CSV viram texto; formatos antigos e arquivos grandes são recusados', async () => {
  const x = await extrairAnexo({ nome: 'notas.xlsx', base64: xlsxClientes() });
  assert.equal(x.tipo, 'planilha');
  assert.match(x.texto, /Aba "Notas de novembro"/);
  assert.match(x.texto, /Maria da Silva\t529\.982\.247-25\t350\t30\/10\/2026/);
  const docx = Buffer.from(zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>Contrato de consultoria</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Valor mensal</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>R$ 2.000,00 &amp; ISS 2%</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>') }));
  const w = await extrairAnexo({ nome: 'contrato.docx', base64: docx.toString('base64') });
  assert.match(w.texto, /Contrato de consultoria/);
  assert.match(w.texto, /Valor mensal +\| R\$ 2\.000,00 & ISS 2%/);
  const pdf = await new Promise((ok) => { const d = new PDFDocument(); const p = []; d.on('data', (c) => p.push(c)); d.on('end', () => ok(Buffer.concat(p))); d.text('Proposta: consultoria tributária de R$ 5.000,00'); d.addPage(); d.text('Prazo de 30 dias'); d.end(); });
  const pd = await extrairAnexo({ nome: 'proposta.pdf', base64: pdf.toString('base64') });
  assert.match(pd.texto, /página 1[\s\S]*consultoria tributária de R\$ 5\.000,00[\s\S]*página 2[\s\S]*Prazo de 30 dias/);
  assert.match(pd.detalhe, /2 página/);
  const csv = await extrairAnexo({ nome: 'lista.csv', base64: Buffer.from('nome;valor\nJoão;10', 'latin1').toString('base64') });
  assert.equal(csv.texto, 'nome;valor\nJoão;10', 'CSV do Excel em Windows-1252');
  await assert.rejects(extrairAnexo({ nome: 'velho.xls', base64: 'AAAA' }), /\.xlsx/);
  await assert.rejects(extrairAnexo({ nome: 'foto.png', base64: 'AAAA' }), /Tipo de arquivo/);
  await assert.rejects(extrairAnexo({ nome: 'grande.txt', base64: Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64') }), /3 MB/);
});

test('anexo na conversa: o texto do arquivo chega ao modelo como dado delimitado, e a tela mostra só o nome', async () => {
  const api = await contaPronta('ia-anexo@exemplo.com');
  await api('PUT', '/api/ia/config', { provedor: 'anthropic', modelo: 'claude-opus-5-5', chave: 'sk-ant-anexo-0000' });
  const conv = (await api('POST', '/api/ia/conversas', {})).body.conversa;
  modelo = () => diz('Encontrei 1 linha: Maria da Silva, R$ 350,00.');
  const r = await api('POST', `/api/ia/conversas/${conv.id}/mensagens`, { texto: '', anexos: [{ nome: 'notas.xlsx', base64: xlsxClientes() }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const op = pedidos.at(-1);
  const ultimo = [...op.historico].reverse().find((m) => m.papel === 'usuario');
  assert.equal(ultimo.texto, 'Analise o arquivo notas.xlsx.');
  assert.match(ultimo.anexos[0].texto, /Maria da Silva/);
  const item = r.body.conversa.itens.find((i) => i.tipo === 'usuario');
  assert.equal(item.anexos[0].nome, 'notas.xlsx');
  assert.equal(item.anexos[0].texto, undefined, 'o conteúdo não volta para a tela');
  // No formato que vai ao provedor, o arquivo entra delimitado.
  const cap = [];
  await chamarModelo({ provedor: 'deepseek', modelo: 'm', chave: 'k', sistemaFixo: 'F', sistemaVariavel: 'V', historico: [ultimo], ferramentas: [],
    fetch: fetchFalso([{ corpo: { choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] } }], cap) });
  assert.match(cap[0].corpo.messages[1].content, /<arquivo_anexado nome="notas.xlsx" tipo="planilha"[\s\S]*Maria da Silva[\s\S]*<\/arquivo_anexado>/);
  // Formato antigo: recusado antes de gastar chamada ao provedor.
  const antes = pedidos.length;
  const v = await api('POST', `/api/ia/conversas/${conv.id}/mensagens`, { texto: 'veja', anexos: [{ nome: 'velho.doc', base64: 'AAAA' }] });
  assert.equal(v.status, 422);
  assert.equal(pedidos.length, antes);
});

test('identidade: o assistente sabe o modelo em uso e quem é o usuário', async () => {
  const api = await contaPronta('ia-quem@exemplo.com');
  await api('PUT', '/api/ia/config', { provedor: 'anthropic', modelo: 'claude-opus-5-5', chave: 'sk-ant-quem-0000' });
  const conv = (await api('POST', '/api/ia/conversas', {})).body.conversa;
  modelo = () => diz('Sou o Assistente Fiscal do Nota Sem Stress.');
  await api('POST', `/api/ia/conversas/${conv.id}/mensagens`, { texto: 'Qual modelo é você?' });
  const op = pedidos.at(-1);
  assert.match(op.sistemaVariavel, /Modelo em uso: claude-opus-5-5, do provedor Anthropic \(Claude\)/);
  assert.match(op.sistemaVariavel, /Usuário: .*ia-quem@exemplo\.com/);
  assert.match(op.sistemaVariavel, /Agora \(Brasília\): .*\d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/);
  assert.match(op.sistemaFixo, /Modelo em uso/);
  assert.match(op.sistemaFixo, /Nunca diga que não sabe/);
});

test('ferramentas novas: editar e excluir cliente/serviço e atualizar parâmetros fiscais (sem mexer em CNPJ e ambiente)', async () => {
  const api = await contaPronta('ia-editar@exemplo.com');
  await api('PUT', '/api/ia/config', { provedor: 'anthropic', modelo: 'claude-opus-5-5', chave: 'sk-ant-editar-0000' });
  const conv = (await api('POST', '/api/ia/conversas', {})).body.conversa;
  const clienteId = (await api('GET', '/api/clientes')).body.clientes[0].id;
  const servicoId = (await api('GET', '/api/servicos')).body.servicos[0].id;
  const antes = (await api('GET', '/api/perfil')).body.perfil;
  let resultados = null;
  modelo = (op) => {
    if (op.historico.at(-1).papel === 'ferramentas') { resultados = ultimos(op); return diz('feito'); }
    return pede(['editar_cliente', { clienteId, email: 'maria.nova@exemplo.com' }], ['editar_servico', { servicoId, valorPadrao: '400.00' }],
      ['atualizar_parametros_fiscais', { opSimpNac: '3', regApTribSN: '1', pTotTribSN: '6.00' }]);
  };
  await api('POST', `/api/ia/conversas/${conv.id}/mensagens`, { texto: 'atualize o e-mail da Maria, o valor do site e passe a empresa para o Simples' });
  assert.ok(resultados.every((x) => !x.erro), JSON.stringify(resultados));
  assert.equal((await api('GET', `/api/clientes/${clienteId}`)).body.cliente.email, 'maria.nova@exemplo.com');
  assert.equal((await api('GET', `/api/servicos/${servicoId}`)).body.servico.valorPadrao, '400.00');
  const depois = (await api('GET', '/api/perfil')).body.perfil;
  assert.equal(depois.opSimpNac, '3');
  assert.equal(depois.pTotTribSN, '6.00');
  assert.equal(depois.documento, antes.documento, 'CNPJ não muda');
  assert.equal(depois.ambiente, antes.ambiente, 'ambiente não muda');
  assert.deepEqual(resultados[2].dados.alterados.opSimpNac, { antes: '2', depois: '3' });
  // Valor inválido: a mesma validação da tela, e nada muda.
  modelo = (op) => (op.historico.at(-1).papel === 'ferramentas' ? (resultados = ultimos(op), diz('não deu')) : pede(['atualizar_parametros_fiscais', { pTotTribSN: '150' }]));
  await api('POST', `/api/ia/conversas/${conv.id}/mensagens`, { texto: 'coloque 150%' });
  assert.equal(resultados[0].erro, true);
  assert.equal((await api('GET', '/api/perfil')).body.perfil.pTotTribSN, '6.00');
  modelo = (op) => (op.historico.at(-1).papel === 'ferramentas' ? (resultados = ultimos(op), diz('ok')) : pede(['excluir_servico', { servicoId }], ['excluir_cliente', { clienteId }]));
  await api('POST', `/api/ia/conversas/${conv.id}/mensagens`, { texto: 'pode excluir o serviço e a cliente' });
  assert.ok(resultados.every((x) => !x.erro));
  assert.equal((await api('GET', `/api/clientes/${clienteId}`)).status, 404);
  assert.equal((await api('GET', `/api/servicos/${servicoId}`)).status, 404);
});
