import { lerPerfil, perfilPublico, regimeDescricao, certPublico, lerPfxEnviado } from './perfil.js';
import { verificarParaProcurador } from '../fiscal/certificado.js';
import { ErroApp } from '../util/erros.js';
import { formatarDocumento, normalizarCnpj } from '../util/documentos.js';
import { lerLista, prepararEmpresa, lerCadastro, MAX_LOTE, REGIMES, AVISO_PADRAO } from '../cadastro/lote-empresas.js';
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

  app.get('/empresas', async (req) => ({ empresas: (await repo.listarPrestadores(req.usuario.id)).map(resumo), ativa: req.prestador?.id || null,
    // Para a tela oferecer "passar para produção" às empresas que ainda estão no ambiente de testes.
    producaoLiberada: config.producaoLiberada,
    // Certificado do escritório (procuração): a lista de empresas começa por ele.
    procurador: certPublico(await repo.certificadoProcurador(req.usuario.id)) }));

  // Passa várias empresas de uma vez para a produção (notas reais) ou de volta para os testes.
  // As notas já enviadas continuam no ambiente em que foram enviadas; só as próximas mudam.
  app.put('/empresas/ambiente', async (req) => {
    const ambiente = ['producao', 'producao_restrita'].includes(req.body?.ambiente) ? req.body.ambiente : null;
    const ids = Array.isArray(req.body?.empresas) ? [...new Set(req.body.empresas.map(String))].slice(0, 500) : [];
    if (!ambiente || !ids.length) throw new ErroApp(422, 'Escolha as empresas e o ambiente.');
    if (ambiente === 'producao' && !config.producaoLiberada) throw new ErroApp(409, 'A produção não está liberada neste servidor.');
    const minhas = new Map((await repo.listarPrestadores(req.usuario.id)).map((e) => [e.id, e]));
    let alteradas = 0;
    for (const id of ids) {
      const e = minhas.get(id);
      if (!e || e.ambiente === ambiente) continue; // de outra conta, removida ou já nesse ambiente
      await repo.definirAmbiente(req.usuario.id, id, ambiente);
      emissao.fecharClientesDoPrestador(id);
      await auditar(db, { usuarioId: req.usuario.id, prestadorId: id, acao: 'empresa.ambiente_alterado', detalhes: { de: e.ambiente, para: ambiente, emLote: true }, ip: req.ip });
      alteradas += 1;
    }
    return { alteradas, empresas: (await repo.listarPrestadores(req.usuario.id)).map(resumo) };
  });

  app.post('/empresas', async (req) => {
    // Escritório com procuração: a empresa já nasce usando o certificado do escritório.
    const porProcuracao = req.body?.usaProcuracao === true;
    if (porProcuracao && !await repo.certificadoProcurador(req.usuario.id)) throw new ErroApp(409, 'Envie primeiro o certificado do escritório (procurador) em Empresas › Certificado do escritório.', { acao: 'procurador' });
    const id = await repo.salvarPrestador(req.usuario.id, null, lerPerfil(req.body || {}));
    await auditar(db, { usuarioId: req.usuario.id, prestadorId: id, acao: 'empresa.criada', ip: req.ip });
    if (porProcuracao) {
      await repo.definirProcuracao(req.usuario.id, id, true);
      await auditar(db, { usuarioId: req.usuario.id, prestadorId: id, acao: 'procuracao.ativada', ip: req.ip });
    }
    return { empresa: perfilPublico(await repo.prestador(id)), empresaId: id };
  });

  // ---------- cadastro em lote (escritórios) ----------
  // 1) lê a lista colada ou a planilha; 2) a tela consulta um CNPJ por vez (base pública + regras);
  // 3) a IA revisa (/api/ia/revisar-empresas); 4) salva as escolhidas, com o regime confirmado na tela.
  const documentosDaConta = async (usuarioId) => new Set((await repo.listarPrestadores(usuarioId)).map((e) => e.documento));
  app.post('/empresas/lote/ler', { bodyLimit: 4_400_000 }, async (req) => {
    await limites.consumir(`lote-ler:${req.usuario.id}`, 60, 3600_000);
    const r = await lerLista({ texto: req.body?.texto, arquivo: req.body?.arquivo });
    const existentes = await documentosDaConta(req.usuario.id);
    return { ...r, linhas: r.linhas.map((l) => ({ ...l, jaCadastrada: existentes.has(l.cnpj) })), maximo: MAX_LOTE, avisosPadrao: AVISO_PADRAO };
  });
  app.post('/empresas/lote/consultar', async (req) => {
    // Teto próprio (maior que o da consulta avulsa), para não esgotar a base pública nem a cota da conta.
    await limites.consumir(`cnpj-lote:${req.usuario.id}`, 120, 60_000);
    await limites.consumir(`cnpj-lote-dia:${req.usuario.id}`, 2000, 86_400_000);
    return { empresa: await prepararEmpresa({ consultarCnpj }, req.body || {}, { existentes: await documentosDaConta(req.usuario.id) }) };
  });
  app.post('/empresas/lote/salvar', async (req) => {
    const itens = Array.isArray(req.body?.empresas) ? req.body.empresas.slice(0, MAX_LOTE) : [];
    if (!itens.length) throw new ErroApp(422, 'Escolha as empresas para salvar.');
    const porProcuracao = req.body?.usaProcuracao === true;
    if (porProcuracao && !await repo.certificadoProcurador(req.usuario.id)) throw new ErroApp(409, 'Envie primeiro o certificado do escritório (procurador) em Empresas › Certificado do escritório.', { acao: 'procurador' });
    const existentes = await documentosDaConta(req.usuario.id);
    const resultados = [];
    for (const it of itens) {
      const cnpj = normalizarCnpj(it?.perfil?.documento);
      try {
        if (existentes.has(cnpj)) throw new ErroApp(409, 'Já está cadastrada nesta conta.');
        if (!REGIMES[it?.regime]) throw new ErroApp(422, 'Escolha o regime da empresa.');
        const perfil = lerCadastro(it.perfil, it.regime);
        const id = await repo.salvarPrestador(req.usuario.id, null, perfil);
        existentes.add(perfil.documento);
        const revisaoIa = ['aprovar', 'revisar', 'bloquear'].includes(it.veredito) ? it.veredito : 'sem_revisao';
        await auditar(db, { usuarioId: req.usuario.id, prestadorId: id, acao: 'empresa.criada', detalhes: { emLote: true, regime: it.regime, revisaoIa }, ip: req.ip });
        if (porProcuracao) {
          await repo.definirProcuracao(req.usuario.id, id, true);
          await auditar(db, { usuarioId: req.usuario.id, prestadorId: id, acao: 'procuracao.ativada', detalhes: { emLote: true }, ip: req.ip });
        }
        resultados.push({ cnpj, ok: true, empresaId: id, nome: perfil.nome });
      } catch (e) {
        resultados.push({ cnpj, ok: false, erro: e.extra?.campos ? `${e.message} ${Object.values(e.extra.campos).join(' ')}` : e.message });
      }
    }
    return { resultados, criadas: resultados.filter((r) => r.ok).length };
  });

  // Busca na Receita (ADN) as notas tomadas e as emitidas fora do app de TODAS as empresas da conta
  // que têm certificado válido. Roda em segundo plano; a tela acompanha pelo andamento.
  app.post('/empresas/sincronizar', async (req) => {
    const antes = tomadas.situacaoLote(req.usuario.id);
    const lote = await tomadas.iniciarLote(req.usuario.id, { aguardar: config.serverless });
    if (!antes.emAndamento) await auditar(db, { usuarioId: req.usuario.id, acao: 'empresas.sincronizacao_iniciada', detalhes: { empresas: lote.total }, ip: req.ip });
    return lote;
  });
  app.get('/empresas/sincronizacao', async (req) => tomadas.situacaoLote(req.usuario.id));

  app.delete('/empresas/:id', async (req) => {
    await repo.removerPrestador(req.usuario.id, req.params.id);
    emissao.fecharClientesDoPrestador(req.params.id);
    await auditar(db, { usuarioId: req.usuario.id, acao: 'empresa.removida', entidade: 'prestador', entidadeId: req.params.id, ip: req.ip });
    return { ok: true };
  });

  // ---------- certificado do procurador (escritório ou contador) ----------
  // Um certificado para todas as empresas que concederam procuração eletrônica NFS-e.
  const fecharProcuradas = async (usuarioId) => {
    for (const e of await repo.listarPrestadores(usuarioId)) if (e.usaProcuracao) emissao.fecharClientesDoPrestador(e.id);
  };
  app.get('/procurador', async (req) => {
    const empresas = await repo.listarPrestadores(req.usuario.id);
    return { certificado: certPublico(await repo.certificadoProcurador(req.usuario.id)), empresasPorProcuracao: empresas.filter((e) => e.usaProcuracao).length, empresas: empresas.length };
  });
  app.post('/procurador/certificado', async (req) => {
    const { pfx, senha, info } = lerPfxEnviado(req.body);
    const problemas = verificarParaProcurador(info);
    if (problemas.length) throw new ErroApp(422, 'Este certificado não pode ser usado como procurador.', { problemas });
    await repo.salvarCertificadoProcurador(req.usuario.id, { pfx, senha, info });
    await fecharProcuradas(req.usuario.id);
    await auditar(db, { usuarioId: req.usuario.id, acao: 'certificado_procurador.enviado', detalhes: { validoAte: info.validoAte, emissor: info.emissor }, ip: req.ip });
    return { certificado: certPublico(await repo.certificadoProcurador(req.usuario.id)) };
  });
  // Liga ou desliga a procuração em várias empresas de uma vez (escritórios cuidam de dezenas).
  app.put('/procurador/empresas', async (req) => {
    const ativa = req.body?.ativa === true;
    const ids = Array.isArray(req.body?.empresas) ? [...new Set(req.body.empresas.map(String))].slice(0, 500) : [];
    if (!ids.length) throw new ErroApp(422, 'Escolha ao menos uma empresa.');
    if (ativa && !await repo.certificadoProcurador(req.usuario.id)) throw new ErroApp(409, 'Envie primeiro o certificado do escritório (procurador).', { acao: 'procurador' });
    const minhas = new Map((await repo.listarPrestadores(req.usuario.id)).map((e) => [e.id, e]));
    let alteradas = 0;
    for (const id of ids) {
      const e = minhas.get(id);
      if (!e || !!e.usaProcuracao === ativa) continue; // de outra conta, removida ou já no estado pedido
      await repo.definirProcuracao(req.usuario.id, id, ativa);
      emissao.fecharClientesDoPrestador(id);
      await auditar(db, { usuarioId: req.usuario.id, prestadorId: id, acao: ativa ? 'procuracao.ativada' : 'procuracao.desativada', detalhes: { emLote: true }, ip: req.ip });
      alteradas += 1;
    }
    return { alteradas, empresas: (await repo.listarPrestadores(req.usuario.id)).map(resumo) };
  });
  app.delete('/procurador/certificado', async (req) => {
    await repo.removerCertificadoProcurador(req.usuario.id);
    await fecharProcuradas(req.usuario.id);
    await auditar(db, { usuarioId: req.usuario.id, acao: 'certificado_procurador.removido', ip: req.ip });
    return { ok: true };
  });

  // Dados públicos do CNPJ para preencher empresa ou cliente (o usuário confere antes de salvar).
  app.get('/cnpj/:cnpj', async (req) => {
    await limites.consumir(`cnpj:${req.usuario.id}`, 60, 60_000);
    return { cnpj: await consultarCnpj(req.params.cnpj) };
  });
}
