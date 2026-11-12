// Captura as telas do docs/02 e a vitrine do README com o app de verdade, em processo:
// Receita, ADN e base do CNPJ simulados (nada sai para a internet, nenhuma nota real é emitida).
// Uso: cd server && node scripts/capturar-telas.mjs
// Requer o Chromium do Playwright (CHROMIUM_EXECUTABLE_PATH aponta outro, se preciso).
process.env.NODE_ENV = 'test';
process.env.NOTAVEZ_DEMO = '1';
import { chromium } from 'playwright';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gerarCertificadoTeste } from '../test/apoio/certificado-teste.js';
import { iniciarSefinSimulada } from '../test/apoio/sefin-simulada.js';
const { criarApp } = await import('../src/app.js');
const { criarClienteSefin } = await import('../src/fiscal/sefin/cliente.js');
const { ambientesSefin } = await import('../src/config.js');
const { criarConsultaCnpj } = await import('../src/cadastro/consulta-cnpj.js');

const DOCS = fileURLToPath(new URL('../../docs/', import.meta.url));
const TELAS = `${DOCS}prototipo`;
const DANFSE = '29-danfse.png';
// Empresas e clientes fictícios (CNPJs de exemplo, com dígitos válidos).
const MEI = '11222333000181';
const SIMPLES = '12345678000195';
const PRESUMIDO = '11444777000161';
const CLIENTE_PJ = '22333444000181';
const cadastro = {
  [MEI]: { razao_social: 'ANA SOUZA DESIGN', opcao_pelo_simples: true, opcao_pelo_mei: true },
  [SIMPLES]: { razao_social: 'ESTUDIO CRIATIVO LTDA', opcao_pelo_simples: true, opcao_pelo_mei: false },
  [PRESUMIDO]: { razao_social: 'CONSULTORIA EXEMPLO LTDA', opcao_pelo_simples: false, opcao_pelo_mei: false },
  [CLIENTE_PJ]: { razao_social: 'PADARIA PAO QUENTE LTDA', opcao_pelo_simples: true, opcao_pelo_mei: false },
};
const basePublica = async (url) => {
  const c = cadastro[url.split('/').pop()];
  return c ? Response.json({ descricao_situacao_cadastral: 'ATIVA', descricao_tipo_de_logradouro: 'PRAÇA', logradouro: 'DA SÉ', numero: '100', bairro: 'SÉ',
    codigo_municipio_ibge: 3550308, uf: 'SP', cep: '01001000', ...c }) : new Response('{}', { status: 404 });
};
// Datas relativas a hoje (horário de Brasília): a competência nunca pode ser futura.
const diasAtras = (n) => new Date(Date.now() - 3 * 3600_000 - n * 86400_000).toISOString().slice(0, 10);

const cert = gerarCertificadoTeste({ cnpj: MEI });
const sefin = await iniciarSefinSimulada({ caPem: cert.caPem, caChavePem: cert.caChavePem, certClientePem: cert.certPem });
ambientesSefin.producao_restrita.sefin = sefin.baseUrl;
ambientesSefin.producao_restrita.parametros = sefin.baseParametros;
ambientesSefin.producao_restrita.consultaPublica = null;
ambientesSefin.producao_restrita.adn = sefin.baseAdn;
sefin.adicionarTomada({ tomador: MEI, nome: 'CONTABILIDADE EXEMPLO LTDA', valor: '450.00', competencia: diasAtras(30) });
sefin.adicionarTomada({ tomador: MEI, nome: 'SUPORTE DE TI EXEMPLO ME', valor: '1200.00', competencia: diasAtras(22) });
const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: true,
  contaPublica: { responsavel: 'Responsável fictício', contatoPrivacidade: 'privacidade@example.invalid', retencao: 'Ambiente de demonstração.' },
  // Espera curta pela Receita simulada: a nota "pendente" de exemplo não segura a captura por 30 s.
  fabricaCliente: (o) => criarClienteSefin({ ...o, ca: sefin.ca, timeoutMs: 2_000 }), consultarCnpj: criarConsultaCnpj({ buscar: basePublica }) });
const base = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
const erros = [];
const celular = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' };

// Uma "sessão" de captura: contexto do navegador, chamadas à API com a mesma conta e fotos.
async function sessao(opcoes, pasta = TELAS) {
  const ctx = await browser.newContext(opcoes);
  const p = await ctx.newPage();
  p.setDefaultTimeout(15_000);
  p.on('pageerror', (e) => erros.push(e.message));
  const chamar = async (metodo, url, data, empresa) => {
    const r = await ctx.request[metodo](base + url, { data, headers: { 'X-NotaVez': '1', ...(empresa ? { 'X-NotaVez-Prestador': empresa } : {}) } });
    if (!r.ok()) throw new Error(`${metodo} ${url}: ${r.status()} ${await r.text()}`);
    return r.json();
  };
  const post = (url, data, empresa) => chamar('post', url, data, empresa);
  const abrir = async (hash, esperar) => {
    await p.goto(`${base}/#${hash}`);
    if (esperar) await p.locator('#conteudo, #titulo').getByText(esperar, { exact: false }).first().waitFor();
    await p.waitForLoadState('networkidle').catch(() => {});
  };
  // Página inteira: cabeçalho, barra da empresa e abas saem do modo fixo para não cobrirem o conteúdo na imagem.
  const foto = async (nome, { inteira = true } = {}) => {
    await p.waitForTimeout(350);
    await p.evaluate(() => document.getElementById('aviso')?.replaceChildren());
    // Pelo CSSOM (a CSP do app não aceita <style> injetado), e desfeito logo depois da foto.
    const fixos = (ligar) => p.evaluate((soltar) => {
      for (const e of document.querySelectorAll('.topo, .empresa-ativa, .abas, .rodape-fixo')) {
        if (soltar) e.style.setProperty('position', 'static', 'important'); else e.style.removeProperty('position');
      }
      if (soltar) document.body.style.setProperty('padding-bottom', '0', 'important'); else document.body.style.removeProperty('padding-bottom');
    }, ligar);
    if (inteira) await fixos(true);
    await p.screenshot({ path: `${pasta}/${nome}.png`, fullPage: inteira });
    if (inteira) await fixos(false);
    console.log('tela', nome);
  };
  return { ctx, p, post, abrir, foto };
}

// Entra numa empresa pela lista, como a pessoa faz (a empresa aberta fica guardada no aparelho).
async function abrirEmpresa(x, nome) {
  await x.abrir('/empresas', nome);
  await x.p.getByRole('button', { name: new RegExp(nome) }).click();
  await x.p.locator('#empresa-ativa').getByText(nome).waitFor();
}

// Conta, três empresas (MEI, ME/EPP e Lucro Presumido) e o movimento do MEI: notas em três meses,
// uma rejeitada, uma pendente de confirmação, um rascunho e uma nota clonada.
async function semear(post) {
  const empresa = (await post('/api/empresas', { documento: MEI, nome: 'Ana Souza Design', municipioIbge: '3550308', opSimpNac: '2', ambiente: 'producao_restrita' })).empresaId;
  const pj = { documento: CLIENTE_PJ, nome: 'Padaria Pão Quente Ltda', email: 'contato@paoquente.example', endereco: { cep: '01001000', municipioIbge: '3550308', logradouro: 'Praça da Sé', numero: '100', bairro: 'Sé' } };
  const clientes = [];
  for (const c of [pj, { documento: '52998224725', nome: 'Maria da Silva' }, { documento: '39053344705', nome: 'João Pereira dos Santos' }, { documento: '15350946056', nome: 'Carla Mendes Fotografia' }]) {
    clientes.push((await post('/api/clientes', c, empresa)).cliente);
  }
  const servicos = [];
  for (const s of [
    { apelido: 'Identidade visual', cTribNac: '230101', descricao: 'Criação de identidade visual (logotipo, paleta e manual de marca).', valorPadrao: '1.200,00' },
    { apelido: 'Manutenção de site', cTribNac: '010701', descricao: 'Manutenção mensal de site institucional.', valorPadrao: '350,00' },
    { apelido: 'Arte para redes', cTribNac: '230101', descricao: 'Criação de artes para redes sociais (pacote mensal).', valorPadrao: '480,00' },
  ]) servicos.push((await post('/api/servicos', s, empresa)).servico);
  return { empresa, clientes, servicos, pj };
}
async function movimentar(post, { empresa, clientes, servicos }) {
  const rascunho = (c, s, valor, dias) => post('/api/notas', { rascunho: { clienteId: clientes[c].id, servicoId: servicos[s].id, valor, competencia: diasAtras(dias) } }, empresa);
  const emitir = async (c, s, valor, dias) => {
    const { nota } = await rascunho(c, s, valor, dias);
    const v = await post(`/api/notas/${nota.id}/validar`, { versao: nota.versao }, empresa);
    return (await post(`/api/notas/${nota.id}/emitir`, { versao: v.versao, revisao: v.revisao }, empresa)).nota;
  };
  for (const [c, s, valor, dias] of [[0, 0, '1.200,00', 92], [1, 1, '350,00', 78], [0, 1, '350,00', 64], [2, 2, '480,00', 50], [3, 0, '1.500,00', 38], [0, 1, '350,00', 33], [1, 2, '480,00', 20]]) await emitir(c, s, valor, dias);
  sefin.estado.cenario.push('rejeitar');
  const rejeitada = await emitir(2, 1, '350,00', 6);
  sefin.estado.cenario.push('timeout_apos_processar');
  const pendente = await emitir(3, 2, '480,00', 5); // a resposta "se perde": a nota fica pendente de confirmação
  const emitida = await emitir(0, 0, '1.200,00', 4);
  const clonada = (await post(`/api/notas/${emitida.id}/clonar`, {}, empresa)).nota;
  const aberto = (await rascunho(1, 0, '900,00', 1)).nota;
  await post('/api/tomadas/sincronizar', {}, empresa);
  return { emitida, rejeitada, pendente, clonada, aberto };
}

try {
  await mkdir(TELAS, { recursive: true });
  // Remove as capturas anteriores, menos a do DANFSe (imagem do PDF de demonstração, que não é uma tela do app).
  for (const f of await readdir(TELAS)) if (/^\d\d-.*\.png$/.test(f) && f !== DANFSE) await unlink(`${TELAS}/${f}`);
  // ---------- Celular (390×844), tema claro ----------
  const visitante = await sessao(celular);
  await visitante.p.goto(base);
  await visitante.p.getByLabel('CPF, CNPJ ou e-mail').waitFor();
  await visitante.foto('01-entrar');
  await visitante.p.getByRole('button', { name: 'Fazer primeiro acesso' }).click();
  await visitante.p.getByLabel(/^CPF ou CNPJ/).fill('52998224725');
  await visitante.p.getByLabel(/^Nome/).fill('Ana Souza');
  await visitante.p.getByLabel(/^E-mail/).fill('ana@example.invalid');
  await visitante.foto('02-primeiro-acesso');
  await visitante.ctx.close();
  // A conta é criada pela API antes de o app abrir neste contexto (o app lembra quando não há sessão).
  const s = await sessao(celular);
  await s.post('/api/conta/cadastrar', { documento: '52998224725', nome: 'Ana Souza', email: 'ana@example.invalid', senha: 'senha-segura-1', lembrar: true });
  // Cadastro da empresa pelo CNPJ: os dados vêm da consulta pública (aqui, simulada).
  await s.p.goto(`${base}/#/empresas/nova`);
  await s.p.getByLabel('CNPJ da empresa').fill(MEI);
  await s.p.getByText('Dados encontrados na Receita').waitFor();
  await s.foto('03-empresa-pelo-cnpj');
  const dados = await semear(s.post);
  await abrirEmpresa(s, 'Ana Souza Design');
  await s.abrir('/perfil', 'O que falta para emitir');
  await s.foto('04-perfil-pendencias');
  await s.post('/api/certificado', { pfxBase64: cert.pfx.toString('base64'), senha: cert.senha, consentimento: true }, dados.empresa);
  await s.abrir('/', 'Nova nota');
  await s.abrir('/perfil', 'Tudo pronto para emitir');
  await s.foto('05-perfil-pronto');
  const notas = await movimentar(s.post, dados);
  await s.abrir('/', 'Notas recentes');
  await s.foto('06-inicio');
  await s.abrir(`/clientes/${dados.clientes[0].id}`, 'CPF ou CNPJ');
  await s.foto('07-cliente');
  await s.abrir('/clientes', 'Padaria');
  await s.foto('08-clientes');
  await s.abrir(`/servicos/${dados.servicos[0].id}`, 'Nome curto');
  await s.foto('09-servico');
  await s.abrir(`/nota/${notas.aberto.id}`, '1. Cliente');
  await s.foto('10-nova-nota');
  await s.abrir(`/nota/${notas.aberto.id}/revisao`, 'Confira os dados');
  await s.foto('11-revisao');
  await s.abrir(`/nota/${notas.emitida.id}/resultado`, 'Enviar ao cliente');
  await s.foto('12-resultado-emitida');
  await s.abrir(`/nota/${notas.clonada.id}`, 'Nota clonada');
  await s.foto('13-nota-clonada');
  await s.abrir(`/nota/${notas.rejeitada.id}/resultado`, 'Rejeitada');
  await s.foto('14-resultado-rejeitada');
  await s.abrir(`/nota/${notas.pendente.id}/resultado`, 'Pendente de confirmação');
  await s.foto('15-resultado-pendente');
  await s.abrir('/notas', 'Padaria');
  await s.foto('16-notas');
  await s.abrir(`/notas/${notas.emitida.id}`, 'Clonar esta nota');
  await s.foto('17-detalhe');
  await s.abrir('/tomadas', 'CONTABILIDADE');
  await s.foto('18-notas-tomadas');
  // Sem internet: o rascunho continua editável, com o aviso de que ainda não foi emitido.
  await s.abrir(`/nota/${notas.aberto.id}`, '1. Cliente');
  await s.ctx.setOffline(true);
  await s.p.locator('#faixa-offline').waitFor();
  await s.foto('19-sem-internet');
  await s.ctx.setOffline(false);
  await s.abrir('/instalar', 'iPhone');
  await s.foto('20-instalar');

  // ---------- ME/EPP do Simples e Lucro Presumido: perfil e tributação da nota ----------
  for (const [prefixo, numero, corpo, nome] of [
    ['me-epp', 21, { documento: SIMPLES, nome: 'Estúdio Criativo Ltda', municipioIbge: '3550308', opSimpNac: '3', regApTribSN: '1', pTotTribSN: '6,00', aliqIssSN: '2,00', ambiente: 'producao_restrita' }, 'Estúdio Criativo Ltda'],
    ['presumido', 23, { documento: PRESUMIDO, nome: 'Consultoria Exemplo Ltda', municipioIbge: '3550308', opSimpNac: '1', apuracao: 'presumido', cstPisCofins: '01', aliqPis: '0,65', aliqCofins: '3,00', pTotTribFed: '13,45', pTotTribMun: '5', aliqIss: '5', ambiente: 'producao_restrita' }, 'Consultoria Exemplo Ltda'],
  ]) {
    const id = (await s.post('/api/empresas', corpo)).empresaId;
    const cliente = (await s.post('/api/clientes', dados.pj, id)).cliente;
    const servico = (await s.post('/api/servicos', { apelido: 'Consultoria em TI', cTribNac: '010601', descricao: 'Consultoria em tecnologia da informação.', valorPadrao: '5.000,00' }, id)).servico;
    const { nota } = await s.post('/api/notas', { rascunho: { clienteId: cliente.id, servicoId: servico.id, issRetido: true, competencia: diasAtras(1) } }, id);
    await abrirEmpresa(s, nome);
    await s.abrir('/perfil', 'Dados fiscais');
    await s.foto(`${numero}-perfil-${prefixo}`);
    await s.abrir(`/nota/${nota.id}`, '4. Tributação');
    await s.foto(`${numero + 1}-nova-nota-${prefixo}`);
  }
  await s.abrir('/empresas', '3 de 3 empresas');
  await s.foto('25-empresas');
  const cookies = await s.ctx.storageState();
  await s.ctx.close();
  // Cada contexto novo começa na lista de empresas (a empresa aberta fica guardada no aparelho): abre o MEI.
  const abrirMei = (x) => abrirEmpresa(x, 'Ana Souza Design');

  // ---------- Tema escuro e computador ----------
  const escuro = await sessao({ ...celular, colorScheme: 'dark', storageState: cookies });
  await abrirMei(escuro);
  await escuro.abrir('/', 'Notas recentes');
  await escuro.foto('26-inicio-escuro');
  await escuro.ctx.close();
  const pc = await sessao({ viewport: { width: 1280, height: 860 }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', storageState: cookies });
  await abrirMei(pc);
  await pc.abrir('/', 'Notas recentes');
  await pc.foto('27-inicio-computador', { inteira: false });
  await pc.abrir('/notas', 'Padaria');
  await pc.foto('28-notas-computador', { inteira: false });
  await pc.ctx.close();

  // ---------- Vitrine do README e da página de apresentação (1600×860) ----------
  const pastaVitrine = `${DOCS}assets`;
  const nitido = await sessao({ ...celular, deviceScaleFactor: 2, storageState: cookies }, pastaVitrine);
  await abrirMei(nitido);
  const quadros = [];
  for (const [hash, esperar] of [['/', 'Notas recentes'], ['/notas', 'Padaria'], [`/nota/${notas.emitida.id}/resultado`, 'Enviar ao cliente']]) {
    await nitido.abrir(hash, esperar);
    await nitido.p.waitForTimeout(350);
    quadros.push((await nitido.p.screenshot()).toString('base64'));
  }
  await nitido.ctx.close();
  const danfse = (await readFile(`${TELAS}/${DANFSE}`).catch(() => null))?.toString('base64');
  const montagem = await browser.newPage({ viewport: { width: 1600, height: 860 } });
  await montagem.setContent(`<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; width: 1600px; height: 860px; display: flex; align-items: center; justify-content: center; gap: 56px; overflow: hidden;
      background: radial-gradient(1200px 700px at 20% 10%, #e8f1fb, transparent), radial-gradient(900px 600px at 90% 90%, #e6f4ea, transparent), #f5f7fa; }
    .aparelho { width: 300px; height: 649px; border-radius: 40px; padding: 10px; background: #12233f; box-shadow: 0 30px 60px rgba(15, 39, 68, .28); }
    .aparelho img { width: 100%; height: 100%; border-radius: 31px; display: block; object-fit: cover; object-position: top; }
    .aparelho:nth-child(2) { transform: translateY(-28px); }
    .folha { width: 360px; border-radius: 6px; box-shadow: 0 24px 50px rgba(15, 39, 68, .22); transform: rotate(4deg); display: block; }
  </style>${quadros.map((q) => `<div class="aparelho"><img src="data:image/png;base64,${q}" alt=""></div>`).join('')}
  ${danfse ? `<img class="folha" src="data:image/png;base64,${danfse}" alt="">` : ''}`);
  await montagem.waitForTimeout(300);
  await montagem.screenshot({ path: `${pastaVitrine}/vitrine-nota-sem-stress.png` });
  console.log('vitrine', danfse ? 'com DANFSe' : `sem DANFSe (docs/prototipo/${DANFSE} não encontrado)`);
  if (erros.length) { console.error('Erros de JavaScript nas telas:', erros); process.exitCode = 1; }
} finally {
  await browser.close();
  await app.close();
  await sefin.fechar();
}
