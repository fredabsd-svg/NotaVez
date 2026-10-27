import { gerarDanfse } from '../fiscal/danfse/index.js';
import { formatarDocumento } from '../util/documentos.js';
import { naoEncontrado } from '../util/erros.js';
import { auditar } from '../security/auditoria.js';
import { config } from '../config.js';
import { exigirPrestador } from './perfil.js';

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const publica = (t, completo = false) => ({
  id: t.id, chaveAcesso: t.chaveAcesso, nNfse: t.nNfse, competencia: t.competencia, emitidaEm: t.emitidaEm,
  valor: t.valor, valorLiquido: t.valorLiquido, issRetido: t.issRetido, situacao: t.situacao,
  homologacao: t.ambiente === 'producao_restrita',
  emitente: t.emitente ? { tipo: t.emitente.tipo, nome: t.emitente.nome, documentoFormatado: formatarDocumento(t.emitente.tipo, t.emitente.documento) } : null,
  descricao: completo ? t.descricao : (t.descricao || '').slice(0, 80),
  ...(completo ? { cTribNac: t.cTribNac, servico: t.servico, localPrestacao: t.localPrestacao, vIss: t.vIss, baixadaEm: t.baixadaEm } : {}),
});

export async function rotasTomadas(app) {
  const { repo, db, tomadas } = app.ctx;

  // ?competencia=AAAA-MM filtra pelo mês; ?q= por fornecedor, CNPJ, número ou chave.
  app.get('/', async (req) => {
    const p = exigirPrestador(req);
    const competencia = /^\d{4}-\d{2}$/.test(req.query?.competencia || '') ? req.query.competencia : undefined;
    const q = semAcento(req.query?.q).trim();
    let lista = repo.listarTomadas(p.id, p.ambiente, { competencia });
    if (q) {
      const dig = q.replace(/[^0-9a-z]/g, '');
      lista = lista.filter((t) => semAcento(t.emitente?.nome).includes(q) || (dig.length >= 3 && ((t.emitente?.documento || '').toLowerCase().includes(dig) || (t.nNfse || '').includes(dig) || (t.chaveAcesso || '').includes(dig))));
    }
    const validas = lista.filter((t) => t.situacao !== 'cancelada');
    const soma = (k) => validas.reduce((s, t) => s + Number(t[k] || 0), 0).toFixed(2);
    return {
      tomadas: lista.map((t) => publica(t)),
      totais: { quantidade: validas.length, valor: soma('valor'), valorLiquido: soma('valorLiquido') },
      sincronizacao: repo.distribuicao(p.id, p.ambiente, p.documento),
      temCertificado: !!repo.certificadoAtivo(p.id),
    };
  });

  app.post('/sincronizar', async (req) => {
    const p = exigirPrestador(req);
    const r = await tomadas.sincronizar(p);
    auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'tomadas.sincronizadas', detalhes: { novas: r.novas, canceladas: r.canceladas }, ip: req.ip });
    return r;
  });

  app.get('/:id', async (req) => {
    const t = repo.tomada(exigirPrestador(req).id, req.params.id);
    if (!t) throw naoEncontrado('Nota tomada');
    return { tomada: publica(t, true) };
  });

  app.get('/:id/xml', async (req, reply) => {
    const p = exigirPrestador(req);
    const t = repo.tomada(p.id, req.params.id);
    if (!t) throw naoEncontrado('Nota tomada');
    return reply.header('Content-Type', 'application/xml; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="NFSe-${t.chaveAcesso}.xml"`).send(repo.xmlTomada(p.id, t.id));
  });

  app.get('/:id/danfse', async (req, reply) => {
    const p = exigirPrestador(req);
    const t = repo.tomada(p.id, req.params.id);
    if (!t) throw naoEncontrado('Nota tomada');
    const pdf = await gerarDanfse(repo.xmlTomada(p.id, t.id), { marcaDagua: config.demo ? 'SIMULAÇÃO' : t.situacao === 'cancelada' ? 'CANCELADA' : null });
    return reply.header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `${req.query?.baixar === '1' ? 'attachment' : 'inline'}; filename="DANFSe-${t.chaveAcesso}.pdf"`).send(pdf);
  });
}
