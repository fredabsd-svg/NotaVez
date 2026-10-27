// Fluxo de integração em Chromium, CSP real, Receita exclusivamente simulada.
process.env.NODE_ENV = 'test';
process.env.NOTAVEZ_DEMO = '1';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { gerarCertificadoTeste } from '../test/apoio/certificado-teste.js';
import { iniciarSefinSimulada } from '../test/apoio/sefin-simulada.js';
const { criarApp } = await import('../src/app.js');
const { criarClienteSefin } = await import('../src/fiscal/sefin/cliente.js');
const { ambientesSefin } = await import('../src/config.js');
const { criarConsultaCnpj } = await import('../src/cadastro/consulta-cnpj.js');
// Base pública do CNPJ simulada (nada sai para a internet).
const basePublica = async (url) => {
  const cnpj = url.split('/').pop();
  const comuns = { descricao_situacao_cadastral: 'ATIVA', descricao_tipo_de_logradouro: 'RUA', logradouro: 'DAS FLORES', numero: '10', bairro: 'CENTRO' };
  if (cnpj === '11222333000181') return Response.json({ ...comuns, razao_social: 'EMPRESA FICTICIA SMOKE MEI', codigo_municipio_ibge: 3550308, uf: 'SP', cep: '01001000', opcao_pelo_simples: true, opcao_pelo_mei: true });
  if (cnpj === '11444777000161') return Response.json({ ...comuns, razao_social: 'CONSULTORIA FICTICIA LTDA', codigo_municipio_ibge: 3304557, uf: 'RJ', cep: '20010000', opcao_pelo_simples: false, opcao_pelo_mei: false, regime_tributario: [{ ano: 2024, forma_de_tributacao: 'LUCRO PRESUMIDO' }] });
  if (cnpj === '52998224725') return new Response('{}', { status: 404 });
  return new Response('{}', { status: 404 });
};
const cert = gerarCertificadoTeste({ cnpj: '11222333000181' });
const sefin = await iniciarSefinSimulada({ caPem: cert.caPem, caChavePem: cert.caChavePem, certClientePem: cert.certPem });
ambientesSefin.producao_restrita.sefin = sefin.baseUrl;
ambientesSefin.producao_restrita.parametros = sefin.baseParametros;
ambientesSefin.producao_restrita.consultaPublica = null;
ambientesSefin.producao_restrita.adn = sefin.baseAdn;
sefin.adicionarTomada({ tomador: '11222333000181', nome: 'FORNECEDOR FICTICIO LTDA', valor: '450.00', competencia: '2026-09-10' });
const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: true,
  contaPublica: { responsavel: 'Responsável fictício de teste', contatoPrivacidade: 'teste@example.invalid', retencao: 'Ambiente efêmero de teste.' },
  fabricaCliente: (o) => criarClienteSefin({ ...o, ca: sefin.ca }), consultarCnpj: criarConsultaCnpj({ buscar: basePublica }) });
let browser; let page;
try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'pt-BR', hasTouch: true, isMobile: true });
  page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  const erros = [];
  page.on('pageerror', (e) => erros.push(e.message));
  await page.addInitScript(() => {
    window.violacoesCsp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.violacoesCsp.push(e.violatedDirective));
  });
  await page.goto(base);
  await page.getByRole('tab', { name: 'Criar conta' }).click();
  await page.getByLabel('E-mail', { exact: true }).fill('smoke-a@example.invalid');
  await page.getByLabel(/^Senha/).fill('senha-segura-1');
  await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
  // Cadastro pelo CNPJ: razão social, município e enquadramento vêm da consulta.
  await page.getByLabel('CNPJ da empresa').fill('11222333000181');
  await page.getByText('Dados encontrados na Receita').waitFor();
  assert.equal(await page.getByLabel('Nome ou razão social').inputValue(), 'EMPRESA FICTICIA SMOKE MEI');
  assert.equal(await page.getByRole('combobox', { name: /Município do CNPJ/ }).inputValue(), 'São Paulo - SP');
  assert.equal(await page.getByLabel('Regime tributário').inputValue(), '2');
  await page.getByRole('button', { name: 'Cadastrar empresa', exact: true }).click();
  await page.getByLabel('Arquivo do certificado A1').setInputFiles({ name: 'teste.pfx', mimeType: 'application/x-pkcs12', buffer: cert.pfx });
  await page.getByLabel('Senha do certificado').fill(cert.senha);
  await page.locator('#consentimento').check();
  await page.getByRole('button', { name: 'Enviar certificado' }).click();
  await page.getByText('Tudo pronto para emitir', { exact: true }).waitFor();
  const post = async (url, data) => {
    const r = await ctx.request.post(base + url, { data, headers: { 'X-NotaVez': '1' } });
    assert.equal(r.status(), 200, await r.text()); return r.json();
  };
  const cliente = (await post('/api/clientes', { documento: '52998224725', nome: 'Cliente fictício' })).cliente;
  const servico = (await post('/api/servicos', { apelido: 'Teste', cTribNac: '010101', descricao: 'Serviço de teste', valorPadrao: '150,00' })).servico;
  const nota = (await post('/api/notas', { rascunho: { clienteId: cliente.id, servicoId: servico.id } })).nota;
  await page.goto(`${base}/#/nota/${nota.id}/revisao`);
  await page.getByRole('button', { name: 'Emitir nota', exact: true }).click();
  await page.getByRole('heading', { name: 'Emitida (simulação)', exact: true }).waitFor();
  const pdf = await ctx.request.get(`${base}/api/notas/${nota.id}/danfse`);
  assert.equal(pdf.status(), 200);
  assert.equal((await pdf.body()).subarray(0, 5).toString(), '%PDF-');
  const xml = await ctx.request.get(`${base}/api/notas/${nota.id}/xml`);
  assert.equal(xml.status(), 200);
  assert.match(await xml.text(), /<NFSe/);
  // O navegador usa o módulo real para guardar um rascunho ainda não enviado.
  const idLocal = await page.evaluate(async () => {
    const s = await import('/js/store.js');
    const id = crypto.randomUUID();
    await s.salvarLocal(id, { descricao: 'Somente conta A', valor: '123.00' });
    return id;
  });
  // Notas tomadas: busca no ADN simulado com o certificado da empresa.
  await page.goto(`${base}/#/tomadas`);
  await page.getByRole('button', { name: 'Buscar notas na Receita' }).click();
  await page.getByText('FORNECEDOR FICTICIO LTDA').waitFor();
  await page.getByText('FORNECEDOR FICTICIO LTDA').click();
  await page.getByRole('button', { name: 'Baixar XML da NFS-e' }).waitFor();

  // Segunda empresa (Lucro Presumido): dados do outro CNPJ, ambiente próprio.
  await page.goto(`${base}/#/empresas`);
  await page.getByRole('link', { name: 'Adicionar empresa' }).click();
  await page.getByLabel('CNPJ da empresa').fill('11444777000161');
  await page.getByText('Dados encontrados na Receita').waitFor();
  assert.equal(await page.getByLabel('Regime tributário').inputValue(), '1');
  assert.equal(await page.getByLabel('Forma de tributação do IRPJ').inputValue(), 'presumido');
  assert.equal(await page.getByLabel('Alíquota do PIS (%)').inputValue(), '0,65');
  await page.getByLabel('Tributos federais aproximados (%)').fill('13,45');
  await page.getByLabel('Tributos municipais aproximados (%)').fill('5');
  await page.getByRole('button', { name: 'Cadastrar empresa', exact: true }).click();
  await page.locator('#empresa-ativa').getByText('CONSULTORIA FICTICIA LTDA').waitFor();
  const draftsSegunda = await page.evaluate(async () => (await import('/js/store.js')).rascunhosLocais());
  assert.equal(draftsSegunda.length, 0, 'rascunhos ficam no ambiente da empresa');
  await page.goto(`${base}/#/empresas`);
  await page.getByText('2 de 2 empresa(s)').waitFor();
  await page.getByRole('button', { name: /EMPRESA FICTICIA SMOKE MEI/ }).click();
  await page.locator('#empresa-ativa').getByText('EMPRESA FICTICIA SMOKE MEI').waitFor();
  await page.getByRole('navigation', { name: 'Ações desta empresa' }).getByRole('link', { name: /Notas tomadas/ }).waitFor();
  const draftsPrimeira = await page.evaluate(async () => (await import('/js/store.js')).rascunhosLocais());
  assert.deepEqual(draftsPrimeira.map((r) => r.id), [idLocal], 'de volta à primeira empresa, o rascunho dela reaparece');
  // Recarregar a página mantém a empresa aberta.
  await page.reload();
  await page.locator('#empresa-ativa').getByText('EMPRESA FICTICIA SMOKE MEI').waitFor();

  await page.goto(`${base}/#/perfil`);
  await page.getByRole('button', { name: 'Sair da conta', exact: true }).click();
  await page.getByRole('tab', { name: 'Criar conta' }).click();
  await page.getByLabel('E-mail', { exact: true }).fill('smoke-b@example.invalid');
  await page.getByLabel(/^Senha/).fill('senha-segura-1');
  await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
  await page.getByLabel('CNPJ da empresa').waitFor();
  const draftsB = await page.evaluate(async () => (await import('/js/store.js')).rascunhosLocais());
  assert.equal(draftsB.length, 0, 'B não pode ver o draft de A');
  // Ao voltar à empresa A o rascunho local foi sincronizado — sempre no ambiente de A.
  const dono = app.ctx.db.get('SELECT u.email FROM notas n JOIN prestadores p ON p.id = n.prestador_id JOIN usuarios u ON u.id = p.usuario_id WHERE n.id = ?', idLocal);
  assert.ok(!dono || dono.email === 'smoke-a@example.invalid', 'rascunho de A nunca vai para B');
  await page.goto(`${base}/#/conta`);
  await page.getByLabel('Confirme sua senha para excluir').fill('senha-segura-1');
  await page.locator('#exclusao-confirmada').check();
  await page.getByRole('button', { name: 'Excluir minha conta e dados' }).click();
  await page.getByRole('tab', { name: 'Já tenho conta' }).waitFor();
  await page.goto(`${base}/privacidade.html`);
  await page.getByText('Responsável fictício de teste', { exact: false }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.violacoesCsp), []);
  assert.deepEqual(erros, []);
  console.log('Smoke web aprovado: cadastro pelo CNPJ, A1, várias empresas, notas tomadas, revisão/emissão simulada, XML/PDF, isolamento A/B, exclusão e privacidade; CSP ativa.');
} catch (e) {
  if (page) {
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/smoke-falha.png', fullPage: true }).catch(() => {});
  }
  throw e;
} finally {
  await browser?.close();
  await app.close();
  await sefin.fechar();
}
