// MODO DEMONSTRAÇÃO: sobe o Nota Sem Stress com uma Receita SIMULADA local, para
// conhecer o app e testar a interface sem certificado real. Nenhuma nota real
// é emitida — o app mostra um aviso permanente em todas as telas.
//   npm run demo   → http://localhost:8080
process.env.NOTAVEZ_DEV = '1';
process.env.NOTAVEZ_DEMO = '1';
process.env.NOTAVEZ_ESPERA_REENVIO_MS ??= '5000';

const { writeFileSync, readFileSync, existsSync, mkdirSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { randomBytes } = await import('node:crypto');

// Dados da demonstração ficam em server/dados-demo/ (fora do git): contas, senhas, empresas e
// certificados continuam depois de reiniciar. Para começar do zero, apague essa pasta.
const pastaDados = process.env.NOTAVEZ_DEMO_DADOS || join(new URL('..', import.meta.url).pathname, 'dados-demo');
mkdirSync(pastaDados, { recursive: true, mode: 0o700 });
const arquivoChave = join(pastaDados, 'chave-demo.txt');
if (!process.env.NOTAVEZ_MASTER_KEY) {
  if (!existsSync(arquivoChave)) writeFileSync(arquivoChave, randomBytes(32).toString('base64'), { mode: 0o600 });
  process.env.NOTAVEZ_MASTER_KEY = readFileSync(arquivoChave, 'utf8').trim();
}
// Banco Postgres embutido (PGlite) numa pasta: continua depois de reiniciar.
process.env.NOTAVEZ_DB ??= join(pastaDados, 'banco');
const { gerarCertificadoTeste } = await import('../test/apoio/certificado-teste.js');
const { iniciarSefinSimulada } = await import('../test/apoio/sefin-simulada.js');
const { criarApp } = await import('../src/app.js');
const { criarClienteSefin } = await import('../src/fiscal/sefin/cliente.js');
const { ambientesSefin, config } = await import('../src/config.js');

const cnpj = process.env.DEMO_CNPJ || '11222333000181';
// O certificado fictício (e a "Receita" simulada que confia nele) também é reaproveitado:
// o A1 enviado numa execução continua valendo na próxima.
const arquivoCert = join(pastaDados, `certificado-demo-${cnpj}.json`);
let cert;
try {
  const c = JSON.parse(readFileSync(arquivoCert, 'utf8'));
  cert = { ...c, pfx: Buffer.from(c.pfx, 'base64') };
} catch {
  cert = gerarCertificadoTeste({ cnpj, senha: 'demo1234', nome: 'MEI DEMONSTRACAO' });
  writeFileSync(arquivoCert, JSON.stringify({ ...cert, pfx: cert.pfx.toString('base64') }), { mode: 0o600 });
}
const arquivo = join(tmpdir(), 'notavez-certificado-DEMO.pfx');
writeFileSync(arquivo, cert.pfx);

const sefin = await iniciarSefinSimulada({ caPem: cert.caPem, caChavePem: cert.caChavePem, certClientePem: cert.certPem });
ambientesSefin.producao_restrita.sefin = sefin.baseUrl;
ambientesSefin.producao_restrita.parametros = sefin.baseParametros;
ambientesSefin.producao_restrita.adn = sefin.baseAdn;
// Notas que fornecedores "emitiram" para o CNPJ de demonstração (aba Tomadas).
sefin.adicionarTomada({ tomador: cnpj, nome: 'CONTABILIDADE EXEMPLO LTDA', valor: '450.00', descricao: 'Honorários contábeis de setembro/2026', cTribNac: '171901' });
sefin.adicionarTomada({ tomador: cnpj, prestador: '11222333000262', nome: 'SUPORTE DE TI EXEMPLO ME', valor: '1200.00', descricao: 'Suporte técnico em informática', cTribNac: '010701', issRetido: true });
const cancelada = sefin.adicionarTomada({ tomador: cnpj, nome: 'LIMPEZA EXEMPLO EIRELI', valor: '300.00', descricao: 'Limpeza de escritório', cTribNac: '071002' });
sefin.cancelarTomada(cancelada.chave);
ambientesSefin.producao_restrita.consultaPublica = null; // não há consulta pública para notas simuladas
const app = await criarApp({ logger: false, fabricaCliente: (o) => criarClienteSefin({ ...o, ca: sefin.ca }) });
app.ctx.sefinSimulada = sefin; // permite forçar cenários: POST /api/demo/cenario
app.post('/api/demo/cenario', async (req) => { sefin.estado.cenario.push(String(req.body?.cenario)); return { fila: sefin.estado.cenario }; });
await app.listen({ port: config.porta, host: config.host });
console.log(`
  Nota Sem Stress — MODO DEMONSTRAÇÃO (Receita simulada; nada é enviado à Receita)
  App:         http://localhost:${config.porta}
  CNPJ:        ${cnpj}   (use no Perfil — MEI ou ME/EPP)
  Certificado: ${arquivo}   senha: demo1234   (FICTÍCIO)
  Dados:       ${pastaDados}   (contas e empresas continuam depois de reiniciar)
`);
