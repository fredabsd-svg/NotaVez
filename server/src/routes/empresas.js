import { lerPerfil, perfilPublico, regimeDescricao, certPublico, lerPfxEnviado } from './perfil.js';
import { verificarParaProcurador } from '../fiscal/certificado.js';
import { ErroApp } from '../util/erros.js';
import { formatarDocumento } from '../util/documentos.js';
import { municipio } from '../fiscal/tabelas.js';
import { auditar } from '../security/auditoria.js';

// Escritórios e quem cuida de várias empresas: cada empresa tem o próprio
// ambiente (perfil fiscal, certificado, clientes, serviços e notas).
const resumo = (p) => ({
  id: p.id, nome: p.nome, documentoFormatado: formatarDocumento(p.tipoDocumento, p.documento),
  municipio: municipio(p.municipioIbge), opSimpNac: p.opSimpNac, regime: regimeDescricao(p), ambiente: p.ambiente,
  certificadoValidoAte: p.certificadoValidoAte, certificadoVencido: !!p.certificadoValidoAte && new Date(p.certificadoValidoAte) <= new Date(),
  porProcuracao: !!p.usaProcuracao, rascunhos: p.rascunhos, pendentes: p.pendentes, emitidasNoMes: p.emitidasNoMes, ultimaEmissao: p.ultimaEmissao, tomadas: p.tomadas,
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

  // ---------- certificado do procurador (escritório ou contador) ----------
  // Um certificado para todas as empresas que concederam procuração eletrônica NFS-e.
  const fecharProcuradas = (usuarioId) => {
    for (const e of repo.listarPrestadores(usuarioId)) if (e.usaProcuracao) emissao.fecharClientesDoPrestador(e.id);
  };
  app.get('/procurador', async (req) => {
    const empresas = repo.listarPrestadores(req.usuario.id);
    return { certificado: certPublico(repo.certificadoProcurador(req.usuario.id)), empresasPorProcuracao: empresas.filter((e) => e.usaProcuracao).length, empresas: empresas.length };
  });
  app.post('/procurador/certificado', async (req) => {
    const { pfx, senha, info } = lerPfxEnviado(req.body);
    const problemas = verificarParaProcurador(info);
    if (problemas.length) throw new ErroApp(422, 'Este certificado não pode ser usado como procurador.', { problemas });
    repo.salvarCertificadoProcurador(req.usuario.id, { pfx, senha, info });
    fecharProcuradas(req.usuario.id);
    auditar(db, { usuarioId: req.usuario.id, acao: 'certificado_procurador.enviado', detalhes: { validoAte: info.validoAte, emissor: info.emissor }, ip: req.ip });
    return { certificado: certPublico(repo.certificadoProcurador(req.usuario.id)) };
  });
  app.delete('/procurador/certificado', async (req) => {
    repo.removerCertificadoProcurador(req.usuario.id);
    fecharProcuradas(req.usuario.id);
    auditar(db, { usuarioId: req.usuario.id, acao: 'certificado_procurador.removido', ip: req.ip });
    return { ok: true };
  });

  // Dados públicos do CNPJ para preencher empresa ou cliente (o usuário confere antes de salvar).
  app.get('/cnpj/:cnpj', async (req) => {
    limites.consumir(`cnpj:${req.usuario.id}`, 60, 60_000);
    return { cnpj: await consultarCnpj(req.params.cnpj) };
  });
}
