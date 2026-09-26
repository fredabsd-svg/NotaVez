import { rascunho as lerRascunho } from '../util/entrada.js';
import { hojeBrasilia } from '../fiscal/dps.js';
import { servicoNacional, municipio } from '../fiscal/tabelas.js';
import { ambientesSefin } from '../config.js';
import { mascararDocumento, formatarDocumento } from '../util/documentos.js';
import { ErroApp, naoEncontrado } from '../util/erros.js';
import { auditar } from '../security/auditoria.js';
import { exigirPrestador } from './perfil.js';

const ROTULOS = {
  rascunho: { rotulo: 'Rascunho', aviso: 'Ainda não é nota fiscal.' },
  enviando: { rotulo: 'Enviando', aviso: 'Aguardando a resposta da Receita.' },
  pendente: { rotulo: 'Pendente de confirmação', aviso: 'A Receita não confirmou a emissão. Não emita de novo: toque em "Verificar situação".' },
  rejeitada: { rotulo: 'Rejeitada', aviso: 'A Receita recusou. Nenhuma nota foi emitida. Corrija e envie de novo.' },
  emitida: { rotulo: 'Emitida', aviso: 'NFS-e confirmada pela Receita.' },
};

export function resumoNota(repo, prestador, n, completo = false) {
  const r = n.rascunho || {};
  const amb = ambientesSefin[n.ambiente || prestador.ambiente];
  const nac = servicoNacional(r.cTribNac);
  const base = {
    id: n.id,
    situacao: n.situacao,
    ...ROTULOS[n.situacao],
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
    localPrestacao: municipio(r.localPrestacaoIbge || prestador.municipioIbge),
    servicoNacional: nac,
    dps: n.idDps ? { id: n.idDps, serie: n.serie, numero: n.nDps, tentativas: n.tentativas, ultimoEnvioEm: n.ultimoEnvioEm } : null,
    documentos: n.situacao === 'emitida' ? {
      xml: n.temXml,
      // DANFSe: a API de geração do ADN foi desativada em 03/08/2026 (NT 008).
      // O documento auxiliar oficial fica disponível na Consulta Pública pela chave.
      consultaPublica: n.chaveAcesso && amb?.consultaPublica ? `${amb.consultaPublica}${n.chaveAcesso}` : null,
    } : null,
    historicoEnvio: repo.chamadas(n.id),
  };
}

// Mantém os dados do tomador iguais ao cadastro atual do cliente.
function comTomadorAtual(repo, prestadorId, r) {
  if (!r.clienteId) return r;
  const c = repo.cliente(prestadorId, r.clienteId);
  if (!c) return { ...r, clienteId: null };
  return { ...r, tomador: { tipo: c.tipo, documento: c.documento, nome: c.nome, email: c.email, fone: c.fone, endereco: c.endereco, inscricaoMunicipal: c.inscricaoMunicipal } };
}

// Serviço salvo → preenche código e (se vazia) a descrição.
function comServico(repo, prestadorId, r) {
  if (!r.servicoId) return r;
  const s = repo.servico(prestadorId, r.servicoId);
  if (!s) return { ...r, servicoId: null };
  return { ...r, cTribNac: s.cTribNac, cTribMun: s.cTribMun, cNBS: s.cNBS, descricao: r.descricao || s.descricao, valor: r.valor || s.valorPadrao || '' };
}

export async function rotasNotas(app) {
  const { repo, db, emissao } = app.ctx;

  app.get('/notas', async (req) => {
    const p = exigirPrestador(req);
    const q = String(req.query?.q || '').toLowerCase().trim();
    let notas = repo.listarNotas(p.id, { situacao: req.query?.situacao || undefined, limite: 200 });
    if (q) notas = notas.filter((n) => (n.rascunho?.tomador?.nome || '').toLowerCase().includes(q) || (n.nNfse || '').includes(q) || (n.chaveAcesso || '').includes(q));
    return { notas: notas.map((n) => resumoNota(repo, p, n)) };
  });

  app.get('/notas/:id', async (req) => {
    const p = exigirPrestador(req);
    const n = repo.nota(p.id, req.params.id);
    if (!n) throw naoEncontrado('Nota');
    return { nota: resumoNota(repo, p, n, true) };
  });

  // Cria rascunho. O app pode mandar o próprio id (rascunho criado offline).
  app.post('/notas', async (req) => {
    const p = exigirPrestador(req);
    const id = req.body?.id && /^[0-9a-f-]{36}$/i.test(req.body.id) ? req.body.id : null;
    if (id && repo.notaPorId(id)) {
      const existente = repo.nota(p.id, id);
      if (!existente) throw new ErroApp(409, 'Identificador de rascunho em uso.');
      return { nota: resumoNota(repo, p, existente, true) };
    }
    const r = comTomadorAtual(repo, p.id, comServico(repo, p.id, lerRascunho(req.body?.rascunho)));
    if (!r.competencia) r.competencia = hojeBrasilia();
    const novo = repo.criarNota(p.id, r, { id });
    auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'rascunho.criado', entidade: 'nota', entidadeId: novo, ip: req.ip });
    return { nota: resumoNota(repo, p, repo.nota(p.id, novo), true) };
  });

  app.put('/notas/:id', async (req) => {
    const p = exigirPrestador(req);
    const atual = repo.nota(p.id, req.params.id);
    if (!atual) throw naoEncontrado('Nota');
    if (!['rascunho', 'rejeitada'].includes(atual.situacao)) throw new ErroApp(409, 'Esta nota já foi enviada e não pode mais ser alterada. Use "Clonar" para criar outra.');
    const anterior = atual.rascunho;
    let r = lerRascunho(req.body?.rascunho);
    if (r.servicoId && r.servicoId !== anterior.servicoId) r = comServico(repo, p.id, r);
    r = comTomadorAtual(repo, p.id, r);
    if (!repo.atualizarRascunho(p.id, atual.id, r, req.body?.versao)) {
      throw new ErroApp(409, 'Este rascunho foi alterado em outro aparelho. Recarregue para ver a versão mais recente.');
    }
    return { nota: resumoNota(repo, p, repo.nota(p.id, atual.id), true) };
  });

  app.delete('/notas/:id', async (req) => {
    const p = exigirPrestador(req);
    if (!repo.removerRascunho(p.id, req.params.id)) throw new ErroApp(409, 'Só rascunhos e notas rejeitadas podem ser descartados.');
    auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'rascunho.descartado', entidade: 'nota', entidadeId: req.params.id, ip: req.ip });
    return { ok: true };
  });

  // Validação para a tela de Revisão (não envia nada).
  app.post('/notas/:id/validar', async (req) => {
    const p = exigirPrestador(req);
    const n = repo.nota(p.id, req.params.id);
    if (!n) throw naoEncontrado('Nota');
    const v = await emissao.validar(p, comTomadorAtual(repo, p.id, n.rascunho));
    return { ok: v.ok, erros: v.erros, exigencias: v.exigencias, regime: p.opSimpNac, regApTribSN: p.regApTribSN || null };
  });

  app.post('/notas/:id/emitir', async (req) => {
    const p = exigirPrestador(req);
    const n = repo.nota(p.id, req.params.id);
    if (!n) throw naoEncontrado('Nota');
    if (['rascunho', 'rejeitada'].includes(n.situacao)) {
      const atualizado = comTomadorAtual(repo, p.id, n.rascunho);
      if (JSON.stringify(atualizado) !== JSON.stringify(n.rascunho)) repo.atualizarRascunho(p.id, n.id, atualizado);
    }
    auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'emissao.solicitada', entidade: 'nota', entidadeId: n.id, ip: req.ip });
    const resultado = await emissao.emitir(p, n.id);
    auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: `emissao.${resultado.situacao}`, entidade: 'nota', entidadeId: n.id, detalhes: { codigos: resultado.erros?.map((e) => e.codigo) }, ip: req.ip });
    if (n.rascunho.clienteId) repo.marcarClienteUsado(p.id, n.rascunho.clienteId);
    if (n.rascunho.servicoId) repo.marcarServicoUsado(p.id, n.rascunho.servicoId);
    return { nota: resumoNota(repo, p, resultado, true) };
  });

  app.post('/notas/:id/verificar', async (req) => {
    const p = exigirPrestador(req);
    const r = await emissao.verificar(p, req.params.id);
    auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'emissao.verificada', entidade: 'nota', entidadeId: req.params.id, detalhes: { situacao: r.situacao }, ip: req.ip });
    return { nota: resumoNota(repo, p, r, true) };
  });

  // Clonar: novo rascunho com cliente, serviço e local; NUNCA copia número,
  // chave, DPS ou situação. Competência, valor, descrição e tributação exigem revisão.
  function clonar(req, origem) {
    const p = exigirPrestador(req);
    if (!origem) throw new ErroApp(404, 'Ainda não há nota emitida para clonar.');
    const o = origem.rascunho;
    const r = comTomadorAtual(repo, p.id, {
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
    const id = repo.criarNota(p.id, r, { origemId: origem.id });
    auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'nota.clonada', entidade: 'nota', entidadeId: id, detalhes: { origem: origem.id }, ip: req.ip });
    return { nota: resumoNota(repo, p, repo.nota(p.id, id), true) };
  }
  app.post('/notas/clonar-ultima', async (req) => clonar(req, repo.ultimaEmitida(exigirPrestador(req).id)));
  app.post('/notas/:id/clonar', async (req) => clonar(req, repo.nota(exigirPrestador(req).id, req.params.id)));

  // XML oficial da NFS-e (como devolvido pela Sefin Nacional).
  app.get('/notas/:id/xml', async (req, reply) => {
    const p = exigirPrestador(req);
    let n = repo.nota(p.id, req.params.id);
    if (!n || n.situacao !== 'emitida') throw new ErroApp(404, 'XML disponível apenas para notas emitidas.');
    if (!n.temXml) n = await emissao.buscarXml(p, n.id);
    const xml = repo.xmlNfse(n.id);
    if (!xml) throw new ErroApp(503, 'O XML ainda não foi obtido da Receita. Tente novamente em instantes.');
    auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'nota.xml_baixado', entidade: 'nota', entidadeId: n.id, ip: req.ip });
    return reply.header('Content-Type', 'application/xml; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="NFSe-${n.chaveAcesso}.xml"`).send(xml);
  });
}
