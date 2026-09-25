import { buscarMunicipios, buscarServicos, municipio, municipios, servicoNacional, servicosNacionais, sinonimosServicos, versoesTabelas } from '../fiscal/tabelas.js';
import { pacotes } from '../fiscal/regras/index.js';

export async function rotasTabelas(app) {
  // Tabelas completas para busca no aparelho (funciona sem internet depois do 1º acesso).
  const cache = (reply) => reply.header('Cache-Control', 'public, max-age=86400');
  app.get('/completas/municipios', async (req, reply) => { cache(reply); return { versao: versoesTabelas.anexoA, municipios }; });
  app.get('/completas/servicos', async (req, reply) => { cache(reply); return { versao: versoesTabelas.anexoB, servicos: servicosNacionais, sinonimos: sinonimosServicos }; });
  app.get('/municipios', async (req) => ({ municipios: buscarMunicipios(req.query?.q) }));
  app.get('/municipios/:ibge', async (req) => ({ municipio: municipio(req.params.ibge) }));
  app.get('/servicos', async (req) => ({ servicos: buscarServicos(req.query?.q) }));
  app.get('/servicos/:codigo', async (req) => ({ servico: servicoNacional(req.params.codigo) }));
  app.get('/versoes', async () => ({ tabelas: versoesTabelas, regras: pacotes.map((p) => ({ id: p.id, descricao: p.descricao })), leiaute: 'DPS v1.01 (esquemas-nfse-rtc-v1-01-20260727)' }));
}
