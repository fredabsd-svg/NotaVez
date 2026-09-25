import { avaliarElegibilidade } from '../fiscal/elegibilidade.js';
import { lerCertificado, verificarParaEmitente, ErroCertificado } from '../fiscal/certificado.js';
import { municipio } from '../fiscal/tabelas.js';
import { lerDocumento, formatarDocumento, somenteDigitos } from '../util/documentos.js';
import { ErroApp, invalido } from '../util/erros.js';
import { auditar } from '../security/auditoria.js';
import { config } from '../config.js';
import { resumoNota } from './notas.js';

export function exigirPrestador(req) {
  if (!req.prestador) throw new ErroApp(409, 'Complete seu perfil fiscal primeiro.', { acao: 'perfil' });
  return req.prestador;
}

const perfilPublico = (p) => p && {
  tipoDocumento: p.tipoDocumento, documento: p.documento, documentoFormatado: formatarDocumento(p.tipoDocumento, p.documento),
  nome: p.nome, municipioIbge: p.municipioIbge, municipio: municipio(p.municipioIbge), opSimpNac: p.opSimpNac,
  inscricaoMunicipal: p.inscricaoMunicipal, email: p.email, fone: p.fone, serieDps: p.serieDps, ambiente: p.ambiente,
};

const certPublico = (c) => c && { titular: c.titular, emissor: c.emissor, validoDe: c.validoDe, validoAte: c.validoAte, enviadoEm: c.criadoEm };

export async function rotasPerfil(app) {
  const { repo, db } = app.ctx;

  app.get('/perfil', async (req) => {
    const cert = req.prestador ? repo.certificadoAtivo(req.prestador.id) : null;
    return {
      perfil: perfilPublico(req.prestador),
      certificado: certPublico(cert),
      elegibilidade: avaliarElegibilidade(req.prestador, cert),
      producaoLiberada: config.producaoLiberada,
    };
  });

  app.put('/perfil', async (req) => {
    const b = req.body || {};
    const doc = lerDocumento(b.documento);
    const erros = {};
    if (!doc || doc.tipo !== 'CNPJ') erros.documento = 'Informe um CNPJ válido.';
    if (!municipio(b.municipioIbge)) erros.municipioIbge = 'Escolha o município do endereço do seu CNPJ.';
    if (!['1', '2', '3'].includes(String(b.opSimpNac))) erros.opSimpNac = 'Escolha sua situação no Simples Nacional.';
    const serie = somenteDigitos(b.serieDps || '1').replace(/^0+/, '') || '1';
    if (Number(serie) < 1 || Number(serie) > 49999) erros.serieDps = 'Série entre 1 e 49999 (faixa de aplicativo próprio).';
    const ambiente = b.ambiente === 'producao' ? 'producao' : 'producao_restrita';
    if (ambiente === 'producao' && !config.producaoLiberada) erros.ambiente = 'A produção ainda não está liberada neste servidor.';
    if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) erros.email = 'E-mail inválido.';
    if (Object.keys(erros).length) throw invalido('Confira os dados do perfil.', erros);
    const id = repo.salvarPrestador(req.usuario.id, {
      tipoDocumento: doc.tipo, documento: doc.numero, nome: String(b.nome || '').trim().slice(0, 300), municipioIbge: String(b.municipioIbge),
      opSimpNac: String(b.opSimpNac), regEspTrib: '0', inscricaoMunicipal: String(b.inscricaoMunicipal || '').trim().slice(0, 15) || null,
      email: String(b.email || '').trim().slice(0, 80) || null, fone: somenteDigitos(b.fone).slice(0, 20) || null, serieDps: serie, ambiente,
    });
    auditar(db, { usuarioId: req.usuario.id, prestadorId: id, acao: 'perfil.salvo', ip: req.ip });
    const p = repo.prestador(id);
    return { perfil: perfilPublico(p), elegibilidade: avaliarElegibilidade(p, repo.certificadoAtivo(id)) };
  });

  // Envio do certificado A1: chega por HTTPS, é verificado e guardado cifrado.
  app.post('/certificado', async (req) => {
    const p = exigirPrestador(req);
    const b = req.body || {};
    if (b.consentimento !== true) throw invalido('Para emitir por você, precisamos da sua autorização para guardar o certificado com segurança.');
    const pfx = Buffer.from(String(b.pfxBase64 || ''), 'base64');
    if (pfx.length < 100 || pfx.length > 200_000) throw invalido('Envie o arquivo do certificado A1 (.pfx ou .p12).');
    let info;
    try { info = lerCertificado(pfx, String(b.senha || '')); } catch (e) {
      if (e instanceof ErroCertificado) throw invalido(e.message);
      throw e;
    }
    const problemas = verificarParaEmitente(info, p.documento);
    if (problemas.length) throw new ErroApp(422, 'Este certificado não pode ser usado para emitir.', { problemas });
    repo.salvarCertificado(p.id, { pfx, senha: String(b.senha), info });
    auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'certificado.enviado', detalhes: { validoAte: info.validoAte, emissor: info.emissor }, ip: req.ip });
    const cert = repo.certificadoAtivo(p.id);
    return { certificado: certPublico(cert), elegibilidade: avaliarElegibilidade(p, cert) };
  });

  app.delete('/certificado', async (req) => {
    const p = exigirPrestador(req);
    repo.removerCertificado(p.id);
    auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'certificado.removido', ip: req.ip });
    return { elegibilidade: avaliarElegibilidade(p, null) };
  });

  // Tela Início: estado da última emissão, contadores e pendências.
  app.get('/inicio', async (req) => {
    const p = req.prestador;
    if (!p) return { perfil: null, elegibilidade: avaliarElegibilidade(null, null) };
    const cert = repo.certificadoAtivo(p.id);
    const ultima = repo.ultimaEnviada(p.id);
    const ultimaEmitida = repo.ultimaEmitida(p.id);
    const todas = repo.listarNotas(p.id, { limite: 500 });
    return {
      perfil: perfilPublico(p),
      elegibilidade: avaliarElegibilidade(p, cert),
      ultima: ultima && resumoNota(repo, p, ultima),
      podeClonar: !!ultimaEmitida,
      rascunhos: todas.filter((n) => n.situacao === 'rascunho').length,
      pendentes: todas.filter((n) => n.situacao === 'pendente').length,
    };
  });
}
