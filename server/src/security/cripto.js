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
