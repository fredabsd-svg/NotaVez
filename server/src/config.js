// Configuração central. Tudo que muda entre ambientes vem de variáveis de
// ambiente; endereços da API oficial ficam em fiscal/sefin/ambientes.json.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const dev = process.env.NOTAVEZ_DEV === '1' || process.env.NODE_ENV === 'test';

function chaveMestra() {
  const b64 = process.env.NOTAVEZ_MASTER_KEY;
  if (b64) {
    const k = Buffer.from(b64, 'base64');
    if (k.length !== 32) throw new Error('NOTAVEZ_MASTER_KEY deve ter 32 bytes em base64 (npm run gerar-chave).');
    return k;
  }
  if (!dev) throw new Error('Defina NOTAVEZ_MASTER_KEY (npm run gerar-chave). Ela protege certificados e dados de clientes.');
  // Em desenvolvimento, uma chave efêmera: dados cifrados não sobrevivem a reinícios.
  return randomBytes(32);
}

// Ambiente de operação. Num servidor de verdade as notas são reais: a produção é o padrão, e
// NOTAVEZ_PRODUCAO_LIBERADA=0 prende o servidor ao ambiente de testes da Receita (produção restrita).
// Em desenvolvimento e nos testes automatizados a produção só abre com NOTAVEZ_PRODUCAO_LIBERADA=1;
// na demonstração (Receita simulada), nunca: uma simulação não pode se passar por nota real.
export function producaoLiberadaEm({ variavel, dev: emDev = false, demo = false } = {}) {
  if (demo) return false;
  if (variavel === '1') return true;
  if (variavel === '0') return false;
  return !emDev;
}

export const ambientesSefin = JSON.parse(
  readFileSync(new URL('./fiscal/sefin/ambientes.json', import.meta.url), 'utf8'),
);

let _chave;
export const config = {
  // Lida só quando usada (scripts que não guardam dados não precisam dela).
  get chaveMestra() { return (_chave ??= chaveMestra()); },
  dev,
  demo: process.env.NOTAVEZ_DEMO === '1',
  porta: Number(process.env.PORT || 8080),
  host: process.env.HOST || '0.0.0.0',
  // Confie somente nos endereços/CIDRs do proxy efetivamente controlado.
  proxiesConfiaveis: process.env.NOTAVEZ_PROXIES_CONFIAVEIS?.split(',').map((s) => s.trim()).filter(Boolean) || false,
  contaPublica: {
    responsavel: process.env.NOTAVEZ_RESPONSAVEL || '',
    contatoPrivacidade: process.env.NOTAVEZ_CONTATO_PRIVACIDADE || '',
    retencao: process.env.NOTAVEZ_RETENCAO || '',
  },
  assetlinksArquivo: process.env.NOTAVEZ_ASSETLINKS_FILE || '',
  // Entrar com gov.br (Login Único): credenciais concedidas pelo governo para a URL de retorno
  // (…/api/conta/govbr/retorno). Sem elas, o botão gov.br não aparece.
  govbr: {
    clientId: process.env.NOTAVEZ_GOVBR_CLIENT_ID || '',
    clientSecret: process.env.NOTAVEZ_GOVBR_CLIENT_SECRET || '',
    redirectUri: process.env.NOTAVEZ_GOVBR_REDIRECT_URI || '',
    base: process.env.NOTAVEZ_GOVBR_AMBIENTE === 'staging' ? 'https://sso.staging.acesso.gov.br' : 'https://sso.acesso.gov.br',
  },
  bancoArquivo: process.env.NOTAVEZ_DB || (dev ? ':memory:' : './notavez.db'),
  // Produção (notas reais) é o padrão do servidor; ver producaoLiberadaEm. A empresa nova nasce no
  // ambiente padrão: produção quando liberada, senão o ambiente de testes da Receita (produção restrita).
  producaoLiberada: producaoLiberadaEm({ variavel: process.env.NOTAVEZ_PRODUCAO_LIBERADA, dev, demo: process.env.NOTAVEZ_DEMO === '1' }),
  get ambientePadrao() { return this.producaoLiberada ? 'producao' : 'producao_restrita'; },
  // De quantas em quantas horas o servidor busca na Receita (ADN) as notas tomadas e as emitidas fora
  // do app, de todas as empresas com certificado válido. 0 desliga (a busca fica só pelos botões).
  sincronizacaoHoras: (() => { const h = Number(process.env.NOTAVEZ_SINCRONIZACAO_HORAS ?? 6); return Number.isFinite(h) && h > 0 ? Math.max(1, h) : 0; })(),
  servirWeb: process.env.NOTAVEZ_SERVIR_WEB !== '0',
  cookieSeguro: !dev,
  versaoAplicativo: 'NotaSemStress-0.1.0',
  // Série da DPS: faixa 00001–49999 é reservada a "aplicativo próprio" (Anexo I, leiaute campo serie).
  serieDpsPadrao: '1',
  // Tempo mínimo entre um envio incerto e o reenvio (evita corrida com o processamento).
  esperaAntesDeReenviarMs: Number(process.env.NOTAVEZ_ESPERA_REENVIO_MS ?? 60_000),
  timeoutSefinMs: Number(process.env.NOTAVEZ_TIMEOUT_SEFIN_MS ?? 30_000),
};
