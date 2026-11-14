import { rascunho as lerRascunho } from '../util/entrada.js';
import { hojeBrasilia } from '../fiscal/dps.js';
import { servicoNacional, municipio } from '../fiscal/tabelas.js';
import { ambientesSefin, config } from '../config.js';
import { gerarDanfse } from '../fiscal/danfse/index.js';
import { mascararDocumento, formatarDocumento } from '../util/documentos.js';
import { ErroApp, naoEncontrado } from '../util/erros.js';
import { auditar } from '../security/auditoria.js';
import { exigirPrestador, perfilPublico } from './perfil.js';
import { roteiroEmissor, lerNfseImportada, manterVinculos } from '../fiscal/assistida.js';

const ROTULOS = {
  rascunho: { rotulo: 'Rascunho', aviso: 'Ainda não é nota fiscal.' },
  enviando: { rotulo: 'Enviando', aviso: 'Aguardando confirmação da Receita. Use “Verificar situação” se a resposta demorar; não emita outra nota para o mesmo serviço.' },
  pendente: { rotulo: 'Pendente de confirmação', aviso: 'A Receita não confirmou a emissão. Não emita de novo: toque em "Verificar situação".' },
  rejeitada: { rotulo: 'Rejeitada', aviso: 'A Receita recusou. Nenhuma nota foi emitida. Corrija e envie de novo.' },
  emitida: { rotulo: 'Emitida', aviso: 'NFS-e confirmada pela Receita.' },
  // Cancelamento feito no portal e visto na sincronização com a Receita: não soma em nenhum total.
  cancelada: { rotulo: 'Cancelada', aviso: 'Esta NFS-e foi cancelada na Receita. Ela não vale como nota fiscal e não entra nos totais.' },
};

// O que as telas mostram sobre a busca na Receita: quando deu certo e, se a última foi recusada, o motivo.
export async function sincronizacaoPublica(repo, p) {
  const d = await repo.distribuicao(p.id, p.ambiente, p.documento);
  return { ultimoNsu: d.ultimoNsu, sincronizadoEm: d.sincronizadoEm, recusadaEm: d.recusadaEm, recusaMotivo: d.recusaMotivo };
}

// Uma busca no ADN serve às duas telas (Notas e Notas tomadas): mesma fila, mesma resposta.
export async function sincronizarEmpresa(app, req) {
  const p = exigirPrestador(req);
  const r = await app.ctx.tomadas.sincronizar(p);
  await auditar(app.ctx.db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'tomadas.sincronizadas',
    detalhes: { novas: r.novas, canceladas: r.canceladas, emitidas: r.emitidas, emitidasCanceladas: r.emitidasCanceladas }, ip: req.ip });
  return r;
}

export async function resumoNota(repo, prestador, n, completo = false) {
  const r = n.rascunho || {};
  const amb = ambientesSefin[n.ambiente || prestador.ambiente];
  const nac = servicoNacional(r.cTribNac);
  const base = {
    id: n.id,
    situacao: n.situacao,
    ...ROTULOS[n.situacao],
    // Emitida pela própria pessoa no Emissor Nacional: o app só guardou o XML que ela trouxe.
    ...(n.situacao === 'emitida' && n.canal === 'emissor_nacional'
      ? { rotulo: 'Emitida (Emissor Nacional)', aviso: n.importadaConferida
        ? 'Emitida por você no Emissor Nacional; o app buscou a versão oficial na Receita.'
        : 'Emitida por você no Emissor Nacional; o XML enviado não foi conferido com a Receita porque a empresa não tinha certificado no app. Confira na Consulta Pública: o PDF sai com a marca "NÃO CONFERIDA". Depois de enviar o certificado, importe o mesmo XML de novo para conferir.' } : {}),
    // Emitida fora do app e trazida da própria Receita na sincronização.
    ...(n.situacao === 'emitida' && n.canal === 'sincronizada'
      ? { rotulo: 'Emitida (fora do app)', aviso: 'Emitida fora deste app (no Emissor Nacional ou em outro sistema). O app trouxe a versão oficial da Receita na sincronização.' } : {}),
    importadaConferida: n.canal === 'emissor_nacional' ? n.importadaConferida : undefined,
    canal: n.canal,
    clienteNome: r.tomador?.nome || null,
    valor: n.valor,
    competencia: n.competencia,
    descricao: r.descricao ? (completo ? r.descricao : r.descricao.slice(0, 80)) : '',
    servico: nac ? { codigo: nac.codigo, descricao: nac.descricao } : null,
    ambiente: n.ambiente,
    homologacao: n.ambiente === 'producao_restrita',
    chaveAcesso: n.chaveAcesso,
    nNfse: n.nNfse,
    emitidaEm: n.emitidaEm,
    atualizadoEm: n.atualizadoEm,
    origemId: n.origemId,
    erros: n.erros,
    alertas: n.alertas,
    versao: n.versao,
  };
  if (!completo) return base;
  return {
    ...base,
    rascunho: r,
    tomadorExibicao: r.tomador?.tipo && r.tomador.tipo !== 'NENHUM'
      ? { ...r.tomador, documentoExibicao: formatarDocumento(r.tomador.tipo, r.tomador.documento) } : null,
    localPrestacao: municipio(r.localPrestacaoIbge || n.contextoEmitente?.municipioIbge || prestador.municipioIbge),
    servicoNacional: nac,
    dps: n.idDps ? { id: n.idDps, serie: n.serie, numero: n.nDps, tentativas: n.tentativas, ultimoEnvioEm: n.ultimoEnvioEm } : null,
    documentos: ['emitida', 'cancelada'].includes(n.situacao) ? {
      xml: n.temXml,
      // DANFSe gerado aqui, a partir do XML oficial (a API do ADN foi desativada em 03/08/2026; NT 008).
      danfse: true,
      consultaPublica: n.chaveAcesso && amb?.consultaPublica ? `${amb.consultaPublica}${n.chaveAcesso}` : null,
    } : null,
    historicoEnvio: await repo.chamadas(n.id),
  };
}

// Mantém os dados do tomador iguais ao cadastro atual do cliente.
export async function comTomadorAtual(repo, prestadorId, r) {
  if (!r.clienteId) return r;
  const c = await repo.cliente(prestadorId, r.clienteId);
  if (!c) return { ...r, clienteId: null };
  return { ...r, tomador: { tipo: c.tipo, documento: c.documento, nome: c.nome, email: c.email, fone: c.fone, endereco: c.endereco, inscricaoMunicipal: c.inscricaoMunicipal } };
}

// Serviço salvo → preenche código e (se vazia) a descrição.
export async function comServico(repo, prestadorId, r) {
  if (!r.servicoId) return r;
  const s = await repo.servico(prestadorId, r.servicoId);
  if (!s) return { ...r, servicoId: null };
  return { ...r, cTribNac: s.cTribNac, cTribMun: s.cTribMun, cNBS: s.cNBS, descricao: r.descricao || s.descricao, valor: r.valor || s.valorPadrao || '' };
}

// Clonar: novo rascunho com cliente, serviço e local; NUNCA copia número,
// chave, DPS ou situação. Competência, valor, descrição e tributação exigem revisão.
// Devolve o id do novo rascunho (usado pela tela e pelo assistente de IA).
export async function clonarNota({ repo, db }, { usuarioId, prestador: p, origem, ip = null, via = null }) {
  if (!origem) throw new ErroApp(404, 'Ainda não há nota emitida para clonar.');
  const o = origem.rascunho;
  const r = await comTomadorAtual(repo, p.id, {
    clienteId: o.clienteId, tomador: o.tomador, servicoId: o.servicoId,
    cTribNac: o.cTribNac, cTribMun: o.cTribMun, cNBS: o.cNBS, descricao: o.descricao,
    competencia: hojeBrasilia(), valor: o.valor, localPrestacaoIbge: o.localPrestacaoIbge,
    // Retenção costuma se repetir com o mesmo cliente; percentuais mudam todo mês → voltam ao valor do perfil.
    issRetido: !!o.issRetido, pAliq: null, pTotTribSN: null,
    // IBS/CBS acompanha o serviço; retenções federais: mantém quais são retidas, valores recalculados pelo usuário.
    cIndOp: o.cIndOp ?? null, cClassTrib: o.cClassTrib ?? null, indFinal: o.indFinal ?? null,
    retencoesFederais: o.retencoesFederais ? { ...o.retencoesFederais, valorContribuicoes: null, irrf: null, cp: null } : null,
    revisar: ['competencia', 'valor', 'descricao', 'tributacao'],
  });
  const id = await repo.criarNota(p.id, r, { origemId: origem.id });
  await auditar(db, { usuarioId, prestadorId: p.id, acao: 'nota.clonada', entidade: 'nota', entidadeId: id, detalhes: { origem: origem.id, ...(via ? { via } : {}) }, ip });
  return id;
}

// Período de competências pedido na lista (?de=AAAA-MM-DD&ate=AAAA-MM-DD). Datas inválidas são ignoradas;
// invertidas, trocam de lugar.
export function periodoDaConsulta(q = {}) {
  const valida = (s) => {
    const t = String(s || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return undefined;
    const d = new Date(`${t}T12:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t ? t : undefined;
  };
  let de = valida(q.de);
  let ate = valida(q.ate);
  if (de && ate && de > ate) [de, ate] = [ate, de];
  return { de, ate };
}

export async function rotasNotas(app) {
  const { repo, db, emissao } = app.ctx;

  app.get('/notas', async (req) => {
    const p = exigirPrestador(req);
    const q = String(req.query?.q || '').toLowerCase().trim();
    const situacao = req.query?.situacao || undefined;
    const { de, ate } = periodoDaConsulta(req.query);
    const competencia = !de && !ate && /^\d{4}-\d{2}$/.test(String(req.query?.competencia || '')) ? req.query.competencia : undefined;
    // Sem filtro, as 200 mais recentes; com mês ou período escolhido, até 1000 (para conferir e baixar em lote).
    const LIMITE = competencia || de || ate ? 1000 : 200;
    let notas = await repo.listarNotas(p.id, { situacao, competencia, de, ate, limite: LIMITE + 1 });
    // Sem esconder em silêncio: a tela avisa quando há mais notas do que as mostradas.
    const limitado = notas.length > LIMITE;
    notas = notas.slice(0, LIMITE);
    if (q) notas = notas.filter((n) => (n.rascunho?.tomador?.nome || '').toLowerCase().includes(q) || (n.nNfse || '').includes(q) || (n.chaveAcesso || '').includes(q));
    return { notas: await Promise.all(notas.map((n) => resumoNota(repo, p, n))), limitado, meses: await repo.mesesDasNotas(p.id, situacao),
      // Para a tela dizer quando foi a última busca na Receita e se dá para buscar (precisa de certificado).
      sincronizacao: await sincronizacaoPublica(repo, p), temCertificado: !!await repo.certificadoEmissao(p), porProcuracao: !!p.usaProcuracao,
      // O filtro "Canceladas" só aparece para quem tem nota cancelada.
      canceladas: (await repo.contarNotasPorSituacao(p.id)).cancelada || 0 };
  });

  // Busca na Receita (ADN) as notas emitidas fora do app e as tomadas; os cancelamentos também.
  app.post('/notas/sincronizar', async (req) => await sincronizarEmpresa(app, req));

  app.get('/notas/:id', async (req) => {
    const p = exigirPrestador(req);
    const n = await repo.nota(p.id, req.params.id);
    if (!n) throw naoEncontrado('Nota');
    return { nota: await resumoNota(repo, p, n, true) };
  });

  // Cria rascunho. O app pode mandar o próprio id (rascunho criado offline).
  app.post('/notas', async (req) => {
    const p = exigirPrestador(req);
    const id = req.body?.id && /^[0-9a-f-]{36}$/i.test(req.body.id) ? req.body.id : null;
    if (id && await repo.notaPorId(id)) {
      const existente = await repo.nota(p.id, id);
      if (!existente) throw new ErroApp(409, 'Identificador de rascunho em uso.');
      return { nota: await resumoNota(repo, p, existente, true) };
    }
    const r = await comTomadorAtual(repo, p.id, await comServico(repo, p.id, lerRascunho(req.body?.rascunho)));
    if (!r.competencia) r.competencia = hojeBrasilia();
    const novo = await repo.criarNota(p.id, r, { id });
    await auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'rascunho.criado', entidade: 'nota', entidadeId: novo, ip: req.ip });
    return { nota: await resumoNota(repo, p, await repo.nota(p.id, novo), true) };
  });

  app.put('/notas/:id', async (req) => {
    const p = exigirPrestador(req);
    const atual = await repo.nota(p.id, req.params.id);
    if (!atual) throw naoEncontrado('Nota');
    if (!['rascunho', 'rejeitada'].includes(atual.situacao)) throw new ErroApp(409, 'Esta nota já foi enviada e não pode mais ser alterada. Use "Clonar" para criar outra.');
    if (!Number.isSafeInteger(req.body?.versao) || req.body.versao < 1) throw new ErroApp(409, 'Informe a versão do rascunho para salvar. Recarregue a nota.');
    const anterior = atual.rascunho;
    let r = lerRascunho(req.body?.rascunho);
    if (r.servicoId && r.servicoId !== anterior.servicoId) r = await comServico(repo, p.id, r);
    r = await comTomadorAtual(repo, p.id, r);
    if (!await repo.atualizarRascunho(p.id, atual.id, r, req.body?.versao)) {
      throw new ErroApp(409, 'Este rascunho foi alterado em outro aparelho. Recarregue para ver a versão mais recente.');
    }
    return { nota: await resumoNota(repo, p, await repo.nota(p.id, atual.id), true) };
  });

  app.delete('/notas/:id', async (req) => {
    const p = exigirPrestador(req);
    if (!await repo.removerRascunho(p.id, req.params.id)) throw new ErroApp(409, 'Só rascunhos e notas rejeitadas podem ser descartados.');
    await auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'rascunho.descartado', entidade: 'nota', entidadeId: req.params.id, ip: req.ip });
    return { ok: true };
  });

  // Validação para a tela de Revisão (não envia nada).
  app.post('/notas/:id/validar', async (req) => {
    const p = exigirPrestador(req);
    const n = await repo.nota(p.id, req.params.id);
    if (!n) throw naoEncontrado('Nota');
    const v = await emissao.validarNota(p, n.id, req.body?.versao);
    return { perfilRevisado: perfilPublico(p), versao: v.versao, revisao: v.revisao, ok: v.ok, erros: v.erros, exigencias: v.exigencias, regime: p.opSimpNac, regApTribSN: p.regApTribSN || null };
  });

  app.post('/notas/:id/emitir', async (req) => {
    const p = exigirPrestador(req);
    const n = await repo.nota(p.id, req.params.id);
    if (!n) throw naoEncontrado('Nota');
    if (['rascunho', 'rejeitada'].includes(n.situacao) && (!Number.isSafeInteger(req.body?.versao) || req.body.versao < 1 || typeof req.body?.revisao !== 'string')) {
      throw new ErroApp(409, 'Revise a versão atual do rascunho antes de emitir.');
    }
    await auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'emissao.solicitada', entidade: 'nota', entidadeId: n.id, ip: req.ip });
    const resultado = await emissao.emitir(p, n.id, { versao: req.body?.versao, revisao: req.body?.revisao });
    await auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: `emissao.${resultado.situacao}`, entidade: 'nota', entidadeId: n.id, detalhes: { codigos: resultado.erros?.map((e) => e.codigo) }, ip: req.ip });
    if (n.rascunho.clienteId) await repo.marcarClienteUsado(p.id, n.rascunho.clienteId);
    if (n.rascunho.servicoId) await repo.marcarServicoUsado(p.id, n.rascunho.servicoId);
    return { nota: await resumoNota(repo, p, resultado, true) };
  });

  app.post('/notas/:id/verificar', async (req) => {
    const p = exigirPrestador(req);
    const r = await emissao.verificar(p, req.params.id);
    await auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'emissao.verificada', entidade: 'nota', entidadeId: req.params.id, detalhes: { situacao: r.situacao }, ip: req.ip });
    return { nota: await resumoNota(repo, p, r, true) };
  });

  async function clonar(req, origem) {
    const p = exigirPrestador(req);
    return { nota: await resumoNota(repo, p, await repo.nota(p.id, await clonarNota({ repo, db }, { usuarioId: req.usuario.id, prestador: p, origem, ip: req.ip })), true) };
  }
  app.post('/notas/clonar-ultima', async (req) => clonar(req, await repo.ultimaEmitida(exigirPrestador(req).id)));
  app.post('/notas/:id/clonar', async (req) => clonar(req, await repo.nota(exigirPrestador(req).id, req.params.id)));

  // Emissão assistida: roteiro com os valores que iriam na DPS, para preencher o Emissor Nacional.
  app.get('/notas/:id/assistida', async (req) => {
    const p = exigirPrestador(req);
    const n = await repo.nota(p.id, req.params.id);
    if (!n) throw naoEncontrado('Nota');
    if (!['rascunho', 'rejeitada'].includes(n.situacao)) throw new ErroApp(409, 'Esta nota já saiu do rascunho.', { notaId: n.id });
    const v = await emissao.validar(p, n.rascunho);
    const amb = ambientesSefin[p.ambiente];
    return {
      nota: await resumoNota(repo, p, n, true),
      roteiro: roteiroEmissor({ prestador: p, nota: n, validacao: v }),
      // Pontos que a validação do app encontrou: o Emissor Nacional deve recusar os mesmos.
      avisos: v.erros.map((e) => ({ campo: e.campo, mensagem: e.mensagem, regra: e.regra })),
      emissorNacional: amb?.emissorNacional || null,
      emitente: { nome: p.nome, documento: p.documento, documentoFormatado: formatarDocumento(p.tipoDocumento, p.documento) },
      homologacao: p.ambiente === 'producao_restrita',
    };
  });

  // XML da NFS-e emitida no Emissor Nacional → histórico (com notaId, conclui aquele rascunho).
  app.post('/notas/importar', async (req) => {
    const p = exigirPrestador(req);
    let dados = await lerNfseImportada(req.body?.xml, { exigirAssinatura: !config.demo });
    if (dados.emitente?.documento !== p.documento) {
      throw new ErroApp(422, `Esta NFS-e foi emitida por ${dados.emitente ? `${dados.emitente.tipo} ${formatarDocumento(dados.emitente.tipo, dados.emitente.documento)}` : 'outro emitente'}, não pela empresa aberta (${formatarDocumento(p.tipoDocumento, p.documento)}).`);
    }
    const notaId = req.body?.notaId ? String(req.body.notaId) : null;
    // A mesma DPS enviada pelo app e ainda sem confirmação: quem resolve é a verificação dela.
    const enviada = dados.idDps ? await repo.notaPorIdDps(p.id, dados.idDps) : null;
    if (enviada && enviada.id !== notaId && ['pendente', 'enviando'].includes(enviada.situacao)) {
      throw new ErroApp(409, 'Esta NFS-e é da nota que o app enviou e aguarda confirmação. Abra essa nota e toque em "Verificar situação".', { notaId: enviada.id });
    }
    // Com certificado disponível, a versão guardada é a oficial da Receita (não o arquivo enviado).
    let xml = req.body.xml;
    let conferida = false;
    const conf = await emissao.conferirNfse(p, dados.chaveAcesso);
    if (conf?.tipo === 'nao_encontrada') throw new ErroApp(422, 'A Receita não encontrou NFS-e com a chave deste arquivo. Confira se é o XML certo, baixado do Emissor Nacional.');
    // Com certificado, só entra o que a Receita confirmou: se ela não respondeu, nada é gravado.
    if (conf && conf.tipo !== 'ok') throw new ErroApp(503, 'A Receita não respondeu para conferir esta NFS-e. Nada foi gravado; tente de novo em alguns minutos.');
    if (conf?.tipo === 'ok') {
      const oficial = await lerNfseImportada(conf.nfseXml, { exigirAssinatura: false });
      if (oficial.chaveAcesso !== dados.chaveAcesso || oficial.emitente?.documento !== p.documento) throw new ErroApp(422, 'O XML enviado não corresponde à NFS-e registrada na Receita.');
      dados = oficial;
      xml = conf.nfseXml;
      conferida = true;
    }
    // Já importada sem conferência e agora conferida: atualiza para a versão oficial.
    const existente = await repo.notaPorChave(p.id, dados.chaveAcesso);
    if (existente && conferida && existente.canal === 'emissor_nacional' && !existente.importadaConferida) {
      // Mantém só o vínculo com cliente e serviço salvos; o resto vem da versão oficial.
      const rascunhoOficial = await manterVinculos(repo, p.id, existente.rascunho, dados.rascunho);
      await repo.reconferirImportada(p.id, existente.id, { xml, nNfse: dados.nNfse, emitidaEm: dados.emitidaEm, rascunho: rascunhoOficial, ambiente: dados.ambiente });
      await auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'nota.reconferida', entidade: 'nota', entidadeId: existente.id, ip: req.ip });
      return { nota: await resumoNota(repo, p, await repo.nota(p.id, existente.id), true), conferida: true, reconferida: true };
    }
    let rascunho = dados.rascunho;
    if (notaId) {
      const atual = await repo.nota(p.id, notaId);
      if (!atual) throw naoEncontrado('Nota');
      rascunho = { ...rascunho, clienteId: atual.rascunho?.clienteId || null, servicoId: atual.rascunho?.servicoId || null };
    }
    const id = await repo.registrarImportada(p.id, notaId, { ...dados, rascunho, xml, contexto: p, conferida });
    await auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'nota.importada', entidade: 'nota', entidadeId: id, detalhes: { assinada: dados.assinatura?.presente ?? true, conferida }, ip: req.ip });
    if (rascunho.clienteId) await repo.marcarClienteUsado(p.id, rascunho.clienteId);
    return { nota: await resumoNota(repo, p, await repo.nota(p.id, id), true), assinatura: dados.assinatura, conferida };
  });

  // XML oficial da NFS-e (como devolvido pela Sefin Nacional).
  app.get('/notas/:id/xml', async (req, reply) => {
    const p = exigirPrestador(req);
    let n = await repo.nota(p.id, req.params.id);
    if (!n || !['emitida', 'cancelada'].includes(n.situacao)) throw new ErroApp(404, 'XML disponível apenas para notas emitidas.');
    if (!n.temXml) n = await emissao.buscarXml(p, n.id);
    const xml = await repo.xmlNfse(n.id);
    if (!xml) throw new ErroApp(503, 'O XML ainda não foi obtido da Receita. Tente novamente em instantes.');
    await auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'nota.xml_baixado', entidade: 'nota', entidadeId: n.id, ip: req.ip });
    return reply.header('Content-Type', 'application/xml; charset=utf-8')
      // XML trazido pela pessoa e não conferido com a Receita: o nome do arquivo avisa.
      .header('Content-Disposition', `attachment; filename="${n.canal === 'emissor_nacional' && !n.importadaConferida ? 'NAO-CONFERIDA-' : ''}NFSe-${n.chaveAcesso}.xml"`).send(xml);
  });

  // DANFSe (NT 008) em PDF, gerado SÓ a partir do XML oficial da NFS-e.
  app.get('/notas/:id/danfse', async (req, reply) => {
    const p = exigirPrestador(req);
    let n = await repo.nota(p.id, req.params.id);
    if (!n || !['emitida', 'cancelada'].includes(n.situacao)) throw new ErroApp(404, 'O DANFSe só existe para notas emitidas.');
    if (!n.temXml) n = await emissao.buscarXml(p, n.id);
    const xml = await repo.xmlNfse(n.id);
    if (!xml) throw new ErroApp(503, 'O XML ainda não foi obtido da Receita. Tente novamente em instantes.');
    // No modo demonstração a Receita é simulada: o PDF leva a marca "SIMULAÇÃO".
    // XML que o app não conseguiu conferir com a Receita não vira DANFSe "limpo".
    const naoConferida = n.canal === 'emissor_nacional' && !n.importadaConferida;
    const pdf = await gerarDanfse(xml, { marcaDagua: config.demo ? 'SIMULAÇÃO' : n.situacao === 'cancelada' ? 'CANCELADA' : naoConferida ? 'NÃO CONFERIDA' : null });
    await auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'nota.danfse_baixado', entidade: 'nota', entidadeId: n.id, ip: req.ip });
    return reply.header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `${req.query?.baixar === '1' ? 'attachment' : 'inline'}; filename="DANFSe-${n.chaveAcesso}.pdf"`).send(pdf);
  });
}
