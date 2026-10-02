import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { isWithin, makeArtifacts, repositoryRoot, validateConfig } from './config.mjs';
import { checkProject, hardenProject, toolchain } from './project.mjs';

const json = value => `${JSON.stringify(value, null, 2)}\n`;
async function main() {
  const { values, positionals } = parseArgs({ options: { config: { type: 'string' }, out: { type: 'string' } }, allowPositionals: true });
  const [command] = positionals;
  if (positionals.length !== 1 || !['validate', 'generate', 'project', 'check-project'].includes(command)) throw new Error('Uso: npm run validate|generate|project|check-project -- [--config caminho.json] [--out pasta]');
  const out = resolve(values.out ?? 'generated');
  if (command === 'check-project') { await checkProject(join(out, 'project')); console.log('Toolchain do projeto verificada; isto não valida um AAB.'); return; }
  const config = validateConfig(JSON.parse(await readFile(resolve(values.config ?? 'android-config.json'), 'utf8')));
  const { assetlinks, twaManifest } = makeArtifacts(config);
  if (command === 'validate') { console.log('Entradas válidas; domínio/assinatura ainda precisam ser comprovados externamente.'); return; }
  if (command === 'project') {
    // Validate real paths, including symlinks, before creating any output.
    const signingPath = await realpath(config.signingKey.path);
    if (isWithin(await realpath(repositoryRoot), signingPath) || !(await stat(signingPath)).isFile()) throw new Error('Keystore deve ser arquivo existente fora do repositório, incluindo symlinks.');
  }
  // Refuse any existing output. Never overwrite a manually edited Android project.
  await mkdir(out, { recursive: false });
  await mkdir(join(out, '.well-known'));
  await writeFile(join(out, '.well-known/assetlinks.json'), json(assetlinks));
  await writeFile(join(out, 'twa-manifest.json'), json(twaManifest));
  await writeFile(join(out, 'toolchain.json'), json(toolchain));
  if (command === 'generate') { console.log(`DAL e configuração gerados em ${out}. Nenhum APK/AAB foi criado.`); return; }
  const { ConsoleLog, TwaGenerator, TwaManifest } = await import('@bubblewrap/core');
  const manifest = new TwaManifest(twaManifest);
  const error = manifest.validate();
  if (error) throw new Error(`Schema Bubblewrap: ${error}`);
  const staging = await mkdtemp(join(out, '.project-'));
  try {
    await new TwaGenerator().createTwaProject(staging, manifest, new ConsoleLog('Nota Sem Stress'));
    await writeFile(join(staging, 'twa-manifest.json'), json(twaManifest));
    // Bubblewrap uses this only to detect manifest edits, not as a security checksum.
    await writeFile(join(staging, 'manifest-checksum.txt'), createHash('sha1').update(json(twaManifest)).digest('hex'));
    await hardenProject(staging);
    await rename(staging, join(out, 'project'));
  } finally { await rm(staging, { recursive: true, force: true }); }
  await chmod(join(out, 'project/gradlew'), 0o755);
  console.log(`Projeto Bubblewrap gerado em ${join(out, 'project')}. Build e instalação permanecem pendentes.`);
}

main().catch(error => { console.error(`Android TWA: ${error.message}`); process.exitCode = 1; });
