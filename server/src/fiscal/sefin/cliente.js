// Cliente HTTP da Sefin Nacional (API do Emissor Público Nacional), com TLS
// mútuo usando o certificado A1 do emitente. Cada resposta é classificada de
// forma conservadora: só dizemos "emitida" com chave de acesso oficial, e
// qualquer dúvida sobre o processamento vira "incerta" (consultar antes de reenviar).
import https from 'node:https';
import { gzipSync, gunzipSync } from 'node:zlib';

const gz64 = (txt) => gzipSync(Buffer.from(txt, 'utf8')).toString('base64');
const ungz64 = (b64) => gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');

// Erros de rede que garantem que a requisição não foi processada.
const ANTES_DO_ENVIO = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

function pegar(obj, ...chaves) {
  for (const k of chaves) if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

export function lerMensagens(corpo) {
  const lista = pegar(corpo, 'erros', 'Erros', 'erro', 'Erro') ?? [];
  return (Array.isArray(lista) ? lista : [lista]).map((m) => ({
    codigo: String(pegar(m, 'codigo', 'Codigo') ?? 'SEM_CODIGO'),
    descricao: String(pegar(m, 'descricao', 'Descricao') ?? ''),
    complemento: pegar(m, 'complemento', 'Complemento') ?? null,
  })).filter((m) => m.codigo !== 'SEM_CODIGO' || m.descricao);
}

export function criarClienteSefin({ baseUrl, chavePem, certPem, cadeiaPem = [], ca, timeoutMs = 30_000 }) {
  const agente = new https.Agent({ key: chavePem, cert: [certPem, ...cadeiaPem].join('\n'), ca, keepAlive: true, maxSockets: 4 });
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);

  function requisitar(metodo, caminho, corpo) {
    return new Promise((resolve) => {
      const url = new URL(caminho.replace(/^\//, ''), base);
      const dados = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
      let conectado = false;
      const inicio = Date.now();
      const req = https.request(url, {
        method: metodo,
        agent: agente,
        headers: { Accept: 'application/json', ...(dados ? { 'Content-Type': 'application/json', 'Content-Length': dados.length } : {}) },
        timeout: timeoutMs,
      }, (res) => {
        const partes = [];
        res.on('data', (c) => partes.push(c));
        res.on('end', () => {
          const texto = Buffer.concat(partes).toString('utf8');
          let json = null;
          try { json = texto ? JSON.parse(texto) : null; } catch { /* corpo não-JSON */ }
          resolve({ status: res.statusCode, json, texto, ms: Date.now() - inicio });
        });
        res.on('error', (e) => resolve({ erroRede: e, conectado: true, ms: Date.now() - inicio }));
      });
      req.on('socket', (s) => {
        if (!s.connecting && s.encrypted) conectado = true; // socket reaproveitado (keep-alive)
        s.once('secureConnect', () => { conectado = true; });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('Tempo de resposta esgotado'), { code: 'ETIMEDOUT' })));
      req.on('error', (e) => resolve({ erroRede: e, conectado, ms: Date.now() - inicio }));
      if (dados) req.write(dados);
      req.end();
    });
  }

  return {
    /** POST /nfse — envia a DPS assinada (GZip + Base64). */
    async enviarDps(xmlAssinado) {
      const r = await requisitar('POST', '/nfse', { dpsXmlGZipB64: gz64(xmlAssinado) });
      const base = { http: r.status ?? null, ms: r.ms };
      if (r.erroRede) {
        const certo = !r.conectado && (ANTES_DO_ENVIO.has(r.erroRede.code) || /SSL|TLS|CERT|EPROTO/i.test(`${r.erroRede.code} ${r.erroRede.message}`));
        return certo
          ? { ...base, tipo: 'nao_enviada', motivo: 'conexao', detalhe: r.erroRede.code || r.erroRede.message }
          : { ...base, tipo: 'incerta', motivo: 'rede', detalhe: r.erroRede.code || r.erroRede.message };
      }
      const chave = pegar(r.json, 'chaveAcesso', 'ChaveAcesso');
      const xmlB64 = pegar(r.json, 'nfseXmlGZipB64', 'NfseXmlGZipB64');
      if (r.status >= 200 && r.status < 300) {
        if (chave && xmlB64) {
          return { ...base, tipo: 'emitida', chaveAcesso: String(chave), nfseXml: ungz64(xmlB64), alertas: lerMensagens({ erros: pegar(r.json, 'alertas', 'Alertas') ?? [] }) };
        }
        return { ...base, tipo: 'incerta', motivo: 'resposta_incompleta' };
      }
      if (r.status === 401 || r.status === 403) return { ...base, tipo: 'nao_enviada', motivo: 'autorizacao' };
      if (r.status === 429) return { ...base, tipo: 'nao_enviada', motivo: 'limite' };
      if (r.status >= 400 && r.status < 500) {
        const erros = lerMensagens(r.json);
        if (!erros.length) return { ...base, tipo: 'nao_enviada', motivo: 'requisicao', detalhe: r.texto?.slice(0, 300) };
        if (erros.some((e) => e.codigo === 'E0014')) return { ...base, tipo: 'duplicada', erros };
        return { ...base, tipo: 'rejeitada', erros };
      }
      return { ...base, tipo: 'incerta', motivo: `http_${r.status}` };
    },

    /** GET /dps/{id} — descobre se a DPS já gerou NFS-e (retorna a chave). */
    async consultarDps(idDps) {
      const r = await requisitar('GET', `/dps/${encodeURIComponent(idDps)}`);
      const base = { http: r.status ?? null, ms: r.ms };
      if (r.erroRede) return { ...base, tipo: 'falha', detalhe: r.erroRede.code || r.erroRede.message };
      const chave = pegar(r.json, 'chaveAcesso', 'ChaveAcesso');
      if (r.status === 200 && chave) return { ...base, tipo: 'encontrada', chaveAcesso: String(chave) };
      if (r.status === 404) return { ...base, tipo: 'nao_encontrada' };
      return { ...base, tipo: 'falha', detalhe: `http_${r.status}` };
    },

    /** GET /nfse/{chaveAcesso} — XML oficial da NFS-e. */
    async consultarNfse(chaveAcesso) {
      const r = await requisitar('GET', `/nfse/${encodeURIComponent(chaveAcesso)}`);
      const base = { http: r.status ?? null, ms: r.ms };
      if (r.erroRede) return { ...base, tipo: 'falha', detalhe: r.erroRede.code || r.erroRede.message };
      const xmlB64 = pegar(r.json, 'nfseXmlGZipB64', 'NfseXmlGZipB64');
      if (r.status === 200 && xmlB64) return { ...base, tipo: 'ok', nfseXml: ungz64(xmlB64) };
      if (r.status === 404) return { ...base, tipo: 'nao_encontrada' };
      return { ...base, tipo: 'falha', detalhe: `http_${r.status}` };
    },

    fechar: () => agente.destroy(),
  };
}
