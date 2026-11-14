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

const cert = gerarCertificadoTeste({ cnpj: '11222333000181' });
let sefin; let app;
// O "modelo" de cada teste: uma função que recebe o pedido montado pelo servidor.
let modelo = null;
const pedidos = [];

before(async () => {
  sefin = await iniciarSefinSimulada({ caPem: cert.caPem, caChavePem: cert.caChavePem, certClientePem: cert.certPem });
  ambientesSefin.producao_restrita.sefin = sefin.baseUrl;
  ambientesSefin.producao_restrita.parametros = sefin.baseParametros;
  app = await criarApp({
    banco: ':memory:', logger: false, servirWeb: false, fabricaCliente: (o) => criarClienteSefin({ ...o, ca: sefin.ca }),
    chamarIa: async (op) => { pedidos.push(op); return modelo(op); },
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
    capturados.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()), corpo: JSON.parse(init.body) });
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
