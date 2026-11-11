import { servicoNacional } from '../fiscal/tabelas.js';
import { valorDecimal } from '../util/entrada.js';
import { somenteDigitos } from '../util/documentos.js';
import { invalido, naoEncontrado } from '../util/erros.js';
import { exigirPrestador } from './perfil.js';

function lerServico(b = {}) {
  const erros = {};
  const apelido = String(b.apelido || '').trim().slice(0, 80);
  const cTribNac = somenteDigitos(b.cTribNac).padStart(6, '0').slice(-6);
  const nac = servicoNacional(cTribNac);
  const descricao = String(b.descricao || '').trim().slice(0, 1000);
  if (!apelido) erros.apelido = 'Dê um nome curto para este serviço (ex.: "Manutenção mensal").';
  if (!nac) erros.cTribNac = 'Escolha o código na lista nacional de serviços.';
  if (!descricao) erros.descricao = 'Escreva a descrição que vai na nota.';
  const cNBS = somenteDigitos(b.cNBS) || null;
  if (cNBS && cNBS.length !== 9) erros.cNBS = 'O código NBS tem 9 dígitos.';
  const cTribMun = somenteDigitos(b.cTribMun) || null;
  if (cTribMun && cTribMun.length !== 3) erros.cTribMun = 'O código municipal tem 3 dígitos.';
  if (Object.keys(erros).length) throw invalido('Confira os dados do serviço.', erros);
  return { apelido, cTribNac, cTribMun, cNBS, descricao, valorPadrao: valorDecimal(b.valorPadrao) || null };
}

const publico = (s) => ({ ...s, nacional: servicoNacional(s.cTribNac) });

export async function rotasServicos(app) {
  const { repo } = app.ctx;
  app.get('/', async (req) => ({ servicos: repo.listarServicos(exigirPrestador(req).id).map(publico) }));
  app.get('/:id', async (req) => {
    const s = repo.servico(exigirPrestador(req).id, req.params.id);
    if (!s) throw naoEncontrado('Serviço');
    return { servico: publico(s) };
  });
  app.post('/', async (req) => {
    const p = exigirPrestador(req);
    const id = repo.salvarServico(p.id, null, lerServico(req.body));
    return { servico: publico(repo.servico(p.id, id)) };
  });
  app.put('/:id', async (req) => {
    const p = exigirPrestador(req);
    if (!repo.servico(p.id, req.params.id)) throw naoEncontrado('Serviço');
    repo.salvarServico(p.id, req.params.id, lerServico(req.body));
    return { servico: publico(repo.servico(p.id, req.params.id)) };
  });
  app.delete('/:id', async (req) => {
    repo.removerServico(exigirPrestador(req).id, req.params.id);
    return { ok: true };
  });
}
