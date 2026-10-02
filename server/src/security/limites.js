import { createHash } from 'node:crypto';
import { ErroApp } from '../util/erros.js';

// Persistência no mesmo SQLite: limites sobrevivem a restart e são compartilhados
// por processos que usam este banco. Não substitui proteção de volume no ingress.
export function criarLimites(db, { agora = Date.now } = {}) {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS limites_requisicoes (
    chave TEXT PRIMARY KEY, quantidade INTEGER NOT NULL, expira_em INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS ix_limites_expira ON limites_requisicoes(expira_em);`);
  function consumir(chave, maximo, janelaMs) {
    const instante = agora();
    // Nunca guarda e-mail ou IP literal nesta tabela temporária.
    const hash = createHash('sha256').update(chave).digest('hex');
    const permitido = db.transacao(() => {
      db.run('DELETE FROM limites_requisicoes WHERE expira_em <= ?', instante);
      const atual = db.get('SELECT quantidade, expira_em FROM limites_requisicoes WHERE chave = ?', hash);
      if (atual && atual.quantidade >= maximo) return false;
      if (atual) db.run('UPDATE limites_requisicoes SET quantidade = quantidade + 1 WHERE chave = ?', hash);
      else db.run('INSERT INTO limites_requisicoes VALUES (?,1,?)', hash, instante + janelaMs);
      return true;
    });
    if (!permitido) throw new ErroApp(429, 'Muitas solicitações. Aguarde alguns minutos e tente novamente.');
  }
  function requisicao(req) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const rota = req.routeOptions?.url || '';
    if (!rota.startsWith('/api/')) return;
    const janela = 15 * 60_000;
    if (/^\/api\/conta\/(entrar|cadastrar|recuperar|redefinir)$/.test(rota)) {
      consumir(`conta:ip:${req.ip}`, 60, janela);
      if (typeof req.body?.email === 'string') {
        consumir(`conta:${rota}:${req.body.email.trim().toLowerCase()}`, rota.endsWith('/entrar') ? 15 : 5, janela);
      }
    } else if (req.usuario) {
      consumir(`mutacao:${req.usuario.id}`, 300, 60_000);
      if (/\/emitir$|\/certificado$/.test(rota)) consumir(`custo:${req.usuario.id}`, 30, 60_000);
    }
  }
  return { consumir, requisicao };
}
