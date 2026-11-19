// Servidor que começa uma restauração e PARA no meio da transação (depois de apagar os dados e inserir parte
// do backup), avisando "NO_MEIO" na saída. O teste então mata este processo com SIGKILL: é a queda real do
// servidor, com a transação aberta no PostgreSQL. Usa o mesmo banco (DATABASE_URL) e a mesma chave mestra.
//   node test/apoio/restauracao-interrompida.mjs <email> <senha-da-conta> <id-do-backup> <senha-do-backup>
process.env.NODE_ENV = 'test';
const [email, senhaConta, backupId, senhaBackup] = process.argv.slice(2);
const { criarApp } = await import('../../src/app.js');
const sondasBackup = {
  aposLote: async (tabela) => {
    if (tabela !== 'notas') return;
    process.stdout.write('NO_MEIO\n');
    await new Promise(() => {}); // fica aqui até o processo ser morto
  },
};
const app = await criarApp({ banco: ':memory:', logger: false, servirWeb: false, sondasBackup });
let cookie = '';
const api = async (method, url, payload) => {
  const r = await app.inject({ method, url, payload, remoteAddress: '198.51.100.201', headers: { cookie, ...(method !== 'GET' ? { 'x-notavez': '1' } : {}) } });
  if (r.headers['set-cookie']) cookie = [r.headers['set-cookie']].flat().map((c) => c.split(';')[0]).join('; ');
  return r;
};
const entrou = await api('POST', '/api/conta/entrar', { usuario: email, senha: senhaConta });
if (entrou.statusCode !== 200) { process.stdout.write(`FALHA_LOGIN ${entrou.statusCode} ${entrou.body}\n`); process.exit(2); }
const r = await api('POST', `/api/backup/${backupId}/restaurar`, { senha: senhaBackup, confirmacao: 'RESTAURAR' });
process.stdout.write(`TERMINOU ${r.statusCode} ${r.body}\n`); // não deveria chegar aqui
process.exit(3);
