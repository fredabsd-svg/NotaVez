import { cliente as lerCliente } from '../util/entrada.js';
import { mascararDocumento, formatarDocumento, somenteDigitos, normalizarCnpj } from '../util/documentos.js';
import { ErroApp, naoEncontrado } from '../util/erros.js';
import { auditar } from '../security/auditoria.js';
import { exigirPrestador } from './perfil.js';

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const publico = (c, completo = false) => ({
  id: c.id, tipo: c.tipo, nome: c.nome,
  documento: completo ? c.documento : undefined,
  documentoExibicao: completo ? formatarDocumento(c.tipo, c.documento) : mascararDocumento(c.tipo, c.documento),
  email: completo ? c.email : undefined, fone: completo ? c.fone : undefined,
  endereco: completo ? c.endereco : undefined, inscricaoMunicipal: completo ? c.inscricaoMunicipal : undefined,
  temEndereco: !!c.endereco, usadoEm: c.usadoEm,
});

export async function rotasClientes(app) {
  const { repo, db } = app.ctx;

  // Busca por nome, CPF ou CNPJ (os dados são decifrados só em memória).
  app.get('/', async (req) => {
    const p = exigirPrestador(req);
    const q = semAcento(req.query?.q || '').trim();
    const dig = somenteDigitos(q);
    const alnum = normalizarCnpj(q);
    let lista = repo.listarClientes(p.id);
    if (q) {
      lista = lista.filter((c) => semAcento(c.nome).includes(q)
        || (dig.length >= 3 && c.documento.includes(dig))
        || (alnum.length >= 3 && c.documento.includes(alnum)));
    }
    return { clientes: lista.slice(0, 100).map((c) => publico(c)) };
  });

  app.get('/:id', async (req) => {
    const c = repo.cliente(exigirPrestador(req).id, req.params.id);
    if (!c) throw naoEncontrado('Cliente');
    return { cliente: publico(c, true) };
  });

  app.post('/', async (req) => {
    const p = exigirPrestador(req);
    const dados = lerCliente(req.body || {});
    const existente = repo.clientePorDocumento(p.id, dados.documento);
    if (existente) throw new ErroApp(409, `Você já cadastrou este ${dados.tipo} como "${existente.nome}".`, { clienteId: existente.id });
    const id = repo.salvarCliente(p.id, null, dados);
    auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'cliente.criado', entidade: 'cliente', entidadeId: id, ip: req.ip });
    return { cliente: publico(repo.cliente(p.id, id), true) };
  });

  app.put('/:id', async (req) => {
    const p = exigirPrestador(req);
    if (!repo.cliente(p.id, req.params.id)) throw naoEncontrado('Cliente');
    const dados = lerCliente(req.body || {});
    const outro = repo.clientePorDocumento(p.id, dados.documento);
    if (outro && outro.id !== req.params.id) throw new ErroApp(409, `Este documento já pertence ao cliente "${outro.nome}".`);
    repo.salvarCliente(p.id, req.params.id, dados);
    auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'cliente.editado', entidade: 'cliente', entidadeId: req.params.id, ip: req.ip });
    return { cliente: publico(repo.cliente(p.id, req.params.id), true) };
  });

  app.delete('/:id', async (req) => {
    const p = exigirPrestador(req);
    repo.removerCliente(p.id, req.params.id);
    auditar(db, { usuarioId: req.usuario.id, prestadorId: p.id, acao: 'cliente.removido', entidade: 'cliente', entidadeId: req.params.id, ip: req.ip });
    return { ok: true };
  });
}
