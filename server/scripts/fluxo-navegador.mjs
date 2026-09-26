// Teste de interface ponta a ponta + captura das telas do protótipo.
// Pré-requisitos: `npm run demo` rodando (porta em BASE) e Playwright disponível
// (`npm i -D playwright`). Uso: BASE=http://localhost:8080 node scripts/fluxo-navegador.mjs
import { chromium } from 'playwright';
const BASE = process.env.BASE || 'http://localhost:8080';
const OUT = new URL('../../docs/prototipo', import.meta.url).pathname;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'pt-BR', hasTouch: true, isMobile: true, bypassCSP: true });
const p = await ctx.newPage();
const erros = [];
// 401 esperado: o app consulta a sessão antes do login.
p.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text())) erros.push(m.text()); });
p.on('pageerror', (e) => erros.push('PAGEERROR ' + e.message));
const foto = async (n) => { await p.waitForTimeout(400); await p.evaluate(() => document.getElementById('aviso')?.replaceChildren()); const st = await p.addStyleTag({ content: '.topo,.abas,.rodape-fixo{position:static!important} body{padding-bottom:0!important}' }); await p.screenshot({ path: `${OUT}/${n}.png`, fullPage: true }); await st.evaluate((e) => e.remove()); console.log('foto', n); };
const esperarTexto = (t) => p.getByText(t, { exact: false }).first().waitFor({ timeout: 8000 });

await p.goto(BASE);
await esperarTexto('Nota fiscal de serviço');
await foto('01-entrar');
await p.getByRole('tab', { name: 'Criar conta' }).click();
await p.getByLabel('E-mail').fill(`mei${Date.now()}@exemplo.com`);
await p.getByLabel('Senha').fill('senha-segura-1');
await p.getByRole('button', { name: 'Criar conta' }).click();
await esperarTexto('O que falta para emitir');
await foto('02-perfil-pendencias');

await p.getByLabel('CNPJ da empresa').fill('11222333000181');
await p.getByLabel('Nome ou razão social').fill('Ana Souza Design');
await p.getByRole('combobox', { name: /Município do seu CNPJ/ }).fill('são paulo');
await p.getByRole('button', { name: 'São Paulo - SP' }).click();
await p.getByRole('button', { name: 'Salvar perfil' }).click();
await p.waitForLoadState('load'); await esperarTexto('Certificado digital');
await p.getByLabel('Arquivo do certificado A1').setInputFiles((await import('node:path')).join((await import('node:os')).tmpdir(), 'notavez-certificado-DEMO.pfx'));
await p.getByLabel('Senha do certificado').fill('demo1234');
await p.locator('#consentimento').check();
await p.getByRole('button', { name: 'Enviar certificado' }).click();
await esperarTexto('Tudo pronto para emitir');
await foto('03-perfil-pronto');

await p.goto(BASE + '/#/'); await esperarTexto('Emitir nota');
await foto('04-inicio');

await p.goto(BASE + '/#/clientes/novo'); await esperarTexto('CPF ou CNPJ');
await p.getByLabel('CPF ou CNPJ').fill('11444777000161');
await p.getByLabel('Nome ou razão social').fill('Padaria Pão Quente Ltda');
await p.getByRole('textbox', { name: /^E-mail/ }).fill('contato@paoquente.com.br');
await p.getByLabel('CEP').fill('01001000');
await p.getByLabel('Número', { exact: true }).fill('100');
await p.getByRole('combobox', { name: 'Cidade' }).fill('são paulo');
await p.getByRole('button', { name: 'São Paulo - SP' }).click();
await p.getByLabel('Rua / avenida').fill('Praça da Sé');
await p.getByLabel('Bairro').fill('Sé');
await foto('05-cliente-novo');
await p.getByRole('button', { name: 'Salvar cliente' }).click();
await p.waitForTimeout(600);
await p.goto(BASE + '/#/clientes/novo'); await esperarTexto('CPF ou CNPJ');
await p.getByLabel('CPF ou CNPJ').fill('52998224725');
await p.getByLabel('Nome ou razão social').fill('Maria da Silva');
await p.getByRole('button', { name: 'Salvar cliente' }).click();
await p.waitForTimeout(600);
await p.goto(BASE + '/#/clientes'); await esperarTexto('Padaria');
await p.getByLabel('Pesquisar').fill('529');
await p.waitForTimeout(700);
await foto('06-clientes-busca');

await p.goto(BASE + '/#/servicos/novo'); await esperarTexto('Nome curto');
await p.getByLabel('Nome curto').fill('Identidade visual');
await p.getByRole('combobox', { name: /lista nacional/ }).fill('design');
await p.locator('.sugestoes button', { hasText: '230101' }).click();
await p.getByLabel('Descrição que vai na nota').fill('Criação de identidade visual (logotipo, paleta e manual de marca).');
await p.getByLabel('Valor de costume').fill('1.200,00');
await foto('07-servico-novo');
await p.getByRole('button', { name: 'Salvar serviço' }).click();
await p.waitForTimeout(600);

await p.goto(BASE + '/#/nova'); await esperarTexto('1. Cliente');
await p.getByRole('link', { name: 'Escolher cliente' }).click();
await esperarTexto('Escolher cliente');
await p.getByRole('button', { name: /Padaria/ }).click();
await esperarTexto('2. Serviço');
await p.getByRole('button', { name: 'Identidade visual' }).click();
await p.waitForTimeout(800);
await foto('08-nova-nota');
await p.getByRole('button', { name: 'Revisar nota' }).click();
await esperarTexto('Valor do serviço');
await foto('09-revisao');
await p.getByRole('button', { name: 'Emitir nota' }).click();
await esperarTexto('Emitida');
await foto('10-resultado-emitida');
// DANFSe (NT 008): o botão abre o PDF gerado a partir do XML oficial.
{
  const href = await p.getByRole('link', { name: /Ver DANFSe/ }).getAttribute('href');
  const r = await p.request.get(BASE + href);
  const corpo = await r.body();
  if (r.headers()['content-type'] !== 'application/pdf' || !corpo.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('DANFSe não é um PDF');
  (await import('node:fs')).writeFileSync(new URL('../../docs/exemplos/danfse-demonstracao.pdf', import.meta.url), corpo);
  console.log('DANFSe', corpo.length, 'bytes');
  // O botão abre o PDF numa nova aba (blob), sem página de erro no caminho.
  // (No Chromium sem interface o PDF vira download; no celular, abre no leitor.)
  const [aba] = await Promise.all([p.waitForEvent('popup'), p.getByRole('link', { name: /Ver DANFSe/ }).click()]);
  const baixado = await aba.waitForEvent('download', { timeout: 8000 });
  if (!baixado.url().startsWith('blob:')) throw new Error('DANFSe não abriu pelo botão');
  console.log('DANFSe aberto pelo botão');
  await aba.close().catch(() => {});
}

await p.goto(BASE + '/#/'); await esperarTexto('Última emissão');
await p.getByRole('link', { name: 'Clonar última nota' }).click();
await esperarTexto('Nota clonada');
await foto('11-nota-clonada');
const idClone = p.url().split('/nota/')[1];
while (await p.locator('.revisar input[type=checkbox]').count()) { await p.locator('.revisar input[type=checkbox]').first().click(); await p.waitForTimeout(150); }
await p.getByRole('button', { name: 'Revisar nota' }).click();
await esperarTexto('Valor do serviço');
await p.request.post(BASE + '/api/demo/cenario', { data: { cenario: 'rejeitar' }, headers: { 'x-notavez': '1' } });
await p.getByRole('button', { name: 'Emitir nota' }).click();
await esperarTexto('Rejeitada');
await foto('12-resultado-rejeitada');

await p.getByRole('link', { name: 'Corrigir e enviar de novo' }).click();
await esperarTexto('A Receita recusou');
await p.getByRole('button', { name: 'Revisar nota' }).click();
await esperarTexto('Valor do serviço');
await p.request.post(BASE + '/api/demo/cenario', { data: { cenario: 'erro500' }, headers: { 'x-notavez': '1' } });
await p.getByRole('button', { name: 'Emitir nota' }).click();
await esperarTexto('Pendente de confirmação');
await foto('13-resultado-pendente');
await p.waitForTimeout(5200);
await p.getByRole('button', { name: /Verificar situação/ }).click();
await esperarTexto('Emitida');
await foto('14-pendente-confirmada');

await p.goto(BASE + '/#/notas'); await esperarTexto('Todas');
await foto('15-historico');
await p.locator('.lista .item').first().click();
await esperarTexto('Detalhes');
await foto('16-detalhe');

await ctx.setOffline(true);
await p.goto(BASE + '/#/nova').catch(() => {});
await p.evaluate(() => { location.hash = '#/nova'; });
await esperarTexto('Sem internet');
await p.waitForTimeout(800);
await p.getByLabel('Valor do serviço (R$)').fill('250,00');
await p.waitForTimeout(1200);
await foto('17-offline-rascunho');
await p.getByRole('button', { name: 'Revisar nota' }).click();
await esperarTexto('ainda não foi emitida');
await foto('18-offline-revisao');
await ctx.setOffline(false);
await p.evaluate(() => { location.hash = '#/instalar'; });
await esperarTexto('iPhone');
await foto('19-instalar');
console.log('ERROS DO NAVEGADOR:', JSON.stringify(erros, null, 1));
await b.close();
