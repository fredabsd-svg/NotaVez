import { lerPerfil, perfilPublico, regimeDescricao } from './perfil.js';
import { formatarDocumento } from '../util/documentos.js';
import { municipio } from '../fiscal/tabelas.js';
import { auditar } from '../security/auditoria.js';

// Escritórios e quem cuida de várias empresas: cada empresa tem o próprio
// ambiente (perfil fiscal, certificado, clientes, serviços e notas).
const resumo = (p) => ({
  id: p.id, nome: p.nome, documentoFormatado: formatarDocumento(p.tipoDocumento, p.documento),
  municipio: municipio(p.municipioIbge), opSimpNac: p.opSimpNac, regime: regimeDescricao(p), ambiente: p.ambiente,
  certificadoValidoAte: p.certificadoValidoAte, certificadoVencido: !!p.certificadoValidoAte && new Date(p.certificadoValidoAte) <= new Date(),
  rascunhos: p.rascunhos, pendentes: p.pendentes, emitidasNoMes: p.emitidasNoMes, ultimaEmissao: p.ultimaEmissao, tomadas: p.tomadas,
});

export async function rotasEmpresas(app) {
  const { repo, db, emissao, consultarCnpj, limites } = app.ctx;

  app.get('/empresas', async (req) => ({ empresas: repo.listarPrestadores(req.usuario.id).map(resumo), ativa: req.prestador?.id || null }));

  app.post('/empresas', async (req) => {
    const id = repo.salvarPrestador(req.usuario.id, null, lerPerfil(req.body || {}));
    auditar(db, { usuarioId: req.usuario.id, prestadorId: id, acao: 'empresa.criada', ip: req.ip });
    return { empresa: perfilPublico(repo.prestador(id)), empresaId: id };
  });

  app.delete('/empresas/:id', async (req) => {
    repo.removerPrestador(req.usuario.id, req.params.id);
    emissao.fecharClientesDoPrestador(req.params.id);
    auditar(db, { usuarioId: req.usuario.id, acao: 'empresa.removida', entidade: 'prestador', entidadeId: req.params.id, ip: req.ip });
    return { ok: true };
  });

  // Dados públicos do CNPJ para preencher empresa ou cliente (o usuário confere antes de salvar).
  app.get('/cnpj/:cnpj', async (req) => {
    limites.consumir(`cnpj:${req.usuario.id}`, 60, 60_000);
    return { cnpj: await consultarCnpj(req.params.cnpj) };
  });
}
