// Uso no próprio computador (npm run demo / npm run dev): onde os dados ficam e como são protegidos.
//  - Ficam FORA da pasta do projeto, na pasta do usuário (~/.nota-sem-stress/<modo>), para não
//    sumirem ao baixar o projeto de novo, clonar em outra pasta ou limpar o git.
//  - A chave que cifra certificados e dados fica ao lado (chave.txt): sem ela o banco não abre.
//  - Cópias de segurança automáticas (ao iniciar e a cada 6 horas), as 30 mais recentes.
// Este módulo não importa config.js: precisa definir NOTAVEZ_DB/NOTAVEZ_MASTER_KEY antes dele.
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const pastaDadosLocais = (modo) => process.env.NOTAVEZ_DADOS_LOCAIS || join(homedir(), '.nota-sem-stress', modo);

export function prepararDadosLocais(modo, { antigas = [] } = {}) {
  const pasta = pastaDadosLocais(modo);
  const banco = join(pasta, `notavez-${modo}.db`);
  if (!existsSync(banco)) {
    // Dados de versões anteriores (dentro da pasta do projeto) são trazidos uma vez, sem apagar a origem.
    const origem = antigas.find((p) => existsSync(join(p, `notavez-${modo}.db`)));
    if (origem) cpSync(origem, pasta, { recursive: true, errorOnExist: false, force: false });
  }
  mkdirSync(pasta, { recursive: true, mode: 0o700 });
  const arquivoChave = join(pasta, 'chave.txt');
  const chaveAntiga = join(pasta, 'chave-demo.txt');
  if (!existsSync(arquivoChave) && existsSync(chaveAntiga)) writeFileSync(arquivoChave, readFileSync(chaveAntiga, 'utf8').trim(), { mode: 0o600 });
  if (!process.env.NOTAVEZ_MASTER_KEY) {
    if (!existsSync(arquivoChave)) writeFileSync(arquivoChave, randomBytes(32).toString('base64'), { mode: 0o600 });
    process.env.NOTAVEZ_MASTER_KEY = readFileSync(arquivoChave, 'utf8').trim();
  }
  process.env.NOTAVEZ_DB ??= banco;
  return { pasta, banco: process.env.NOTAVEZ_DB, backups: join(pasta, 'backups') };
}

const carimbo = (d = new Date()) => d.toISOString().slice(0, 19).replace(/[:T]/g, '-');

// Uma cópia agora (se a última tem mais de 1 hora) e outra a cada `intervaloMs`; guarda as `manter` mais recentes.
export async function iniciarBackupsAutomaticos({ banco, pastaBackups, intervaloMs = 6 * 3600_000, manter = 30, avisar = (m) => console.log(m) }) {
  if (!banco || banco === ':memory:') return () => {};
  const { criarBackup } = await import('../scripts/backup.mjs');
  mkdirSync(pastaBackups, { recursive: true, mode: 0o700 });
  const existentes = () => readdirSync(pastaBackups).filter((n) => existsSync(join(pastaBackups, n, 'manifesto.json'))).sort();
  async function copiar() {
    if (!existsSync(banco)) return;
    try {
      const destino = join(pastaBackups, carimbo());
      if (existsSync(destino)) return;
      await criarBackup(banco, destino);
      const todas = existentes();
      for (const velha of todas.slice(0, Math.max(0, todas.length - manter))) rmSync(join(pastaBackups, velha), { recursive: true, force: true });
    } catch (e) { avisar(`  Aviso: a cópia de segurança automática falhou (${e.message}).`); }
  }
  const ultima = existentes().at(-1);
  let idade = Infinity;
  try { idade = Date.now() - new Date(JSON.parse(readFileSync(join(pastaBackups, ultima, 'manifesto.json'), 'utf8')).criadoEm).getTime(); } catch { /* sem cópia válida */ }
  if (!(idade >= 0)) idade = Infinity;
  if (idade > 3600_000) await copiar();
  const t = setInterval(copiar, intervaloMs);
  t.unref?.();
  return () => clearInterval(t);
}
