// Arquivo de backup do Nota Sem Stress (.nsbackup): um JSON com cabeçalho legível e conteúdo cifrado.
//
//   { tipo, formato, criadoEm, app, esquema,               ← o que dá para ver sem a senha
//     kdf: { nome: 'scrypt', N, r, p, sal },               ← chave = scrypt(senha, sal)
//     cifra: { nome: 'aes-256-gcm', iv }, compressao: 'gzip',
//     conteudo: { bytes, comprimido, sha256 },             ← SHA-256 do conteúdo decifrado e descompactado
//     verificador,                                         ← HMAC(chave): diz "senha errada" sem decifrar nada
//     tag, dados }                                         ← AES-256-GCM; o cabeçalho inteiro entra como AAD
//
// Integridade em camadas: a tag do GCM autentica o cabeçalho e o conteúdo cifrado (qualquer bit alterado
// é recusado); o SHA-256 confere o conteúdo depois de descompactado; o manifesto interno confere cada tabela.
// A senha nunca é guardada: sem ela, ninguém (nem o servidor) abre o backup.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { ErroApp } from '../util/erros.js';

const scrypt = promisify(scryptCb);

export const TIPO = 'nota-sem-stress/backup';
export const FORMATO = 1;
export const EXTENSAO = '.nsbackup';
export const KDF_PADRAO = Object.freeze({ nome: 'scrypt', N: 2 ** 15, r: 8, p: 1 });
export const SENHA_MINIMA = 10;
export const MAX_ARQUIVO = 150 * 1024 * 1024;   // arquivo inteiro (texto)
export const MAX_CONTEUDO = 400 * 1024 * 1024;  // conteúdo descompactado (abaixo do limite de texto do V8)

export const sha256 = (dados) => createHash('sha256').update(dados).digest('hex');

// JSON com as chaves em ordem: a mesma informação sempre gera os mesmos bytes (hash estável).
export function canonico(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(canonico).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonico(v[k])}`).join(',')}}`;
}

const erro = (status, mensagem, codigo, extra = {}) => new ErroApp(status, mensagem, { codigo, ...extra });
export const CORROMPIDO = 'O arquivo de backup está corrompido, incompleto ou foi alterado. Nada foi mudado nos seus dados.';

export function conferirSenha(senha) {
  if (typeof senha !== 'string' || [...senha.normalize('NFC')].length < SENHA_MINIMA) {
    throw erro(422, `A senha do backup precisa ter pelo menos ${SENHA_MINIMA} caracteres.`, 'BACKUP_SENHA_CURTA');
  }
}

async function derivar(senha, kdf) {
  return await scrypt(senha.normalize('NFC'), Buffer.from(kdf.sal, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}
const verificadorDe = (chave) => createHmac('sha256', chave).update(`${TIPO}:senha`).digest().subarray(0, 16).toString('base64');
const aad = (cab) => Buffer.from(canonico(cab), 'utf8');

// Cifra o conteúdo (texto JSON) com a senha e devolve o arquivo pronto (texto ASCII) e o SHA-256 dele.
export async function criarArquivo(conteudo, senha, { criadoEm, app, esquema }) {
  conferirSenha(senha);
  const bruto = Buffer.from(conteudo, 'utf8');
  if (bruto.length > MAX_CONTEUDO) throw erro(413, 'Os dados desta conta passam do tamanho máximo de um backup.', 'BACKUP_GRANDE');
  const comprimido = gzipSync(bruto, { level: 6 });
  const kdf = { ...KDF_PADRAO, sal: randomBytes(16).toString('base64') };
  const iv = randomBytes(12);
  const chave = await derivar(senha, kdf);
  const cab = {
    tipo: TIPO, formato: FORMATO, criadoEm, app, esquema, kdf,
    cifra: { nome: 'aes-256-gcm', iv: iv.toString('base64') }, compressao: 'gzip',
    conteudo: { bytes: bruto.length, comprimido: comprimido.length, sha256: sha256(bruto) },
    verificador: verificadorDe(chave),
  };
  const c = createCipheriv('aes-256-gcm', chave, iv);
  c.setAAD(aad(cab));
  const dados = Buffer.concat([c.update(comprimido), c.final()]);
  const texto = JSON.stringify({ ...cab, tag: c.getAuthTag().toString('base64'), dados: dados.toString('base64') });
  if (texto.length > MAX_ARQUIVO) throw erro(413, 'O backup ficou maior que o tamanho máximo aceito.', 'BACKUP_GRANDE');
  return { texto, bytes: texto.length, sha256: sha256(texto), cabecalho: cab };
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const ehB64 = (s, bytes) => typeof s === 'string' && B64.test(s) && (bytes === undefined || Buffer.from(s, 'base64').length === bytes);

// Só o cabeçalho (sem a senha): diz se é um backup nosso, de que versão e se a estrutura está inteira.
export function lerCabecalho(texto) {
  if (typeof texto !== 'string' || !texto.length) throw erro(422, CORROMPIDO, 'BACKUP_CORROMPIDO');
  if (texto.length > MAX_ARQUIVO) throw erro(413, 'O arquivo passa do tamanho máximo de um backup.', 'BACKUP_GRANDE');
  let obj;
  try { obj = JSON.parse(texto); } catch {
    throw erro(422, texto.startsWith(`{"tipo":"${TIPO}"`) ? CORROMPIDO : 'Este arquivo não é um backup do Nota Sem Stress.', texto.startsWith(`{"tipo":"${TIPO}"`) ? 'BACKUP_CORROMPIDO' : 'BACKUP_DESCONHECIDO');
  }
  if (!obj || typeof obj !== 'object' || obj.tipo !== TIPO) throw erro(422, 'Este arquivo não é um backup do Nota Sem Stress.', 'BACKUP_DESCONHECIDO');
  if (!Number.isInteger(obj.formato)) throw erro(422, CORROMPIDO, 'BACKUP_CORROMPIDO');
  if (obj.formato > FORMATO) {
    throw erro(422, `Este backup foi feito por uma versão mais nova do aplicativo (formato ${obj.formato}). Atualize o aplicativo para restaurá-lo.`, 'BACKUP_VERSAO_NOVA');
  }
  if (obj.formato < 1) throw erro(422, 'Formato de backup desconhecido.', 'BACKUP_DESCONHECIDO');
  const { tag, dados, ...cab } = obj;
  const k = cab.kdf;
  const ok = k && k.nome === 'scrypt' && [2 ** 14, 2 ** 15, 2 ** 16, 2 ** 17].includes(k.N) && k.r === 8 && k.p === 1 && ehB64(k.sal, 16)
    && cab.cifra?.nome === 'aes-256-gcm' && ehB64(cab.cifra.iv, 12) && cab.compressao === 'gzip'
    && Number.isInteger(cab.conteudo?.bytes) && cab.conteudo.bytes >= 0 && cab.conteudo.bytes <= MAX_CONTEUDO
    && Number.isInteger(cab.conteudo.comprimido) && /^[0-9a-f]{64}$/.test(cab.conteudo.sha256 || '')
    && ehB64(cab.verificador, 16) && ehB64(tag, 16) && ehB64(dados) && typeof cab.criadoEm === 'string' && Number.isInteger(cab.esquema);
  if (!ok) throw erro(422, CORROMPIDO, 'BACKUP_CORROMPIDO');
  const cifrado = Buffer.from(dados, 'base64');
  if (cifrado.length !== cab.conteudo.comprimido) throw erro(422, CORROMPIDO, 'BACKUP_CORROMPIDO');
  return { cabecalho: cab, tag: Buffer.from(tag, 'base64'), cifrado };
}

// Abre o arquivo com a senha: senha errada e arquivo corrompido são recusados com mensagens diferentes.
export async function abrirArquivo(texto, senha) {
  if (typeof senha !== 'string' || !senha) throw erro(422, 'Informe a senha do backup.', 'BACKUP_SENHA');
  const { cabecalho: cab, tag, cifrado } = lerCabecalho(texto);
  const chave = await derivar(senha, cab.kdf);
  const esperado = Buffer.from(cab.verificador, 'base64');
  if (!timingSafeEqual(esperado, Buffer.from(verificadorDe(chave), 'base64'))) throw erro(422, 'Senha do backup incorreta.', 'BACKUP_SENHA_INCORRETA');
  let comprimido;
  try {
    const d = createDecipheriv('aes-256-gcm', chave, Buffer.from(cab.cifra.iv, 'base64'));
    d.setAAD(aad(cab));
    d.setAuthTag(tag);
    comprimido = Buffer.concat([d.update(cifrado), d.final()]);
  } catch { throw erro(422, CORROMPIDO, 'BACKUP_CORROMPIDO'); }
  let bruto;
  try { bruto = gunzipSync(comprimido, { maxOutputLength: MAX_CONTEUDO }); } catch { throw erro(422, CORROMPIDO, 'BACKUP_CORROMPIDO'); }
  if (bruto.length !== cab.conteudo.bytes || sha256(bruto) !== cab.conteudo.sha256) throw erro(422, CORROMPIDO, 'BACKUP_CORROMPIDO');
  return { cabecalho: cab, conteudo: bruto.toString('utf8') };
}
