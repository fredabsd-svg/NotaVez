import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { makeArtifacts, repositoryRoot, validateConfig } from '../scripts/config.mjs';
import { checkProject, hardenProject } from '../scripts/project.mjs';

const moduleRoot = fileURLToPath(new URL('../', import.meta.url));
// All identities below are fixtures; no production config or generated artifact is checked in.
const fingerprint = createHash('sha256').update('certificate fixture').digest('hex').match(/../g).join(':').toUpperCase();
const fixture = () => ({
  origin: 'https://pwa.android-fixture.dev',
  packageId: 'dev.androidfixture.emissor',
  sha256CertFingerprints: [fingerprint],
  versionCode: 7,
  versionName: '1.2.0',
  signingKey: { path: join(tmpdir(), 'android-fixture-upload.jks'), alias: 'upload' }
});

test('rejects non-HTTPS, local, reserved, credentialed and ambiguous origins', () => {
  for (const origin of ['http://pwa.android-fixture.dev', 'file:///tmp/app', '', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://example.com', 'https://app.test', 'https://a.internal', 'https://a_b.dev', 'https://user:password@pwa.android-fixture.dev', 'https://pwa.android-fixture.dev:8443', 'https://pwa.android-fixture.dev/app', 'https://pwa.android-fixture.dev/?a=1', 'https://pwa.android-fixture.dev/#/']) {
    assert.throws(() => validateConfig({ ...fixture(), origin }), undefined, origin);
  }
});

test('rejects malformed or Java-reserved Android application identifiers', () => {
  for (const packageId of ['', 'emissor', '1com.app', 'dev.bad-name', 'dev..app', 'dev.class.app', 'dev.app;']) {
    assert.throws(() => validateConfig({ ...fixture(), packageId }), /packageId/);
  }
});

test('requires real-shaped SHA-256 fingerprints and normalizes duplicates', () => {
  for (const sha256CertFingerprints of [[], ['TODO'], ['AA:BB'], ['00:'.repeat(31) + '00'], [fingerprint.replace(/:/g, '')], [fingerprint.replace(/[A-F]/, 'Z')], [null]]) {
    assert.throws(() => validateConfig({ ...fixture(), sha256CertFingerprints }), /fingerprint/);
  }
  const config = validateConfig({ ...fixture(), sha256CertFingerprints: [fingerprint.toLowerCase(), fingerprint] });
  assert.deepEqual(config.sha256CertFingerprints, [fingerprint]);
});

test('rejects invalid versions and in-repository signing files or secret fields', () => {
  for (const versionCode of [0, -1, 1.5, '1', 2100000001]) assert.throws(() => validateConfig({ ...fixture(), versionCode }), /versionCode/);
  for (const versionName of ['', 'latest', '1.0";']) assert.throws(() => validateConfig({ ...fixture(), versionName }), /versionName/);
  assert.throws(() => validateConfig({ ...fixture(), signingKey: { path: join(repositoryRoot, 'key.jks'), alias: 'upload' } }), /fora do repositório/);
  assert.throws(() => validateConfig({ ...fixture(), signingKey: { path: './key.jks', alias: 'upload' } }), /absoluto/);
  assert.throws(() => validateConfig({ ...fixture(), password: 'secret' }), /Campo desconhecido/);
  assert.throws(() => validateConfig({ ...fixture(), signingKey: { ...fixture().signingKey, password: 'secret' } }), /senhas/);
});

test('generated DAL and manifest share identity and Play fingerprint', () => {
  const config = validateConfig(fixture());
  const { assetlinks, twaManifest } = makeArtifacts(config);
  assert.deepEqual(assetlinks, [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: config.packageId, sha256_cert_fingerprints: [fingerprint] } }]);
  assert.equal(twaManifest.packageId, config.packageId);
  assert.equal(twaManifest.host, new URL(config.origin).host);
  assert.equal(twaManifest.startUrl, '/#/');
  assert.equal(twaManifest.appVersionCode, 7);
  assert.equal(twaManifest.appVersion, '1.2.0');
  assert.equal(twaManifest.enableNotifications, false);
  assert.deepEqual(twaManifest.features, {});
  assert.deepEqual(twaManifest.additionalTrustedOrigins, []);
});

test('CLI refuses blank production template and does not overwrite existing output', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'notavez-twa-cli-'));
  try {
    const command = (verb, config, out) => execFileSync(process.execPath, [join(moduleRoot, 'scripts/cli.mjs'), verb, '--config', config, '--out', out], { encoding: 'utf8', stdio: 'pipe' });
    const out = join(temp, 'output');
    assert.throws(() => command('generate', join(moduleRoot, 'android-config.example.json'), out), /origin deve usar HTTPS/);
    await assert.rejects(access(out));
    const configPath = join(temp, 'config.json');
    await writeFile(configPath, JSON.stringify(fixture()));
    command('generate', configPath, out);
    const original = await readFile(join(out, '.well-known/assetlinks.json'), 'utf8');
    assert.deepEqual(JSON.parse(original), makeArtifacts(validateConfig(fixture())).assetlinks);
    assert.throws(() => command('generate', configPath, out), /EEXIST/);
    assert.equal(await readFile(join(out, '.well-known/assetlinks.json'), 'utf8'), original);
    assert.throws(() => command('project', configPath, join(temp, 'missing-key')), /ENOENT/);
    await assert.rejects(access(join(temp, 'missing-key')));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('pinned Bubblewrap generates an actual API36 project from mocked HTTP assets', async () => {
  const { ConsoleLog, fetchUtils, TwaGenerator, TwaManifest } = await import('@bubblewrap/core');
  const originalFetch = fetchUtils.fetch;
  const temp = await mkdtemp(join(tmpdir(), 'notavez-twa-project-'));
  try {
    const config = validateConfig(fixture());
    const { twaManifest } = makeArtifacts(config);
    const icon = await readFile(join(repositoryRoot, 'web/icons/icone-512.png'));
    const maskable = await readFile(join(repositoryRoot, 'web/icons/icone-maskable-512.png'));
    const webManifest = await readFile(join(repositoryRoot, 'web/manifest.webmanifest'));
    fetchUtils.fetch = async url => {
      if (url === twaManifest.iconUrl) return new Response(icon, { headers: { 'content-type': 'image/png' } });
      if (url === twaManifest.maskableIconUrl) return new Response(maskable, { headers: { 'content-type': 'image/png' } });
      if (url === twaManifest.webManifestUrl) return new Response(webManifest, { headers: { 'content-type': 'application/manifest+json' } });
      throw new Error(`Unexpected network request: ${url}`);
    };
    const manifest = new TwaManifest(twaManifest);
    assert.equal(manifest.validate(), null);
    await new TwaGenerator().createTwaProject(temp, manifest, new ConsoleLog('test'));
    await hardenProject(temp);
    await checkProject(temp);
    const appGradle = await readFile(join(temp, 'app/build.gradle'), 'utf8');
    assert.ok(appGradle.includes(`applicationId "${config.packageId}"`));
    assert.ok(appGradle.includes('versionCode 7'));
    const androidManifest = await readFile(join(temp, 'app/src/main/AndroidManifest.xml'), 'utf8');
    assert.ok(androidManifest.includes('android.support.customtabs.trusted.DEFAULT_URL'));
    for (const permission of ['ACCESS_FINE_LOCATION', 'CAMERA', 'READ_CONTACTS', 'POST_NOTIFICATIONS']) assert.ok(!androidManifest.includes(permission));
    await access(join(temp, 'app/src/main/res/mipmap-xxxhdpi/ic_launcher.png'));
    await writeFile(join(temp, 'app/build.gradle'), appGradle.replace('targetSdkVersion 36', 'targetSdkVersion 35'));
    await assert.rejects(checkProject(temp), /targetSdkVersion 36/);
  } finally { fetchUtils.fetch = originalFetch; await rm(temp, { recursive: true, force: true }); }
});
