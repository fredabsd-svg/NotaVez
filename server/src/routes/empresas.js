import { lerPerfil, perfilPublico, regimeDescricao, certPublico, lerPfxEnviado } from './perfil.js';
import { verificarParaProcurador } from '../fiscal/certificado.js';
import { ErroApp } from '../util/erros.js';
import { formatarDocumento } from '../util/documentos.js';
import { municipio } from '../fiscal/tabelas.js';
import { auditar } from '../security/auditoria.js';
import { config } from '../config.js';

// Escritórios e quem cuida de várias empresas: cada empresa tem o próprio
// ambiente (perfil fiscal, certificado, clientes, serviços e notas).
const resumo = (p) => ({
  id: p.id, nome: p.nome, documentoFormatado: formatarDocumento(p.tipoDocumento, p.documento),
  municipio: municipio(p.municipioIbge), opSimpNac: p.opSimpNac, regime: regimeDescricao(p), ambiente: p.ambiente,
  certificadoValidoAte: p.certificadoValidoAte, certificadoVencido: !!p.certificadoValidoAte && new Date(p.certificadoValidoAte) <= new Date(),
  porProcuracao: !!p.usaProcuracao, rascunhos: p.rascunhos, pendentes: p.pendentes, emitidasNoMes: p.emitidasNoMes, ultimaEmissao: p.ultimaEmissao, tomadas: p.tomadas,
  // Tem certificado só dela (além do do escritório)? E quando a Receita foi consultada pela última vez.
  certificadoProprio: !!p.certificadoProprio, sincronizadoEm: p.sincronizadoEm || null,
  // A Receita recusou a última consulta (por procuração: é sinal de procuração não vigente).
  consultaRecusadaEm: p.consultaRecusadaEm || null, consultaRecusadaMotivo: p.consultaRecusadaMotivo || null,
});

export async function rotasEmpresas(app) {
  const { repo, db, emissao, consultarCnpj, limites, tomadas } = app.ctx;

  app.get('/empresas', async (req) => ({ empresas: repo.listarPrestadores(req.usuario.id).map(resumo), ativa: req.prestador?.id || null,
    // Para a tela oferecer "passar para produção" às empresas que ainda estão no ambiente de testes.
    producaoLiberada: config.producaoLiberada,
    // Certificado do escritório (procuração): a lista de empresas começa por ele.
    procurador: certPublico(repo.certificadoProcurador(req.usuario.id)) }));

  // Passa várias empresas de uma vez para a produção (notas reais) ou de volta para os testes.
  // As notas já enviadas continuam no ambiente em que foram enviadas; só as próximas mudam.
  app.put('/empresas/ambiente', async (req) => {
    const ambiente = ['producao', 'producao_restrita'].includes(req.body?.ambiente) ? req.body.ambiente : null;
    const ids = Array.isArray(req.body?.empresas) ? [...new Set(req.body.empresas.map(String))].slice(0, 500) : [];
    if (!ambiente || !ids.length) throw new ErroApp(422, 'Escolha as empresas e o ambiente.');
    if (ambiente === 'producao' && !config.producaoLiberada) throw new ErroApp(409, 'A produção não está liberada neste servidor.');
    const minhas = new Map(repo.listarPrestadores(req.usuario.id).map((e) => [e.id, e]));
    let alteradas = 0;
    for (const id of ids) {
      const e = minhas.get(id);
      if (!e || e.ambiente === ambiente) continue; // de outra conta, removida ou já nesse ambiente
      repo.definirAmbiente(req.usuario.id, id, ambiente);
      emissao.fecharClientesDoPrestador(id);
      auditar(db, { usuarioId: req.usuario.id, prestadorId: id, acao: 'empresa.ambiente_alterado', detalhes: { de: e.ambiente, para: ambiente, emLote: true }, ip: req.ip });
      alteradas += 1;
    }
    return { alteradas, empresas: repo.listarPrestadores(req.usuario.id).map(resumo) };
  });

  app.post('/empresas', async (req) => {
    // Escritório com procuração: a empresa já nasce usando o certificado do escritório.
    const porProcuracao = req.body?.usaProcuracao === true;
    if (porProcuracao && !repo.certificadoProcurador(req.usuario.id)) throw new ErroApp(409, 'Envie primeiro o certificado do escritório (procurador) em Empresas › Certificado do escritório.', { acao: 'procurador' });
    const id = repo.salvarPrestador(req.usuario.id, null, lerPerfil(req.body || {}));
    auditar(db, { usuarioId: req.usuario.id, prestadorId: id, acao: 'empresa.criada', ip: req.ip });
    if (porProcuracao) {
      repo.definirProcuracao(req.usuario.id, id, true);
      auditar(db, { usuarioId: req.usuario.id, prestadorId: id, acao: 'procuracao.ativada', ip: req.ip });
    }
    return { empresa: perfilPublico(repo.prestador(id)), empresaId: id };
  });

  // Busca na Receita (ADN) as notas tomadas e as emitidas fora do app de TODAS as empresas da conta
  // que têm certificado válido. Roda em segundo plano; a tela acompanha pelo andamento.
  app.post('/empresas/sincronizar', async (req) => {
    const antes = tomadas.situacaoLote(req.usuario.id);
    const lote = tomadas.iniciarLote(req.usuario.id);
    if (!antes.emAndamento) auditar(db, { usuarioId: req.usuario.id, acao: 'empresas.sincronizacao_iniciada', detalhes: { empresas: lote.total }, ip: req.ip });
    return lote;
  });
  app.get('/empresas/sincronizacao', async (req) => tomadas.situacaoLote(req.usuario.id));

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
  // Liga ou desliga a procuração em várias empresas de uma vez (escritórios cuidam de dezenas).
  app.put('/procurador/empresas', async (req) => {
    const ativa = req.body?.ativa === true;
    const ids = Array.isArray(req.body?.empresas) ? [...new Set(req.body.empresas.map(String))].slice(0, 500) : [];
    if (!ids.length) throw new ErroApp(422, 'Escolha ao menos uma empresa.');
    if (ativa && !repo.certificadoProcurador(req.usuario.id)) throw new ErroApp(409, 'Envie primeiro o certificado do escritório (procurador).', { acao: 'procurador' });
    const minhas = new Map(repo.listarPrestadores(req.usuario.id).map((e) => [e.id, e]));
    let alteradas = 0;
    for (const id of ids) {
      const e = minhas.get(id);
      if (!e || !!e.usaProcuracao === ativa) continue; // de outra conta, removida ou já no estado pedido
      repo.definirProcuracao(req.usuario.id, id, ativa);
      emissao.fecharClientesDoPrestador(id);
      auditar(db, { usuarioId: req.usuario.id, prestadorId: id, acao: ativa ? 'procuracao.ativada' : 'procuracao.desativada', detalhes: { emLote: true }, ip: req.ip });
      alteradas += 1;
    }
    return { alteradas, empresas: repo.listarPrestadores(req.usuario.id).map(resumo) };
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
