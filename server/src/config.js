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
  bancoArquivo: process.env.NOTAVEZ_DB || (dev ? ':memory:' : './notavez.db'),
  // 'producao_restrita' (homologação) é o padrão. Produção só com liberação explícita.
  ambientePadrao: 'producao_restrita',
  producaoLiberada: process.env.NOTAVEZ_PRODUCAO_LIBERADA === '1',
  servirWeb: process.env.NOTAVEZ_SERVIR_WEB !== '0',
  cookieSeguro: !dev,
  versaoAplicativo: 'NotaSemStress-0.1.0',
  // Série da DPS: faixa 00001–49999 é reservada a "aplicativo próprio" (Anexo I, leiaute campo serie).
  serieDpsPadrao: '1',
  // Tempo mínimo entre um envio incerto e o reenvio (evita corrida com o processamento).
  esperaAntesDeReenviarMs: Number(process.env.NOTAVEZ_ESPERA_REENVIO_MS ?? 60_000),
  timeoutSefinMs: Number(process.env.NOTAVEZ_TIMEOUT_SEFIN_MS ?? 30_000),
};
