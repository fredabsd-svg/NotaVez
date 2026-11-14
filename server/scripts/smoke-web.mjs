// Fluxo de integração em Chromium, CSP real, Receita exclusivamente simulada.
process.env.NODE_ENV = 'test';
process.env.NOTAVEZ_DEMO = '1';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
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
// Sem espera entre buscas na Receita simulada: o roteiro consulta a mesma empresa várias vezes.
const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: true, pausaEntreEmpresasMs: 0, intervaloSincronizacaoMs: 0,
  contaPublica: { responsavel: 'Responsável fictício de teste', contatoPrivacidade: 'teste@example.invalid', retencao: 'Ambiente efêmero de teste.' },
  fabricaCliente: (o) => criarClienteSefin({ ...o, ca: sefin.ca }), consultarCnpj: criarConsultaCnpj({ buscar: basePublica }) });
let browser; let page;
try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'pt-BR', hasTouch: true, isMobile: true, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  const erros = [];
  page.on('pageerror', (e) => erros.push(e.message));
  await page.addInitScript(() => {
    window.violacoesCsp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.violacoesCsp.push(e.violatedDirective));
  });
  await page.goto(base);
  // Primeiro acesso como no Portal da NFS-e: CPF como usuário, e-mail e senha.
  await page.getByRole('button', { name: 'Fazer primeiro acesso' }).click();
  await page.getByLabel(/^CPF ou CNPJ/).fill('52998224725');
  assert.equal(await page.getByLabel(/^CPF ou CNPJ/).inputValue(), '529.982.247-25');
  await page.getByLabel(/^E-mail/).fill('smoke-a@example.invalid');
  await page.getByLabel(/^Senha/).fill('senha-segura-1');
  await page.getByLabel(/^Repita a senha/).fill('senha-segura-1');
  await page.getByRole('button', { name: 'Criar acesso', exact: true }).click();
  // Código de recuperação mostrado uma vez, antes de seguir.
  await page.getByRole('heading', { name: 'Guarde seu código de recuperação' }).waitFor();
  const codigoA = (await page.locator('.codigo-recuperacao').innerText()).trim();
  assert.match(codigoA, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  await page.getByRole('button', { name: /Guardei o código — continuar/ }).click();
  assert.ok(await page.getByText('Marque que guardou o código').first().isVisible(), 'pede a confirmação antes de seguir');
  await page.getByLabel('Guardei o código em lugar seguro.').check();
  await page.getByRole('button', { name: /Guardei o código — continuar/ }).click();
  // Cadastro pelo CNPJ: razão social, município e enquadramento vêm da consulta.
  await page.getByLabel('CNPJ da empresa').fill('11222333000181');
  await page.getByText('Dados encontrados na Receita').waitFor();
  assert.equal(await page.getByLabel('Nome ou razão social').inputValue(), 'EMPRESA FICTICIA SMOKE MEI');
  assert.equal(await page.getByRole('combobox', { name: /Município do CNPJ/ }).inputValue(), 'São Paulo - SP');
  assert.equal(await page.getByLabel('Regime tributário').inputValue(), '2');
  await page.getByRole('button', { name: 'Cadastrar empresa', exact: true }).click();
  await page.getByLabel('Arquivo do certificado A1').setInputFiles({ name: 'teste.pfx', mimeType: 'application/x-pkcs12', buffer: cert.pfx });
  await page.getByLabel('Senha do certificado').fill(cert.senha);
  await page.getByLabel(/Autorizo o Nota Sem Stress a guardar/).check();
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
  // Início: resumo das notas emitidas (por competência), limite anual do MEI e notas recentes.
  await page.goto(`${base}/#/`);
  await page.getByText('Limite anual do MEI').first().waitFor();
  await page.getByRole('heading', { name: 'Notas recentes' }).waitFor();
  await page.getByText('Notas de teste, sem validade').waitFor();
  await page.getByRole('link', { name: /150,00 em 1 nota emitida/ }).click();
  // A barra do mês abre as emitidas daquela competência; a lista vem agrupada por mês, com o total.
  await page.getByText('Emitidas no mês:').waitFor();
  await page.getByText(/150,00 em 1 emitida/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Emitidas', exact: true }).getAttribute('aria-pressed'), 'true');
  // Exportar CSV: a lista mostrada, em formato de planilha em português.
  const [baixado] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar CSV' }).click()]);
  const csv = await readFile(await baixado.path(), 'utf8');
  assert.match(csv, /^\uFEFF"Competência";"Número da NFS-e";"Cliente";"Situação";"Valor \(R\$\)";"Chave de acesso";"Ambiente"\r\n/);
  assert.match(csv, /"Cliente fictício";"Emitida";"150,00";"\d{50}";"Testes"\r\n$/);
  // Filtro sem resultado: a tela diz isso e oferece limpar (não fica em branco).
  await page.getByRole('button', { name: 'Rejeitadas', exact: true }).click();
  await page.getByText('Nenhuma nota com estes filtros').waitFor();
  await page.getByRole('link', { name: 'Limpar filtros' }).click();
  await page.getByRole('link', { name: /Cliente fictício/ }).first().waitFor();
  // Resumo indisponível (servidor falhou só no Início): a ação principal continua e há "Tentar de novo".
  await page.route('**/api/inicio', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"erro":"Falha simulada."}' }));
  await page.goto(`${base}/#/`);
  await page.getByText('Não foi possível carregar o resumo agora').waitFor();
  await page.getByRole('link', { name: 'Nova nota', exact: true }).first().waitFor();
  await page.unroute('**/api/inicio');
  await page.getByRole('button', { name: 'Tentar de novo' }).click();
  await page.getByRole('heading', { name: 'Notas recentes' }).waitFor();
  // Certificado perto de vencer: o Início avisa e aponta para o certificado que de fato assina (aqui, o do escritório).
  await page.route('**/api/inicio', async (r) => {
    const resposta = await r.fetch();
    await r.fulfill({ response: resposta, json: { ...(await resposta.json()), certificadoValidoAte: new Date(Date.now() + 10.5 * 86400_000).toISOString(), certificadoDoEscritorio: true } });
  });
  await page.goto(`${base}/#/notas`);
  await page.goto(`${base}/#/`);
  await page.getByText(/O certificado do escritório vence em 10 dias/).waitFor();
  assert.equal(await page.locator('a.alerta-linha').getAttribute('href'), '#/procurador');
  await page.unroute('**/api/inicio');
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
  await page.getByRole('button', { name: 'Baixar XML' }).waitFor();

  // Nova nota pela tela: escolher cliente e serviço salvos (rascunho chega ao servidor).
  await page.goto(`${base}/#/nova`);
  await page.getByRole('link', { name: 'Escolher cliente' }).click();
  await page.getByRole('button', { name: /Cliente fictício/ }).click();
  await page.getByRole('button', { name: 'Teste', exact: true }).click();
  const idNova = page.url().split('/nota/')[1];
  let rascunhoTela;
  for (let i = 0; i < 50 && !rascunhoTela?.rascunho?.servicoId; i++) { await page.waitForTimeout(100); rascunhoTela = await app.ctx.repo.notaPorId(idNova); }
  assert.equal(rascunhoTela?.rascunho?.clienteId, cliente.id, 'cliente escolhido na tela chega ao servidor');
  assert.equal(rascunhoTela?.rascunho?.servicoId, servico.id, 'serviço escolhido na tela chega ao servidor');

  // Rascunho aberto e abandonado não vai para a conta; mexer só na competência já conta como rascunho.
  await page.goto(`${base}/#/nova`); await page.getByLabel(/^Competência/).waitFor();
  const idVazio = page.url().split('/nota/')[1];
  await page.goto(`${base}/#/nova`); await page.getByLabel(/^Competência/).waitFor();
  const idCompet = page.url().split('/nota/')[1];
  await page.getByLabel(/^Competência/).fill('15/08/2026');
  let soCompetencia;
  for (let i = 0; i < 50 && !soCompetencia; i++) { await page.waitForTimeout(100); soCompetencia = await app.ctx.repo.notaPorId(idCompet); }
  assert.equal(soCompetencia?.rascunho?.competencia, '2026-08-15', 'rascunho só com a competência chega à conta');
  assert.ok(!await app.ctx.repo.notaPorId(idVazio), 'rascunho em branco abandonado não vai para a conta');

  // Emissão assistida: roteiro para o Emissor Nacional, copiar campo e trazer o XML emitido lá.
  const assistida = (await post('/api/notas', { rascunho: { clienteId: cliente.id, servicoId: servico.id, valor: '275,00' } })).nota;
  await page.goto(`${base}/#/nota/${assistida.id}/revisao`);
  await page.getByRole('link', { name: /emitir pelo Emissor Nacional/i }).click();
  await page.getByRole('link', { name: 'Abrir o Emissor Nacional' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Abrir o Emissor Nacional' }).getAttribute('target'), '_blank');
  await page.getByRole('button', { name: 'Copiar Valor do serviço prestado' }).click();
  await page.getByRole('button', { name: 'Copiar Valor do serviço prestado' }).getByText('Copiado ✓').waitFor();
  const xmlEmissor = sefin.adicionarTomada({ prestador: '11222333000181', tomador: '11444777000161', valor: '275.00' }).xml;
  await page.locator('input[type=file][accept*=xml]').setInputFiles({ name: 'nfse.xml', mimeType: 'application/xml', buffer: Buffer.from(xmlEmissor) });
  await page.getByRole('heading', { name: 'Emitida no Emissor Nacional' }).waitFor();
  await page.getByText('Emitida por você no Emissor Nacional', { exact: false }).first().waitFor();
  assert.equal((await app.ctx.db.get('SELECT situacao, canal FROM notas WHERE id = ?', assistida.id)).canal, 'emissor_nacional');

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
  // Procuração eletrônica: certificado do escritório na conta e a empresa assinando por ele.
  await page.goto(`${base}/#/procurador`);
  await page.getByLabel('Arquivo do certificado A1').setInputFiles({ name: 'escritorio.pfx', mimeType: 'application/x-pkcs12', buffer: cert.pfx });
  await page.getByLabel('Senha do certificado').fill(cert.senha);
  await page.getByLabel(/Autorizo o Nota Sem Stress a guardar este certificado/).check();
  await page.getByRole('button', { name: 'Enviar certificado do escritório' }).click();
  await page.getByText('Certificado do escritório ativo').waitFor();
  await page.goto(`${base}/#/perfil`);
  await page.getByRole('button', { name: /Certificado do escritório \(procuração eletrônica\)/ }).click();
  await page.getByText('Assina pelo escritório:').waitFor();
  // A barra da empresa diz que ela é atendida por procuração, e a procuração ainda não foi conferida na Receita.
  await page.locator('#empresa-ativa .ctx-proc:visible').waitFor();
  await page.getByText('A procuração desta empresa ainda não foi conferida na Receita.').waitFor();
  assert.equal((await app.ctx.db.get("SELECT usa_procuracao u FROM prestadores WHERE nome = 'CONSULTORIA FICTICIA LTDA'")).u, 1);
  const draftsSegunda = await page.evaluate(async () => (await import('/js/store.js')).rascunhosLocais());
  assert.equal(draftsSegunda.length, 0, 'rascunhos ficam no ambiente da empresa');
  await page.goto(`${base}/#/empresas`);
  await page.getByText('2 de 2 empresas').waitFor();
  await page.getByRole('button', { name: /EMPRESA FICTICIA SMOKE MEI/ }).click();
  await page.locator('#empresa-ativa').getByText('EMPRESA FICTICIA SMOKE MEI').waitFor();
  await page.getByRole('link', { name: 'Nova nota', exact: true }).first().waitFor();
  const draftsPrimeira = await page.evaluate(async () => (await import('/js/store.js')).rascunhosLocais());
  assert.ok(draftsPrimeira.some((r) => r.id === idLocal), 'de volta à primeira empresa, o rascunho dela reaparece');
  // Recarregar a página mantém a empresa aberta.
  await page.reload();
  await page.locator('#empresa-ativa').getByText('EMPRESA FICTICIA SMOKE MEI').waitFor();

  // Nota emitida FORA do app (no portal): a busca na Receita traz a nota para "Notas" e, depois, o cancelamento dela.
  const fora = sefin.adicionarTomada({ prestador: '11222333000181', tomador: '11444777000161', valor: '820.00', descricao: 'Emitida no portal' });
  await page.goto(`${base}/#/notas`);
  await page.getByRole('button', { name: 'Buscar na Receita agora' }).click();
  await page.getByText(/1 nota emitida fora do app entrou em Notas/).waitFor();
  await page.locator('.linha-nota', { hasText: '820,00' }).getByText('Emitida (fora do app)').waitFor();
  sefin.cancelarTomada(fora.chave);
  await page.getByRole('button', { name: 'Buscar na Receita agora' }).click();
  await page.locator('.linha-nota', { hasText: '820,00' }).getByText('Cancelada').waitFor();
  await page.locator('.linha-nota', { hasText: '820,00' }).click();
  await page.getByRole('heading', { name: 'Cancelada', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Ver DANFSe' }).waitFor();
  // Trocar de empresa pela barra do topo mantém a área: de Notas de uma para Notas da outra.
  await page.goto(`${base}/#/notas`);
  await page.getByRole('button', { name: 'Buscar na Receita agora' }).waitFor();
  await page.locator('#empresa-ativa').click();
  await page.getByText('2 de 2 empresas').waitFor();
  await page.getByRole('button', { name: /CONSULTORIA FICTICIA LTDA/ }).click();
  await page.locator('#empresa-ativa').getByText('CONSULTORIA FICTICIA LTDA').waitFor();
  assert.match(page.url(), /#\/notas$/, 'continua em Notas depois de trocar de empresa');
  // Escritório: busca de todas as empresas de uma vez (a segunda usa o certificado do escritório, por procuração).
  await page.goto(`${base}/#/empresas`);
  // A lista de empresas começa pelo certificado do escritório, com quantas empresas o usam.
  await page.getByRole('link', { name: /Certificado do escritório \(procuração\).*1 de 2 empresas por procuração/ }).waitFor();
  await page.getByRole('button', { name: 'Buscar notas de todas na Receita' }).click();
  await page.getByText(/Última busca em todas as empresas/).waitFor();
  // Procuração em várias empresas de uma vez, na tela do certificado do escritório.
  await page.goto(`${base}/#/procurador`);
  await page.getByRole('heading', { name: 'Empresas atendidas por procuração' }).waitFor();
  // A consulta deu certo: a tela mostra que a Receita aceitou a procuração da empresa.
  await page.getByText(/Aceita pela Receita na consulta de/).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: /CONSULTORIA FICTICIA LTDA/ }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: /EMPRESA FICTICIA SMOKE MEI/ }).isChecked(), false);
  // "Conferir todas na Receita" leva à lista de empresas, que acompanha a consulta.
  await page.getByRole('button', { name: 'Conferir todas na Receita' }).click();
  await page.getByText(/Última busca em todas as empresas|Consultando a Receita/).first().waitFor();
  assert.match(page.url(), /#\/empresas$/);
  await page.goto(`${base}/#/empresas`);
  await page.getByRole('button', { name: /EMPRESA FICTICIA SMOKE MEI/ }).click();
  await page.locator('#empresa-ativa').getByText('EMPRESA FICTICIA SMOKE MEI').waitFor();

  // Conectado no aparelho: a saída fica à vista no Início e volta à tela de usuário e senha.
  await page.goto(`${base}/#/`);
  await page.getByText('Conectado como 529.982.247-25').waitFor();
  await page.getByRole('button', { name: 'Sair da conta', exact: true }).click();
  await page.getByLabel('CPF, CNPJ ou e-mail').waitFor();
  // Esqueci a senha: troca com o código de recuperação (sem e-mail) e recebe um código novo.
  await page.getByRole('link', { name: 'Esqueci a minha senha' }).click();
  await page.getByRole('heading', { name: 'Tenho o código de recuperação' }).waitFor();
  await page.getByLabel('CPF, CNPJ ou e-mail da conta').first().fill('529.982.247-25');
  await page.getByLabel('Código de recuperação', { exact: true }).fill(codigoA.toLowerCase());
  await page.getByLabel(/^Nova senha/).last().fill('senha-nova-smoke');
  await page.getByLabel(/^Repita a nova senha/).last().fill('senha-nova-smoke');
  await page.getByRole('button', { name: 'Trocar a senha com o código' }).click();
  await page.getByText('Senha alterada.').waitFor();
  const codigoNovo = (await page.locator('#novo-codigo').innerText()).trim();
  assert.ok(codigoNovo && codigoNovo !== codigoA, 'o código usado deixa de valer e um novo é mostrado');
  await page.goto(base);
  // Volta entrando com o CPF como usuário e a senha nova: com duas empresas, cai na lista.
  await page.getByLabel('CPF, CNPJ ou e-mail').fill('52998224725');
  await page.getByLabel(/^Senha/).fill('senha-nova-smoke');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.getByText('2 de 2 empresas').waitFor();
  await page.getByRole('button', { name: 'Sair da conta', exact: true }).click();
  await page.getByRole('button', { name: 'Fazer primeiro acesso' }).click();
  await page.getByLabel(/^E-mail/).fill('smoke-b@example.invalid');
  await page.getByLabel(/^Senha/).fill('senha-segura-1');
  await page.getByLabel(/^Repita a senha/).fill('senha-segura-1');
  await page.getByRole('button', { name: 'Criar acesso', exact: true }).click();
  await page.getByLabel('Guardei o código em lugar seguro.').check();
  await page.getByRole('button', { name: /Guardei o código — continuar/ }).click();
  await page.getByLabel('CNPJ da empresa').waitFor();
  const draftsB = await page.evaluate(async () => (await import('/js/store.js')).rascunhosLocais());
  assert.equal(draftsB.length, 0, 'B não pode ver o draft de A');
  // Ao voltar à empresa A o rascunho local foi sincronizado — sempre no ambiente de A.
  const dono = await app.ctx.db.get('SELECT u.email FROM notas n JOIN prestadores p ON p.id = n.prestador_id JOIN usuarios u ON u.id = p.usuario_id WHERE n.id = ?', idLocal);
  assert.ok(!dono || dono.email === 'smoke-a@example.invalid', 'rascunho de A nunca vai para B');
  await page.goto(`${base}/#/conta`);
  await page.getByLabel('Confirme sua senha para excluir').fill('senha-segura-1');
  await page.locator('#exclusao-confirmada').check();
  await page.getByRole('button', { name: 'Excluir minha conta e dados' }).click();
  await page.getByRole('button', { name: 'Fazer primeiro acesso' }).waitFor();
  await page.goto(`${base}/privacidade.html`);
  await page.getByText('Responsável fictício de teste', { exact: false }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.violacoesCsp), []);
  assert.deepEqual(erros, []);
  console.log('Smoke web aprovado: primeiro acesso e login por CPF, emissão assistida pelo Emissor Nacional, procuração eletrônica, cadastro pelo CNPJ, A1, várias empresas, notas tomadas, revisão/emissão simulada, XML/PDF, painel do Início, lista por mês e exportação CSV, notas emitidas fora do app e canceladas no portal, troca de empresa na mesma área, busca de todas as empresas, isolamento A/B, exclusão e privacidade; CSP ativa.');
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
