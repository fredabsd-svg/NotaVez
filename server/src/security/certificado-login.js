// Entrar com certificado digital ICP-Brasil (e-CPF ou e-CNPJ, A1 ou A3).
//
// O navegador só apresenta o certificado durante o aperto de mão TLS, então
// quem pede o certificado é o proxy HTTPS (Caddy/nginx), num host próprio
// (ex.: certificado.seudominio.com.br). O proxy repassa ao app o certificado
// do cliente e um segredo compartilhado; o app confere:
//   1. o segredo do proxy (ninguém de fora injeta um certificado);
//   2. a cadeia até uma AC Raiz da ICP-Brasil (arquivo oficial do ITI);
//   3. a validade e a política ICP-Brasil (OID 2.16.76.1.2.*);
//   4. o CPF (OID 2.16.76.1.3.1) ou o CNPJ (2.16.76.1.3.3) do titular.
// A posse da chave privada é provada pelo próprio TLS. A chave privada nunca
// chega ao app: este login não serve para assinar notas (a emissão continua
// exigindo o A1 enviado no Perfil).
import { X509Certificate, timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import forge from 'node-forge';

const OID_SAN = '2.5.29.17';
const OID_POLITICAS = '2.5.29.32';
const OID_CPF_PF = '2.16.76.1.3.1';
const OID_CNPJ = '2.16.76.1.3.3';
const PREFIXO_POLITICA_ICP = '2.16.76.1.2.';

export class ErroLoginCertificado extends Error {
  constructor(codigo, mensagem) { super(mensagem); this.codigo = codigo; }
}

/** Lê um ou mais certificados PEM concatenados. */
export function lerPemMultiplo(texto) {
  return (String(texto).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []).map((p) => new X509Certificate(p));
}

// Extensões lidas direto do DER (funciona com chaves RSA e de curva elíptica).
function extensoes(der) {
  const asn = forge.asn1.fromDer(forge.util.createBuffer(der.toString('binary')));
  const tbs = asn.value[0];
  const bloco = tbs.value.find((n) => n.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && n.type === 3);
  const mapa = {};
  for (const ext of bloco?.value?.[0]?.value || []) {
    const oid = forge.asn1.derToOid(ext.value[0].value);
    mapa[oid] = forge.asn1.fromDer(ext.value[ext.value.length - 1].value);
  }
  return mapa;
}

function outrosNomes(san) {
  const achados = {};
  for (const nome of san?.value || []) {
    if (nome.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC || nome.type !== 0) continue;
    const [oidNode, valNode] = nome.value;
    let v = valNode?.value?.[0]?.value;
    if (Array.isArray(v)) v = v.map((x) => x.value).join('');
    achados[forge.asn1.derToOid(oidNode.value)] = String(v ?? '');
  }
  return achados;
}

const politicas = (ext) => (ext?.value || []).map((p) => forge.asn1.derToOid(p.value[0].value));

/** Monta e confere a cadeia leaf → ... → raiz, usando só certificados do pacote confiável. */
function conferirCadeia(folha, confiaveis, agora) {
  const valido = (c) => new Date(c.validFrom) <= agora && agora <= new Date(c.validTo);
  let atual = folha;
  for (let profundidade = 0; profundidade < 8; profundidade += 1) {
    if (!valido(atual)) throw new ErroLoginCertificado('cadeia_vencida', 'O certificado (ou a autoridade que o emitiu) está fora da validade.');
    const emissor = confiaveis.find((ca) => atual.checkIssued(ca) && atual.verify(ca.publicKey));
    if (!emissor) throw new ErroLoginCertificado('cadeia_desconhecida', 'O certificado não foi emitido por uma autoridade da ICP-Brasil.');
    if (emissor.ca === false) throw new ErroLoginCertificado('cadeia_desconhecida', 'Cadeia de certificação inválida.');
    // Raiz: autoassinada e presente no pacote oficial.
    if (emissor.checkIssued(emissor) && emissor.verify(emissor.publicKey)) {
      if (!valido(emissor)) throw new ErroLoginCertificado('cadeia_vencida', 'A autoridade raiz está fora da validade.');
      return;
    }
    atual = emissor;
  }
  throw new ErroLoginCertificado('cadeia_desconhecida', 'Cadeia de certificação longa demais.');
}

/** Lê o certificado do titular e devolve a identidade comprovada (CPF ou CNPJ). */
export function identidadeDoCertificado(folha, confiaveis, agora = new Date()) {
  if (folha.ca) throw new ErroLoginCertificado('nao_titular', 'Apresente o certificado da pessoa ou da empresa, não o de uma autoridade certificadora.');
  conferirCadeia(folha, confiaveis, agora);
  const ext = extensoes(folha.raw);
  if (!politicas(ext[OID_POLITICAS]).some((p) => p.startsWith(PREFIXO_POLITICA_ICP))) {
    throw new ErroLoginCertificado('politica', 'Este certificado não segue uma política da ICP-Brasil.');
  }
  const nomes = outrosNomes(ext[OID_SAN]);
  const cnpj = nomes[OID_CNPJ] ? nomes[OID_CNPJ].toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 14) : null;
  // Dados do titular PF: data de nascimento (8) + CPF (11) + ...
  const cpf = nomes[OID_CPF_PF] ? nomes[OID_CPF_PF].replace(/\D/g, '').slice(8, 19) : null;
  if (cnpj && /^[0-9A-Z]{12}\d{2}$/.test(cnpj)) return { tipoDocumento: 'CNPJ', documento: cnpj };
  if (cpf && /^\d{11}$/.test(cpf)) return { tipoDocumento: 'CPF', documento: cpf };
  throw new ErroLoginCertificado('sem_documento', 'Não encontramos CPF nem CNPJ no certificado.');
}

/** Converte o cabeçalho do proxy (DER em base64, ou PEM codificado para URL) em certificado. */
export function certificadoDoCabecalho(valor) {
  if (typeof valor !== 'string' || !valor || valor.length > 20_000) throw new ErroLoginCertificado('sem_certificado', 'Nenhum certificado foi apresentado.');
  const texto = valor.startsWith('-----') || valor.startsWith('%2D') ? decodeURIComponent(valor) : null;
  try {
    return texto ? new X509Certificate(texto) : new X509Certificate(Buffer.from(valor, 'base64'));
  } catch { throw new ErroLoginCertificado('certificado_ilegivel', 'Não foi possível ler o certificado apresentado.'); }
}

export function criarLoginCertificado({ origem, segredoProxy, cadeiasArquivo, cadeiasPem }) {
  if (!origem || !/^https:\/\//.test(origem) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origem)) throw new Error('Login com certificado: NOTAVEZ_CERT_LOGIN_ORIGEM precisa ser HTTPS.');
  if (!segredoProxy || segredoProxy.length < 32) throw new Error('Login com certificado: NOTAVEZ_CERT_PROXY_SEGREDO precisa ter 32 caracteres ou mais.');
  const confiaveis = lerPemMultiplo(cadeiasPem ?? (cadeiasArquivo ? readFileSync(cadeiasArquivo, 'utf8') : ''));
  if (!confiaveis.length) throw new Error('Login com certificado: configure NOTAVEZ_ICP_CADEIAS com as cadeias oficiais da ICP-Brasil.');
  const segredoHash = createHash('sha256').update(segredoProxy).digest();
  return {
    origem: origem.replace(/\/$/, ''),
    /** Confere o segredo do proxy e o certificado repassado por ele. */
    identidade(headers, agora = new Date()) {
      const recebido = createHash('sha256').update(String(headers['x-notavez-proxy'] || '')).digest();
      if (!timingSafeEqual(recebido, segredoHash)) throw new ErroLoginCertificado('proxy', 'Acesso recusado.');
      return identidadeDoCertificado(certificadoDoCabecalho(headers['x-certificado-cliente']), confiaveis, agora);
    },
  };
}
