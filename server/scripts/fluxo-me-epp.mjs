// Fluxo ME/EPP no navegador (modo demonstração) + captura das telas.
// Pré-requisitos: `npm run demo` rodando e Playwright (`npm i -D playwright`).
// Uso: BASE=http://localhost:8080 node scripts/fluxo-me-epp.mjs
import { chromium } from 'playwright';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = process.env.BASE || 'http://localhost:8080';
const OUT = new URL('../../docs/prototipo', import.meta.url).pathname;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'pt-BR', hasTouch: true, isMobile: true, bypassCSP: true });
const p = await ctx.newPage();
const erros = [];
p.on('pageerror', (e) => erros.push(e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text())) erros.push(m.text()); });
const foto = async (n) => {
  await p.waitForTimeout(400);
  await p.evaluate(() => document.getElementById('aviso')?.replaceChildren());
  const st = await p.addStyleTag({ content: '.topo,.abas,.rodape-fixo{position:static!important} body{padding-bottom:0!important}' });
  await p.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
  await st.evaluate((e) => e.remove());
  console.log('foto', n);
};
const esperar = (t) => p.getByText(t, { exact: false }).first().waitFor({ timeout: 8000 });

await p.goto(BASE);
await esperar('Nota fiscal de serviço');
await p.getByRole('tab', { name: 'Criar conta' }).click();
await p.getByLabel('E-mail').fill(`me${Date.now()}@exemplo.com`);
await p.getByLabel('Senha').fill('senha-segura-1');
await p.getByRole('button', { name: 'Criar conta' }).click();
await esperar('O que falta para emitir');

await p.getByLabel('CNPJ da empresa').fill('11222333000181');
await p.getByLabel('Nome ou razão social').fill('Estúdio Souza Ltda');
await p.getByRole('combobox', { name: /Município do seu CNPJ/ }).fill('são paulo');
await p.getByRole('button', { name: 'São Paulo - SP' }).click();
await p.getByLabel('Regime tributário').selectOption('3');
await p.getByLabel(/Percentual aproximado de tributos/).fill('6,00');
await p.getByLabel(/Alíquota do ISS no Simples/).fill('2,00');
await foto('20-perfil-me-epp');
await p.getByRole('button', { name: 'Salvar perfil' }).click();
await p.waitForLoadState('load'); await esperar('Certificado digital');
await p.getByLabel('Arquivo do certificado A1').setInputFiles(join(tmpdir(), 'notavez-certificado-DEMO.pfx'));
await p.getByLabel('Senha do certificado').fill('demo1234');
await p.locator('#consentimento').check();
await p.getByRole('button', { name: 'Enviar certificado' }).click();
await esperar('Tudo pronto para emitir');
await foto('21-perfil-me-epp-pronto');

await p.goto(`${BASE}/#/clientes/novo`); await esperar('CPF ou CNPJ');
await p.getByLabel('CPF ou CNPJ').fill('11444777000161');
await p.getByLabel('Nome ou razão social').fill('Rede Mercados Bom Preço Ltda');
await p.getByLabel('CEP').fill('01001000');
await p.getByLabel('Número', { exact: true }).fill('100');
await p.getByRole('combobox', { name: 'Cidade' }).fill('são paulo');
await p.getByRole('button', { name: 'São Paulo - SP' }).click();
await p.getByLabel('Rua / avenida').fill('Praça da Sé');
await p.getByLabel('Bairro').fill('Sé');
await p.getByRole('button', { name: 'Salvar cliente' }).click();
await p.waitForTimeout(600);

await p.goto(`${BASE}/#/nova`); await esperar('1. Cliente');
await p.getByRole('link', { name: 'Escolher cliente' }).click();
await p.getByRole('button', { name: /Rede Mercados/ }).click();
await esperar('2. Serviço');
await p.getByRole('combobox', { name: /lista nacional/ }).fill('design');
await p.locator('.sugestoes button', { hasText: '230101' }).click();
await p.getByLabel('Descrição do serviço').fill('Campanha visual de fim de ano: peças para redes sociais e PDV.');
await p.getByLabel('Valor do serviço (R$)').fill('4.800,00');
await p.locator('#iss-retido').check();
await p.waitForTimeout(900);
await foto('22-nova-nota-me-epp-retencao');
await p.getByRole('button', { name: 'Revisar nota' }).click();
await esperar('Valor do serviço');
await foto('23-revisao-me-epp');
await p.getByRole('button', { name: 'Emitir nota' }).click();
await esperar('Emitida');
await foto('24-resultado-me-epp');
console.log('ERROS DO NAVEGADOR:', JSON.stringify(erros));
await b.close();
