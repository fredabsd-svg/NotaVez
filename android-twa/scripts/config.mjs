import { isIP } from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const fields = new Set(['origin', 'packageId', 'sha256CertFingerprints', 'versionCode', 'versionName', 'signingKey']);
const javaReserved = new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null _'.split(' '));

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function isWithin(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function validateConfig(input, repo = repositoryRoot) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Configuração deve ser um objeto JSON.');
  requireValue(Object.keys(input).every(key => fields.has(key)), 'Campo desconhecido na configuração; não inclua senhas ou tokens.');
  requireValue(typeof input.origin === 'string' && /^https:\/\//.test(input.origin), 'origin deve usar HTTPS.');
  let origin;
  try { origin = new URL(input.origin); } catch { throw new Error('origin inválida.'); }
  requireValue(origin.protocol === 'https:' && !origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === '/' && !origin.port, 'origin deve ser somente uma origem HTTPS, sem credenciais, porta, caminho, query ou fragmento.');
  const hostname = origin.hostname;
  requireValue(!isIP(hostname) && hostname.length <= 253 && hostname.split('.').length >= 2 && hostname.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part)), 'origin deve conter um domínio DNS público.');
  requireValue(!/(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/.test(hostname) && !/(?:^|\.)example\.(?:com|net|org)$/.test(hostname), 'origin contém um domínio reservado de exemplo ou local.');
  requireValue(typeof input.packageId === 'string' && input.packageId.length <= 150 && /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(input.packageId) && input.packageId.split('.').every(part => !javaReserved.has(part)), 'packageId deve ser um applicationId Android válido, com ao menos dois segmentos e sem palavras Java reservadas.');
  requireValue(Array.isArray(input.sha256CertFingerprints) && input.sha256CertFingerprints.length > 0 && input.sha256CertFingerprints.every(value => typeof value === 'string' && /^(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/.test(value) && !/^(?:00:){31}00$/i.test(value)), 'Informe ao menos um fingerprint SHA-256 real, com 32 pares hexadecimais separados por dois-pontos.');
  const fingerprints = [...new Set(input.sha256CertFingerprints.map(value => value.toUpperCase()))];
  requireValue(Number.isInteger(input.versionCode) && input.versionCode >= 1 && input.versionCode <= 2100000000, 'versionCode deve ser inteiro entre 1 e 2100000000.');
  requireValue(typeof input.versionName === 'string' && /^[0-9]+(?:\.[0-9]+){1,3}(?:-[A-Za-z0-9.-]+)?$/.test(input.versionName) && input.versionName.length <= 50, 'versionName deve ser uma versão explícita, por exemplo 1.0.0.');
  const signing = input.signingKey;
  requireValue(signing && typeof signing === 'object' && !Array.isArray(signing) && Object.keys(signing).every(key => ['path', 'alias'].includes(key)), 'signingKey aceita apenas path e alias; senhas ficam fora do JSON.');
  requireValue(typeof signing.path === 'string' && isAbsolute(signing.path) && !isWithin(repo, signing.path), 'signingKey.path deve ser absoluto e ficar fora do repositório.');
  requireValue(typeof signing.alias === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(signing.alias), 'signingKey.alias inválido.');
  return { ...input, origin: origin.origin, sha256CertFingerprints: fingerprints, signingKey: { ...signing } };
}

export function makeArtifacts(config) {
  const host = new URL(config.origin).host;
  const assetlinks = [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: config.packageId, sha256_cert_fingerprints: config.sha256CertFingerprints }
  }];
  const twaManifest = {
    packageId: config.packageId,
    host,
    name: 'Nota Sem Stress',
    launcherName: 'Sem Stress',
    display: 'standalone',
    themeColor: '#0b5cab',
    themeColorDark: '#0b5cab',
    navigationColor: '#ffffff',
    navigationColorDark: '#111827',
    navigationDividerColor: '#ffffff',
    navigationDividerColorDark: '#111827',
    backgroundColor: '#ffffff',
    enableNotifications: false,
    enableSiteSettingsShortcut: true,
    startUrl: '/#/',
    iconUrl: `${config.origin}/icons/icone-512.png`,
    maskableIconUrl: `${config.origin}/icons/icone-maskable-512.png`,
    webManifestUrl: `${config.origin}/manifest.webmanifest`,
    splashScreenFadeOutDuration: 300,
    signingKey: config.signingKey,
    appVersion: config.versionName,
    appVersionCode: config.versionCode,
    minSdkVersion: 23,
    orientation: 'portrait',
    fallbackType: 'customtabs',
    features: {},
    alphaDependencies: { enabled: false },
    additionalTrustedOrigins: [],
    shortcuts: [],
    fingerprints: config.sha256CertFingerprints.map(value => ({ value })),
    generatorApp: 'bubblewrap-cli'
  };
  return { assetlinks, twaManifest };
}
