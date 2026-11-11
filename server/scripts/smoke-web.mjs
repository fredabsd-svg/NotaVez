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
const cert = gerarCertificadoTeste({ cnpj: '11222333000181' });
const sefin = await iniciarSefinSimulada({ caPem: cert.caPem, caChavePem: cert.caChavePem, certClientePem: cert.certPem });
ambientesSefin.producao_restrita.sefin = sefin.baseUrl;
ambientesSefin.producao_restrita.parametros = sefin.baseParametros;
ambientesSefin.producao_restrita.consultaPublica = null;
const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: true,
  contaPublica: { responsavel: 'Responsável fictício de teste', contatoPrivacidade: 'teste@example.invalid', retencao: 'Ambiente efêmero de teste.' },
  fabricaCliente: (o) => criarClienteSefin({ ...o, ca: sefin.ca }) });
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
  await page.getByLabel('CNPJ da empresa').fill('11222333000181');
  await page.getByLabel('Nome ou razão social').fill('Empresa fictícia smoke');
  await page.getByRole('combobox', { name: /Município do seu CNPJ/ }).fill('são paulo');
  await page.getByRole('button', { name: 'São Paulo - SP', exact: true }).click();
  await page.getByRole('button', { name: 'Salvar perfil', exact: true }).click();
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
  await page.goto(`${base}/#/perfil`);
  await page.getByRole('button', { name: 'Sair da conta', exact: true }).click();
  await page.getByRole('tab', { name: 'Criar conta' }).click();
  await page.getByLabel('E-mail', { exact: true }).fill('smoke-b@example.invalid');
  await page.getByLabel(/^Senha/).fill('senha-segura-1');
  await page.getByRole('button', { name: 'Criar conta', exact: true }).click();
  await page.getByLabel('CNPJ da empresa').waitFor();
  const draftsB = await page.evaluate(async () => (await import('/js/store.js')).rascunhosLocais());
  assert.equal(draftsB.length, 0, 'B não pode ver o draft de A');
  assert.equal(app.ctx.db.get('SELECT id FROM notas WHERE id = ?', idLocal), undefined);
  await page.goto(`${base}/#/conta`);
  await page.getByLabel('Confirme sua senha para excluir').fill('senha-segura-1');
  await page.locator('#exclusao-confirmada').check();
  await page.getByRole('button', { name: 'Excluir minha conta e dados' }).click();
  await page.getByRole('tab', { name: 'Já tenho conta' }).waitFor();
  await page.goto(`${base}/privacidade.html`);
  await page.getByText('Responsável fictício de teste', { exact: false }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.violacoesCsp), []);
  assert.deepEqual(erros, []);
  console.log('Smoke web aprovado: cadastro, perfil/A1, revisão/emissão simulada, XML/PDF, isolamento A/B, exclusão e privacidade; CSP ativa.');
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
