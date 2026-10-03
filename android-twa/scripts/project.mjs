import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const toolchain = Object.freeze({
  bubblewrap: '1.25.0', jdkMajor: 17, compileSdk: 36, targetSdk: 36,
  buildTools: '36.1.0', agp: '8.9.1', gradle: '8.11.1',
  gradleSha256: 'f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6',
  // Wrapper supplied by the npm package, protected by package-lock integrity.
  wrapperSha256: '3dc39ad650d40f6c029bd8ff605c6d95865d657dbfdeacdb079db0ddfffedf9f'
});

export async function checkProject(directory) {
  const [app, root, wrapper, jar] = await Promise.all([
    readFile(join(directory, 'app/build.gradle'), 'utf8'),
    readFile(join(directory, 'build.gradle'), 'utf8'),
    readFile(join(directory, 'gradle/wrapper/gradle-wrapper.properties'), 'utf8'),
    readFile(join(directory, 'gradle/wrapper/gradle-wrapper.jar'))
  ]);
  const checks = [
    [/\bcompileSdkVersion\s+36\b/.test(app), 'compileSdkVersion 36'],
    [/\btargetSdkVersion\s+36\b/.test(app), 'targetSdkVersion 36'],
    [/\bbuildToolsVersion\s+["']36\.1\.0["']/.test(app), 'Build Tools 36.1.0'],
    [root.includes(`com.android.tools.build:gradle:${toolchain.agp}`), 'AGP 8.9.1'],
    [!root.includes('jcenter()') && root.includes('mavenCentral()'), 'repositório Maven Central'],
    [wrapper.includes('gradle-8.11.1-bin.zip') && wrapper.includes(`distributionSha256Sum=${toolchain.gradleSha256}`), 'Gradle 8.11.1 e SHA-256'],
    [createHash('sha256').update(jar).digest('hex') === toolchain.wrapperSha256, 'integridade do wrapper Bubblewrap']
  ];
  const failures = checks.filter(([ok]) => !ok).map(([, label]) => label);
  if (failures.length) throw new Error(`Projeto fora da toolchain fixada: ${failures.join(', ')}.`);
}

export async function hardenProject(directory) {
  const appPath = join(directory, 'app/build.gradle');
  let app = await readFile(appPath, 'utf8');
  // Fail rather than silently changing an unknown template on an upgrade.
  if (!/compileSdkVersion 36\b/.test(app) || !/targetSdkVersion 36\b/.test(app)) throw new Error('Template Bubblewrap não usa API 36; revise a versão fixada.');
  app = app.replace('compileSdkVersion 36', 'compileSdkVersion 36\n    buildToolsVersion "36.1.0"');
  await writeFile(appPath, app);
  const rootPath = join(directory, 'build.gradle');
  await writeFile(rootPath, (await readFile(rootPath, 'utf8')).replaceAll('jcenter()', 'mavenCentral()'));
  const wrapperPath = join(directory, 'gradle/wrapper/gradle-wrapper.properties');
  await writeFile(wrapperPath, `${await readFile(wrapperPath, 'utf8')}\ndistributionSha256Sum=${toolchain.gradleSha256}\n`);
  await checkProject(directory);
}
