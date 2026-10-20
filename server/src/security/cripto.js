// Criptografia de dados em repouso (AES-256-GCM) e índices cegos (HMAC) para
// buscar CPF/CNPJ sem guardá-los em claro. Em produção, a chave mestra deve
// vir de um KMS/HSM; aqui ela chega por variável de ambiente.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual, hkdfSync } from 'node:crypto';
import { config } from '../config.js';

const derivar = (uso) => Buffer.from(hkdfSync('sha256', config.chaveMestra, Buffer.alloc(0), `notavez:${uso}`, 32));
let _dados; let _indice;
const chaveDados = () => (_dados ??= derivar('dados'));
const chaveIndice = () => (_indice ??= derivar('indice'));

export function cifrar(valor) {
  if (valor === null || valor === undefined) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', chaveDados(), iv);
  const bruto = Buffer.isBuffer(valor) ? valor : Buffer.from(typeof valor === 'string' ? valor : JSON.stringify(valor), 'utf8');
  const enc = Buffer.concat([c.update(bruto), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), enc]).toString('base64');
}

export function decifrarBuffer(texto) {
  if (!texto) return null;
  const b = Buffer.from(texto, 'base64');
  if (b[0] !== 1) throw new Error('Formato de dado cifrado desconhecido');
  const d = createDecipheriv('aes-256-gcm', chaveDados(), b.subarray(1, 13));
  d.setAuthTag(b.subarray(13, 29));
  return Buffer.concat([d.update(b.subarray(29)), d.final()]);
}

export const decifrar = (texto) => (texto ? decifrarBuffer(texto).toString('utf8') : null);
export const decifrarJson = (texto) => (texto ? JSON.parse(decifrar(texto)) : null);

export const indiceCego = (valor) => createHmac('sha256', chaveIndice()).update(String(valor)).digest('base64url');

export function hashSenha(senha) {
  const sal = randomBytes(16);
  const h = scryptSync(senha, sal, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${sal.toString('base64')}$${h.toString('base64')}`;
}

export function conferirSenha(senha, armazenado) {
  const [alg, sal, h] = String(armazenado).split('$');
  if (alg !== 'scrypt') return false;
  const calc = scryptSync(senha, Buffer.from(sal, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const esperado = Buffer.from(h, 'base64');
  return calc.length === esperado.length && timingSafeEqual(calc, esperado);
}

export const tokenAleatorio = () => randomBytes(32).toString('base64url');
export const hashToken = (t) => createHmac('sha256', chaveIndice()).update(`sessao:${t}`).digest('base64url');

// ---------- Chave própria de cada conta (criptografia em envelope) ----------
// Cada conta tem uma chave de dados aleatória (DEK, 256 bits). Ela fica guardada
// no catálogo central "envelopada" (AES-256-GCM) pela chave de envelope derivada
// da chave mestra. Os dados da conta, que ficam num banco SQLite só dela, são
// cifrados com a DEK e amarrados ao id da conta (AAD). Excluir a conta destrói a
// DEK: o que sobrar em cópias antigas do arquivo fica ilegível.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let _envelope;
const chaveEnvelope = () => (_envelope ??= derivar('envelope-contas'));

export function novaChaveConta(usuarioId) {
  if (!UUID.test(usuarioId)) throw new Error('Identificador de conta inválido.');
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', chaveEnvelope(), iv);
  c.setAAD(Buffer.from(`chave-conta:${usuarioId}`));
  const enc = Buffer.concat([c.update(dek), c.final()]);
  dek.fill(0);
  return `k1.${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
}

export function abrirChaveConta(usuarioId, envelopada) {
  if (!UUID.test(usuarioId) || typeof envelopada !== 'string' || !envelopada.startsWith('k1.')) throw new Error('Chave da conta ausente ou inválida.');
  const b = Buffer.from(envelopada.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', chaveEnvelope(), b.subarray(0, 12));
  d.setAAD(Buffer.from(`chave-conta:${usuarioId}`));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}

// Funções de cifragem presas à chave de UMA conta. O formato (byte 2) e a AAD
// impedem que um dado de uma conta seja lido com a chave de outra.
export function criarCriptoConta(usuarioId, dek) {
  const derivarConta = (uso) => Buffer.from(hkdfSync('sha256', dek, Buffer.alloc(0), `notavez:conta:${uso}`, 32));
  const kDados = derivarConta('dados');
  const kIndice = derivarConta('indice');
  const aad = Buffer.from(`conta:${usuarioId}`);
  const cifrarConta = (valor) => {
    if (valor === null || valor === undefined) return null;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', kDados, iv);
    c.setAAD(aad);
    const bruto = Buffer.isBuffer(valor) ? valor : Buffer.from(typeof valor === 'string' ? valor : JSON.stringify(valor), 'utf8');
    const enc = Buffer.concat([c.update(bruto), c.final()]);
    return Buffer.concat([Buffer.from([2]), iv, c.getAuthTag(), enc]).toString('base64');
  };
  const decifrarBufferConta = (texto) => {
    if (!texto) return null;
    const b = Buffer.from(texto, 'base64');
    if (b[0] !== 2) throw new Error('Dado não pertence ao formato de conta.');
    const d = createDecipheriv('aes-256-gcm', kDados, b.subarray(1, 13));
    d.setAAD(aad);
    d.setAuthTag(b.subarray(13, 29));
    return Buffer.concat([d.update(b.subarray(29)), d.final()]);
  };
  const decifrarConta = (texto) => (texto ? decifrarBufferConta(texto).toString('utf8') : null);
  return Object.freeze({
    usuarioId,
    cifrar: cifrarConta,
    decifrarBuffer: decifrarBufferConta,
    decifrar: decifrarConta,
    decifrarJson: (texto) => (texto ? JSON.parse(decifrarConta(texto)) : null),
    indiceCego: (valor) => createHmac('sha256', kIndice).update(String(valor)).digest('base64url'),
  });
}

// Funções equivalentes com a chave do servidor (catálogo central).
export const criptoCentral = Object.freeze({ cifrar, decifrar, decifrarBuffer, decifrarJson, indiceCego });
