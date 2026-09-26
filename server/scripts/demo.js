// MODO DEMONSTRAÇÃO: sobe o Nota Sem Stress com uma Receita SIMULADA local, para
// conhecer o app e testar a interface sem certificado real. Nenhuma nota real
// é emitida — o app mostra um aviso permanente em todas as telas.
//   npm run demo   → http://localhost:8080
process.env.NOTAVEZ_DEV = '1';
process.env.NOTAVEZ_DEMO = '1';
process.env.NOTAVEZ_ESPERA_REENVIO_MS ??= '5000';

const { writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { gerarCertificadoTeste } = await import('../test/apoio/certificado-teste.js');
const { iniciarSefinSimulada } = await import('../test/apoio/sefin-simulada.js');
const { criarApp } = await import('../src/app.js');
const { criarClienteSefin } = await import('../src/fiscal/sefin/cliente.js');
const { ambientesSefin, config } = await import('../src/config.js');

const cnpj = process.env.DEMO_CNPJ || '11222333000181';
const cert = gerarCertificadoTeste({ cnpj, senha: 'demo1234', nome: 'MEI DEMONSTRACAO' });
const arquivo = join(tmpdir(), 'notavez-certificado-DEMO.pfx');
writeFileSync(arquivo, cert.pfx);

const sefin = await iniciarSefinSimulada({ caPem: cert.caPem, caChavePem: cert.caChavePem, certClientePem: cert.certPem });
ambientesSefin.producao_restrita.sefin = sefin.baseUrl;
ambientesSefin.producao_restrita.parametros = sefin.baseParametros;
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
`);
