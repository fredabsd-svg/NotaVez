import { createHash } from 'node:crypto';
import { ErroApp } from '../util/erros.js';

// Persistência no mesmo banco: limites sobrevivem a restart e são compartilhados
// por processos que usam este banco. Não substitui proteção de volume no ingress.
export function criarLimites(db, { agora = Date.now } = {}) {
  // Tabela limites_requisicoes em db/schema.sql.
  async function consumir(chave, maximo, janelaMs) {
    const instante = agora();
    // Nunca guarda e-mail ou IP literal nesta tabela temporária.
    const hash = createHash('sha256').update(chave).digest('hex');
    const permitido = await db.transacao(async () => {
      await db.run('DELETE FROM limites_requisicoes WHERE expira_em <= ?', instante);
      const atual = await db.get('SELECT quantidade, expira_em FROM limites_requisicoes WHERE chave = ?', hash);
      if (atual && atual.quantidade >= maximo) return false;
      if (atual) await db.run('UPDATE limites_requisicoes SET quantidade = quantidade + 1 WHERE chave = ?', hash);
      else await db.run('INSERT INTO limites_requisicoes VALUES (?,1,?)', hash, instante + janelaMs);
      return true;
    });
    if (!permitido) throw new ErroApp(429, 'Muitas solicitações. Aguarde alguns minutos e tente novamente.');
  }
  async function requisicao(req) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const rota = req.routeOptions?.url || '';
    if (!rota.startsWith('/api/')) return;
    const janela = 15 * 60_000;
    if (/^\/api\/conta\/(entrar|cadastrar|recuperar|redefinir|redefinir-codigo)$/.test(rota)) {
      // Escritórios com muita gente atrás do mesmo IP: o limite fino (só tentativas erradas) fica na autenticação.
      await consumir(`conta:ip:${req.ip}`, 300, janela);
      const identificador = req.body?.usuario ?? req.body?.email;
      if (typeof identificador === 'string') {
        // Qualquer grafia do mesmo CPF/CNPJ conta como a mesma identidade.
        const chave = identificador.includes('@') ? identificador.trim().toLowerCase() : identificador.toUpperCase().replace(/[^0-9A-Z]/g, '');
        if (rota.endsWith('/entrar')) {
          // Por identidade E IP: tentativas de outro lugar não trancam o dono. O teto global da
          // conta fica na autenticação, que conta só erros e isenta o aparelho do dono.
          await consumir(`conta:${rota}:${chave}:ip:${req.ip}`, 15, janela);
        } else await consumir(`conta:${rota}:${chave}`, 5, janela);
      }
    } else if (req.usuario) {
      await consumir(`mutacao:${req.usuario.id}`, 300, 60_000);
      if (/\/emitir$|\/certificado$/.test(rota)) await consumir(`custo:${req.usuario.id}`, 30, 60_000);
    }
  }
  return { consumir, requisicao };
}
