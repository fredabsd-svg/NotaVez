// Ferramentas que o assistente de IA usa para operar o emissor. Cada uma reaproveita as mesmas
// regras das telas (validação, máquina de estados da emissão, auditoria): a IA nunca fala direto
// com a Receita nem grava nada que a tela não gravaria. Toda empresa é conferida contra o dono.
import { rascunho as lerRascunho, cliente as lerCliente } from '../util/entrada.js';
import { formatarDocumento, somenteDigitos, normalizarCnpj } from '../util/documentos.js';
import { ErroApp, naoEncontrado } from '../util/erros.js';
import { auditar } from '../security/auditoria.js';
import { hojeBrasilia } from '../fiscal/dps.js';
import { buscarMunicipios, buscarServicos, municipio, servicoNacional } from '../fiscal/tabelas.js';
import { opcoesIbsCbs, inicioObrigatoriedade } from '../fiscal/ibscbs.js';
import { escolherPacote } from '../fiscal/regras/index.js';
import { resumoNota, comTomadorAtual, comServico, clonarNota } from '../routes/notas.js';
import { perfilPublico, regimeDescricao, elegibilidadeDe, painelDe, certPublico, situacaoReceita } from '../routes/perfil.js';
import { lerServico } from '../routes/servicos.js';

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const LIMITE_LISTA = 40;

// ------------------------------------------------------------------ esquemas
const empresaId = { type: 'string', description: 'Id da empresa (veja listar_empresas). Omita para usar a empresa aberta no app.' };
const notaId = { type: 'string', description: 'Id interno da nota (o "id" devolvido por criar_rascunho, listar_notas etc.).' };
const endereco = {
  type: 'object', description: 'Endereço completo do cliente (obrigatório para CNPJ).',
  properties: {
    cep: { type: 'string', description: '8 dígitos' }, municipioIbge: { type: 'string', description: 'Código IBGE de 7 dígitos (use buscar_municipio)' },
    logradouro: { type: 'string' }, numero: { type: 'string' }, complemento: { type: 'string' }, bairro: { type: 'string' },
  },
};
const camposNota = {
  clienteId: { type: 'string', description: 'Id de um cliente salvo (preferível: os dados do cliente são puxados do cadastro).' },
  tomador: {
    type: 'object', description: 'Tomador avulso, só se não houver cliente salvo. tipo NENHUM = nota sem tomador identificado (só pessoa física consumidora, quando permitido).',
    properties: {
      tipo: { type: 'string', enum: ['CPF', 'CNPJ', 'NENHUM'] }, documento: { type: 'string' }, nome: { type: 'string' },
      email: { type: 'string' }, fone: { type: 'string' }, endereco, inscricaoMunicipal: { type: 'string' },
    },
  },
  servicoId: { type: 'string', description: 'Id de um serviço salvo (preenche código, descrição e valor de costume).' },
  cTribNac: { type: 'string', description: 'Código de Tributação Nacional, 6 dígitos (item+subitem+desdobro da LC 116). Use buscar_codigo_servico.' },
  cTribMun: { type: 'string', description: 'Código de tributação municipal (3 dígitos), só se a prefeitura exigir.' },
  cNBS: { type: 'string', description: 'Código NBS (9 dígitos). Obrigatório no Lucro Presumido/Real quando o serviço tem mais de uma NBS (veja detalhar_codigo_servico).' },
  descricao: { type: 'string', description: 'Descrição do serviço que vai impressa na nota (até 1.000 caracteres).' },
  valor: { type: 'string', description: 'Valor do serviço em reais, com ponto decimal. Ex.: "1500.00".' },
  competencia: { type: 'string', description: 'Data da competência (quando o serviço foi prestado), AAAA-MM-DD. Não pode ser futura. Padrão: hoje.' },
  localPrestacaoIbge: { type: 'string', description: 'Código IBGE do município onde o serviço foi prestado, se diferente do município da empresa (relevante quando a incidência é no local da prestação).' },
  issRetido: { type: 'boolean', description: 'true se o cliente (pessoa jurídica) vai reter o ISS.' },
  pAliq: { type: 'string', description: 'Alíquota do ISS em %, ex.: "2.00". Só quando a validação disser que é obrigatória.' },
  pTotTribSN: { type: 'string', description: 'Simples Nacional: % aproximado de tributos desta nota (alíquota efetiva). Vazio = usa o do perfil.' },
  retencoesFederais: {
    type: 'object', description: 'Lucro Presumido/Real com cliente CNPJ: retenções federais na fonte.',
    properties: {
      pis: { type: 'boolean' }, cofins: { type: 'boolean' }, csll: { type: 'boolean' },
      valorContribuicoes: { type: 'string', description: 'Soma em R$ do PIS+COFINS+CSLL retidos (NT 007).' },
      irrf: { type: 'string', description: 'IRRF retido em R$.' }, cp: { type: 'string', description: 'INSS (contribuição previdenciária) retido em R$.' },
    },
  },
  cIndOp: { type: 'string', description: 'IBS/CBS: indicador da operação (6 dígitos), entre as opções de detalhar_codigo_servico.' },
  cClassTrib: { type: 'string', description: 'IBS/CBS: classificação tributária (6 dígitos), entre as opções de detalhar_codigo_servico.' },
  indFinal: { type: 'string', enum: ['0', '1'], description: 'IBS/CBS: 1 = uso ou consumo pessoal do tomador (padrão para CPF); 0 = não (padrão para CNPJ).' },
};
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const DEFINICOES = [
  { nome: 'listar_empresas', descricao: 'Lista as empresas (emitentes) cadastradas na conta, com regime, ambiente, certificado e pendências. Use para escritórios com várias empresas.', parametros: obj() },
  { nome: 'contexto_empresa', descricao: 'Perfil fiscal completo de uma empresa: CNPJ, município, regime, parâmetros (alíquotas, % de tributos, PIS/COFINS), certificado, procuração, ambiente, o que falta para emitir e o resumo de faturamento.', parametros: obj({ empresaId }) },
  { nome: 'buscar_clientes', descricao: 'Procura clientes (tomadores) salvos da empresa por nome, CPF ou CNPJ. Sem busca, lista os mais recentes.', parametros: obj({ empresaId, busca: { type: 'string' } }) },
  { nome: 'ver_cliente', descricao: 'Dados completos de um cliente salvo (documento, endereço, e-mail).', parametros: obj({ empresaId, clienteId: { type: 'string' } }, ['clienteId']) },
  { nome: 'consultar_cnpj', descricao: 'Consulta a base pública da Receita: razão social, endereço, município, situação cadastral e enquadramento (MEI/Simples/Presumido/Real) de um CNPJ. Use antes de cadastrar cliente PJ.', parametros: obj({ cnpj: { type: 'string' } }, ['cnpj']) },
  { nome: 'cadastrar_cliente', descricao: 'Salva um cliente (tomador) na empresa. CNPJ exige endereço completo (regra E0235). Confirme os dados com o usuário antes, salvo se ele já os deu.', parametros: obj({ empresaId, documento: { type: 'string' }, nome: { type: 'string' }, email: { type: 'string' }, fone: { type: 'string' }, endereco, inscricaoMunicipal: { type: 'string' } }, ['documento', 'nome']) },
  { nome: 'listar_servicos', descricao: 'Serviços salvos da empresa (apelido, código nacional, descrição, valor de costume).', parametros: obj({ empresaId }) },
  { nome: 'cadastrar_servico', descricao: 'Salva um serviço de costume da empresa.', parametros: obj({ empresaId, apelido: { type: 'string' }, cTribNac: { type: 'string' }, descricao: { type: 'string' }, valorPadrao: { type: 'string' }, cTribMun: { type: 'string' }, cNBS: { type: 'string' } }, ['apelido', 'cTribNac', 'descricao']) },
  { nome: 'buscar_codigo_servico', descricao: 'Busca na lista nacional (Anexo B / LC 116) o Código de Tributação Nacional por palavras ou código. Devolve código, descrição, local de incidência do ISS (EP = estabelecimento do prestador, LP = local da prestação, ET = estabelecimento do tomador) e se exige grupo especial (obra/evento, não suportado no app).', parametros: obj({ busca: { type: 'string' } }, ['busca']) },
  { nome: 'detalhar_codigo_servico', descricao: 'Detalhes de um código nacional: descrição, item da LC 116, incidência e as opções oficiais de IBS/CBS (NBS, cIndOp, cClassTrib).', parametros: obj({ codigo: { type: 'string' } }, ['codigo']) },
  { nome: 'buscar_municipio', descricao: 'Busca município pelo nome (ex.: "Campinas" ou "Campinas-SP") e devolve o código IBGE.', parametros: obj({ nome: { type: 'string' } }, ['nome']) },
  { nome: 'listar_notas', descricao: 'Notas da empresa (emitidas, rascunhos, pendentes, rejeitadas, canceladas), da mais recente para a mais antiga.', parametros: obj({ empresaId, situacao: { type: 'string', enum: ['rascunho', 'enviando', 'pendente', 'rejeitada', 'emitida', 'cancelada'] }, competencia: { type: 'string', description: 'Mês AAAA-MM' }, busca: { type: 'string', description: 'Nome do cliente, número ou chave' }, limite: { type: 'integer', minimum: 1, maximum: 50 } }) },
  { nome: 'ver_nota', descricao: 'Detalhes de uma nota: cliente, serviço, valores, tributação, situação, número, chave de acesso, erros da Receita.', parametros: obj({ empresaId, notaId }, ['notaId']) },
  { nome: 'criar_rascunho', descricao: 'Cria um rascunho de nota (NÃO emite) e já devolve a validação com as regras oficiais. Prefira clienteId e servicoId de cadastros salvos.', parametros: obj({ empresaId, ...camposNota }) },
  { nome: 'alterar_rascunho', descricao: 'Altera campos de um rascunho ou de uma nota rejeitada (só os campos enviados mudam) e devolve a nova validação. Em nota clonada, use confirmarRevisao para marcar como conferidos os campos que o usuário confirmou sem mudar.', parametros: obj({ empresaId, notaId, ...camposNota, confirmarRevisao: { type: 'array', items: { type: 'string', enum: ['competencia', 'valor', 'descricao', 'tributacao'] } } }, ['notaId']) },
  { nome: 'validar_nota', descricao: 'Confere um rascunho com as regras oficiais (Anexo I da NFS-e e convênio do município) sem enviar nada.', parametros: obj({ empresaId, notaId }, ['notaId']) },
  { nome: 'emitir_nota', descricao: 'Emite a NFS-e de um rascunho válido na Receita (Sefin Nacional). Em produção é nota fiscal real. Se o modo de confirmação estiver ligado, o app mostra ao usuário um botão para confirmar e a nota só sai quando ele tocar.', parametros: obj({ empresaId, notaId }, ['notaId']) },
  { nome: 'verificar_nota', descricao: 'Consulta na Receita a situação de uma nota pendente de confirmação (NUNCA reenvie: verifique).', parametros: obj({ empresaId, notaId }, ['notaId']) },
  { nome: 'clonar_nota', descricao: 'Cria um rascunho a partir de uma nota (padrão: a última emitida), com novos identificadores. Competência, valor, descrição e tributação precisam ser conferidos.', parametros: obj({ empresaId, notaId: { type: 'string', description: 'Nota de origem. Omita para clonar a última emitida.' } }) },
  { nome: 'descartar_rascunho', descricao: 'Apaga um rascunho ou nota rejeitada (nunca uma nota emitida).', parametros: obj({ empresaId, notaId }, ['notaId']) },
  { nome: 'resumo_faturamento', descricao: 'Total emitido por mês (últimos 6) e no ano, quantidade de notas por situação e, para MEI, o uso do limite anual.', parametros: obj({ empresaId }) },
  { nome: 'listar_notas_tomadas', descricao: 'NFS-e recebidas pela empresa (em que ela é a tomadora), baixadas da Receita, com totais.', parametros: obj({ empresaId, competencia: { type: 'string', description: 'Mês AAAA-MM' } }) },
  { nome: 'sincronizar_receita', descricao: 'Busca na Receita (Ambiente de Dados Nacional) as notas emitidas fora do app, as tomadas e os cancelamentos. Só leitura; precisa de certificado.', parametros: obj({ empresaId }) },
];

// ------------------------------------------------------------------ apoio
function notaCurta(repo, p, n) {
  const r = resumoNota(repo, p, n, true);
  return {
    id: r.id, situacao: r.situacao, rotulo: r.rotulo, aviso: r.aviso,
    cliente: r.tomadorExibicao ? { nome: r.tomadorExibicao.nome, tipo: r.tomadorExibicao.tipo, documento: r.tomadorExibicao.documentoExibicao } : null,
    valor: r.valor, competencia: r.competencia, descricao: r.descricao,
    servico: r.servicoNacional ? { codigo: r.servicoNacional.codigo, descricao: r.servicoNacional.descricao, incidencia: r.servicoNacional.incidencia } : null,
    localPrestacao: r.localPrestacao ? `${r.localPrestacao.nome}/${r.localPrestacao.uf}` : null,
    tributacao: {
      issRetido: !!r.rascunho?.issRetido, pAliq: r.rascunho?.pAliq || null, pTotTribSN: r.rascunho?.pTotTribSN || null,
      retencoesFederais: r.rascunho?.retencoesFederais || null, cNBS: r.rascunho?.cNBS || null, cIndOp: r.rascunho?.cIndOp || null, cClassTrib: r.rascunho?.cClassTrib || null,
    },
    camposARevisar: r.rascunho?.revisar?.length ? r.rascunho.revisar : undefined,
    ambiente: r.ambiente, notaDeTeste: r.homologacao,
    numeroNfse: r.nNfse || undefined, chaveAcesso: r.chaveAcesso || undefined, emitidaEm: r.emitidaEm || undefined,
    consultaPublica: r.documentos?.consultaPublica || undefined,
    errosDaReceita: r.erros?.length ? r.erros : undefined, alertas: r.alertas?.length ? r.alertas : undefined,
    origemId: r.origemId || undefined, versao: r.versao,
  };
}

function validacaoCurta(v) {
  const ex = v.exigencias || {};
  const ibs = ex.ibscbs;
  return {
    ok: v.ok,
    erros: v.erros.map((e) => ({ campo: e.campo, mensagem: e.mensagem, regra: e.regra })),
    exigencias: {
      aliquotaIss: ex.aliquota ? { modo: ex.aliquota.modo, motivo: ex.aliquota.motivo, minimo: ex.aliquota.minimo, maximo: ex.aliquota.maximo, regra: ex.aliquota.regra } : undefined,
      retencaoIssPermitida: ex.retencaoPermitida, retencoesFederaisPermitidas: ex.retencoesFederaisPermitidas,
      pisCofins: ex.pisCofins, retencoesFederaisTotal: ex.retencoesFederais,
      ibscbs: ibs ? { grupo: ibs.grupo, opcoes: (ibs.opcoes || []).slice(0, 8) } : undefined,
    },
  };
}

// Campos que, alterados, contam como "conferidos" na nota clonada.
const REVISAO_DE = { competencia: 'competencia', valor: 'valor', descricao: 'descricao', issRetido: 'tributacao', pAliq: 'tributacao', pTotTribSN: 'tributacao', retencoesFederais: 'tributacao', cIndOp: 'tributacao', cClassTrib: 'tributacao', indFinal: 'tributacao' };

// ------------------------------------------------------------------ execução
export function criarFerramentas(ctx) {
  const { app, usuario, empresaPadrao, ip, emissaoAutonoma, pendentes } = ctx;
  const { repo, db, emissao, consultarCnpj, limites, tomadas } = app;
  const empresa = (args) => {
    const id = args?.empresaId;
    const p = id ? repo.prestadorDoUsuarioPorId(usuario.id, id) : (empresaPadrao && repo.prestadorDoUsuarioPorId(usuario.id, empresaPadrao.id));
    if (!p) throw new ErroApp(409, id ? 'Empresa não encontrada nesta conta. Use listar_empresas.' : 'Nenhuma empresa aberta. Use listar_empresas e informe empresaId.');
    return p;
  };
  const nota = (p, id) => { const n = repo.nota(p.id, String(id || '')); if (!n) throw naoEncontrado('Nota'); return n; };
  const reg = (p, acao, extra = {}) => auditar(db, { usuarioId: usuario.id, prestadorId: p?.id ?? null, acao, ip, ...extra, detalhes: { via: 'ia', ...(extra.detalhes || {}) } });

  async function validarId(p, n) {
    const v = await emissao.validarNota(p, n.id);
    return validacaoCurta(v);
  }

  const exec = {
    async listar_empresas() {
      const lista = repo.listarPrestadores(usuario.id);
      return {
        total: lista.length,
        empresas: lista.slice(0, 200).map((e) => ({
          id: e.id, nome: e.nome, cnpj: formatarDocumento(e.tipoDocumento, e.documento), regime: regimeDescricao(e),
          municipio: municipio(e.municipioIbge) ? `${municipio(e.municipioIbge).nome}/${municipio(e.municipioIbge).uf}` : null,
          ambiente: e.ambiente, porProcuracao: !!e.usaProcuracao, certificadoValidoAte: e.certificadoValidoAte,
          rascunhos: e.rascunhos, pendentes: e.pendentes, emitidasNoMes: e.emitidasNoMes, aberta: e.id === empresaPadrao?.id,
          receitaRecusou: e.consultaRecusadaMotivo || undefined,
        })),
      };
    },

    async contexto_empresa(a) {
      const p = empresa(a);
      const cert = repo.certificadoEmissao(p);
      const eleg = await elegibilidadeDe(emissao, p, cert);
      const { pacote } = escolherPacote({ opSimpNac: p.opSimpNac, competencia: hojeBrasilia() });
      return {
        id: p.id, regime: regimeDescricao(p), perfil: perfilPublico(p),
        certificado: certPublico(cert) || null,
        podeEmitir: eleg.podeEmitir, pendencias: eleg.pendencias.map((x) => ({ titulo: x.titulo, comoResolver: x.comoResolver })),
        avisos: eleg.itens.filter((x) => x.aviso).map((x) => x.aviso),
        regrasVigentes: pacote ? { id: pacote.id, descricao: pacote.descricao, limiteReceitaAnual: pacote.limiteReceitaAnual || undefined } : null,
        receita: situacaoReceita(repo, p),
        faturamento: painelDe(repo, p),
      };
    },

    async buscar_clientes(a) {
      const p = empresa(a);
      const q = semAcento(a.busca).trim();
      const dig = somenteDigitos(q); const alnum = normalizarCnpj(q);
      let lista = repo.listarClientes(p.id);
      if (q) lista = lista.filter((c) => semAcento(c.nome).includes(q) || (dig.length >= 3 && c.documento.includes(dig)) || (alnum.length >= 3 && c.documento.includes(alnum)));
      return {
        total: lista.length,
        clientes: lista.slice(0, LIMITE_LISTA).map((c) => ({ id: c.id, nome: c.nome, tipo: c.tipo, documento: formatarDocumento(c.tipo, c.documento),
          municipio: c.endereco?.municipioIbge && municipio(c.endereco.municipioIbge) ? `${municipio(c.endereco.municipioIbge).nome}/${municipio(c.endereco.municipioIbge).uf}` : null, enderecoCompleto: !!c.endereco })),
      };
    },

    async ver_cliente(a) {
      const p = empresa(a);
      const c = repo.cliente(p.id, String(a.clienteId || ''));
      if (!c) throw naoEncontrado('Cliente');
      return { id: c.id, tipo: c.tipo, nome: c.nome, documento: formatarDocumento(c.tipo, c.documento), email: c.email, fone: c.fone, inscricaoMunicipal: c.inscricaoMunicipal,
        endereco: c.endereco ? { ...c.endereco, municipio: municipio(c.endereco.municipioIbge) } : null };
    },

    async consultar_cnpj(a) {
      limites.consumir(`cnpj:${usuario.id}`, 60, 60_000);
      const r = await consultarCnpj(a.cnpj);
      return { ...r, observacao: 'Dados públicos (podem estar defasados, principalmente o enquadramento no Simples/MEI). Confirme com o usuário.' };
    },

    async cadastrar_cliente(a) {
      const p = empresa(a);
      const dados = lerCliente(a || {});
      const existente = repo.clientePorDocumento(p.id, dados.documento);
      if (existente) return { jaExistia: true, clienteId: existente.id, nome: existente.nome, mensagem: `Este ${dados.tipo} já está cadastrado como "${existente.nome}". Use este clienteId.` };
      const id = repo.salvarCliente(p.id, null, dados);
      reg(p, 'cliente.criado', { entidade: 'cliente', entidadeId: id });
      return { clienteId: id, nome: dados.nome, documento: formatarDocumento(dados.tipo, dados.documento) };
    },

    async listar_servicos(a) {
      const p = empresa(a);
      return { servicos: repo.listarServicos(p.id).slice(0, 60).map((s) => {
        const nac = servicoNacional(s.cTribNac);
        return { id: s.id, apelido: s.apelido, cTribNac: s.cTribNac, descricao: s.descricao, valorPadrao: s.valorPadrao, cTribMun: s.cTribMun, cNBS: s.cNBS,
          codigoNacional: nac ? { descricao: nac.descricao, incidencia: nac.incidencia, grupoExigido: nac.grupoExigido } : null };
      }) };
    },

    async cadastrar_servico(a) {
      const p = empresa(a);
      const id = repo.salvarServico(p.id, null, lerServico(a));
      reg(p, 'servico.criado', { entidade: 'servico', entidadeId: id });
      return { servicoId: id, servico: repo.servico(p.id, id) };
    },

    async buscar_codigo_servico(a) {
      return { resultados: buscarServicos(a.busca, 20).map((s) => ({ codigo: s.codigo, descricao: s.descricao, item: s.item, incidencia: s.incidencia, grupoExigido: s.grupoExigido })) };
    },

    async detalhar_codigo_servico(a) {
      const codigo = somenteDigitos(a.codigo).padStart(6, '0').slice(-6);
      const s = servicoNacional(codigo);
      if (!s) throw new ErroApp(404, 'Código não encontrado na lista nacional. Use buscar_codigo_servico.');
      return { ...s, ibscbs: { obrigatorioDesde: inicioObrigatoriedade(codigo), opcoes: opcoesIbsCbs(codigo).slice(0, 12) } };
    },

    async buscar_municipio(a) {
      return { municipios: buscarMunicipios(a.nome, 10) };
    },

    async listar_notas(a) {
      const p = empresa(a);
      const competencia = /^\d{4}-\d{2}$/.test(String(a.competencia || '')) ? a.competencia : undefined;
      const limite = Math.min(50, Math.max(1, Number(a.limite) || 20));
      let notas = repo.listarNotas(p.id, { situacao: a.situacao || undefined, competencia, limite: 200 });
      const q = semAcento(a.busca).trim();
      if (q) notas = notas.filter((n) => semAcento(n.rascunho?.tomador?.nome).includes(q) || (n.nNfse || '').includes(q) || (n.chaveAcesso || '').includes(q));
      return {
        total: notas.length,
        notas: notas.slice(0, limite).map((n) => {
          const r = resumoNota(repo, p, n);
          return { id: r.id, situacao: r.situacao, rotulo: r.rotulo, cliente: r.clienteNome, valor: r.valor, competencia: r.competencia, descricao: r.descricao, numeroNfse: r.nNfse || undefined, emitidaEm: r.emitidaEm || undefined };
        }),
      };
    },

    async ver_nota(a) { const p = empresa(a); return notaCurta(repo, p, nota(p, a.notaId)); },

    async criar_rascunho(a) {
      const p = empresa(a);
      const r = comTomadorAtual(repo, p.id, comServico(repo, p.id, lerRascunho(a)));
      if (r.clienteId === null && a.clienteId) throw new ErroApp(404, 'Cliente não encontrado. Use buscar_clientes.');
      if (r.servicoId === null && a.servicoId) throw new ErroApp(404, 'Serviço salvo não encontrado. Use listar_servicos.');
      if (!r.competencia) r.competencia = hojeBrasilia();
      const id = repo.criarNota(p.id, r);
      reg(p, 'rascunho.criado', { entidade: 'nota', entidadeId: id });
      const n = repo.nota(p.id, id);
      return { nota: notaCurta(repo, p, n), validacao: await validarId(p, n) };
    },

    async alterar_rascunho(a) {
      const p = empresa(a);
      const atual = nota(p, a.notaId);
      if (!['rascunho', 'rejeitada'].includes(atual.situacao)) throw new ErroApp(409, 'Esta nota já foi enviada e não pode mais ser alterada. Para uma nova, use clonar_nota.');
      const mudancas = Object.fromEntries(Object.entries(a).filter(([k]) => k in camposNota));
      let base = { ...atual.rascunho, ...mudancas };
      // Trocou o tomador avulso: sai o vínculo com o cliente salvo (e vice-versa).
      if (mudancas.tomador && !mudancas.clienteId) base.clienteId = null;
      if (mudancas.clienteId) base.tomador = null;
      if ((mudancas.cTribNac && !mudancas.servicoId)) base.servicoId = null;
      const conferidos = new Set([...Object.keys(mudancas).map((k) => REVISAO_DE[k]).filter(Boolean), ...(Array.isArray(a.confirmarRevisao) ? a.confirmarRevisao : [])]);
      base.revisar = (atual.rascunho.revisar || []).filter((c) => !conferidos.has(c));
      let r = lerRascunho(base);
      if (r.servicoId && r.servicoId !== atual.rascunho.servicoId) r = comServico(repo, p.id, { ...r, descricao: mudancas.descricao ?? '', valor: mudancas.valor ?? '' });
      r = comTomadorAtual(repo, p.id, r);
      if (!r.competencia) r.competencia = atual.rascunho.competencia || hojeBrasilia();
      if (!repo.atualizarRascunho(p.id, atual.id, r, atual.versao)) throw new ErroApp(409, 'O rascunho foi alterado em outro aparelho agora mesmo. Tente de novo.');
      const n = repo.nota(p.id, atual.id);
      return { nota: notaCurta(repo, p, n), validacao: await validarId(p, n) };
    },

    async validar_nota(a) {
      const p = empresa(a);
      const n = nota(p, a.notaId);
      if (!['rascunho', 'rejeitada'].includes(n.situacao)) return { situacao: n.situacao, mensagem: 'Esta nota já saiu do rascunho; não há o que validar.' };
      return validarId(p, n);
    },

    async emitir_nota(a) {
      const p = empresa(a);
      const n = nota(p, a.notaId);
      if (n.situacao === 'emitida') return { situacao: 'emitida', mensagem: 'Esta nota já foi emitida. Não emita de novo.', nota: notaCurta(repo, p, n) };
      if (['pendente', 'enviando'].includes(n.situacao)) return { situacao: n.situacao, mensagem: 'Nota pendente de confirmação da Receita. NÃO reenvie: use verificar_nota.' };
      const v = await emissao.validarNota(p, n.id);
      if (!v.ok) return { situacao: 'nao_enviada', mensagem: 'A nota não passou na validação. Nada foi enviado. Corrija com alterar_rascunho.', erros: validacaoCurta(v).erros };
      if (!emissaoAutonoma) {
        const i = pendentes.findIndex((x) => x.notaId === n.id);
        const pedido = { notaId: n.id, empresaId: p.id, versao: v.versao, revisao: v.revisao, pedidoEm: new Date().toISOString() };
        if (i >= 0) pendentes[i] = pedido; else pendentes.push(pedido);
        while (pendentes.length > 5) pendentes.shift();
        return {
          situacao: 'aguardando_confirmacao',
          mensagem: 'O app mostrou ao usuário o resumo desta nota com o botão "Emitir agora". A NFS-e só será enviada quando ele tocar. Não chame emitir_nota de novo para ela; diga ao usuário que confira o resumo e toque no botão.',
          nota: notaCurta(repo, p, n),
        };
      }
      limites.consumir(`custo:${usuario.id}`, 30, 60_000);
      return emitirConfirmada(ctx, p, n.id, { versao: v.versao, revisao: v.revisao, autonoma: true });
    },

    async verificar_nota(a) {
      const p = empresa(a);
      nota(p, a.notaId);
      const r = await emissao.verificar(p, String(a.notaId));
      reg(p, 'emissao.verificada', { entidade: 'nota', entidadeId: a.notaId, detalhes: { situacao: r.situacao } });
      return notaCurta(repo, p, r);
    },

    async clonar_nota(a) {
      const p = empresa(a);
      const origem = a.notaId ? nota(p, a.notaId) : repo.ultimaEmitida(p.id);
      const id = clonarNota({ repo, db }, { usuarioId: usuario.id, prestador: p, origem, ip, via: 'ia' });
      const n = repo.nota(p.id, id);
      return { nota: notaCurta(repo, p, n), validacao: await validarId(p, n), lembrete: 'Confira competência, valor, descrição e tributação com o usuário (ou marque com confirmarRevisao em alterar_rascunho).' };
    },

    async descartar_rascunho(a) {
      const p = empresa(a);
      if (!repo.removerRascunho(p.id, String(a.notaId || ''))) throw new ErroApp(409, 'Só rascunhos e notas rejeitadas podem ser descartados.');
      reg(p, 'rascunho.descartado', { entidade: 'nota', entidadeId: a.notaId });
      return { ok: true };
    },

    async resumo_faturamento(a) {
      const p = empresa(a);
      return { faturamento: painelDe(repo, p), notasPorSituacao: repo.contarNotasPorSituacao(p.id), observacao: 'Totais só das notas emitidas por este app ou trazidas da Receita, por competência, no ambiente atual da empresa.' };
    },

    async listar_notas_tomadas(a) {
      const p = empresa(a);
      const competencia = /^\d{4}-\d{2}$/.test(String(a.competencia || '')) ? a.competencia : undefined;
      const lista = repo.listarTomadas(p.id, p.ambiente, { competencia });
      const validas = lista.filter((t) => t.situacao !== 'cancelada');
      const soma = (k) => validas.reduce((s, t) => s + Number(t[k] || 0), 0).toFixed(2);
      return {
        totais: { quantidade: validas.length, valor: soma('valor'), valorLiquido: soma('valorLiquido') },
        notas: lista.slice(0, LIMITE_LISTA).map((t) => ({ id: t.id, fornecedor: t.emitente?.nome, documentoFornecedor: t.emitente?.documento, numero: t.nNfse, competencia: t.competencia,
          valor: t.valor, valorLiquido: t.valorLiquido, issRetido: t.issRetido, situacao: t.situacao, descricao: String(t.descricao || '').slice(0, 120) })),
      };
    },

    async sincronizar_receita(a) {
      const p = empresa(a);
      const r = await tomadas.sincronizar(p);
      reg(p, 'tomadas.sincronizadas', { detalhes: { novas: r.novas, canceladas: r.canceladas, emitidas: r.emitidas } });
      return r;
    },
  };

  return async function executar(nome, args) {
    const f = exec[nome];
    if (!f) return { erro: true, conteudo: JSON.stringify({ erro: `Ferramenta desconhecida: ${nome}` }) };
    try {
      const r = await f(args || {});
      return { erro: false, conteudo: JSON.stringify(r) };
    } catch (e) {
      if (e instanceof ErroApp) return { erro: true, conteudo: JSON.stringify({ erro: e.message, status: e.status, ...e.extra }) };
      app.log?.error?.(e);
      return { erro: true, conteudo: JSON.stringify({ erro: 'Falha interna ao executar a ferramenta. Se era uma emissão, use verificar_nota antes de qualquer nova tentativa.' }) };
    }
  };
}

// Emissão de verdade (modo autônomo ou depois do toque em "Emitir agora"). Mesma máquina de estados da tela.
export async function emitirConfirmada({ app, usuario, ip }, p, notaId, { versao, revisao, autonoma = false }) {
  const { repo, db, emissao } = app;
  const n = repo.nota(p.id, notaId);
  if (!n) throw naoEncontrado('Nota');
  auditar(db, { usuarioId: usuario.id, prestadorId: p.id, acao: 'emissao.solicitada', entidade: 'nota', entidadeId: notaId, detalhes: { via: 'ia', autonoma }, ip });
  let resultado;
  try {
    resultado = await emissao.emitir(p, notaId, { versao, revisao });
  } catch (e) {
    if (e instanceof ErroApp) {
      auditar(db, { usuarioId: usuario.id, prestadorId: p.id, acao: 'emissao.nao_concluida', entidade: 'nota', entidadeId: notaId, detalhes: { via: 'ia', status: e.status }, ip });
      return { situacao: e.extra?.resultadoIncerto ? 'pendente' : 'nao_enviada', mensagem: e.message, ...e.extra, nota: repo.nota(p.id, notaId) ? notaCurta(repo, p, repo.nota(p.id, notaId)) : undefined };
    }
    throw e;
  }
  auditar(db, { usuarioId: usuario.id, prestadorId: p.id, acao: `emissao.${resultado.situacao}`, entidade: 'nota', entidadeId: notaId, detalhes: { via: 'ia', autonoma, codigos: resultado.erros?.map((x) => x.codigo) }, ip });
  if (n.rascunho.clienteId) repo.marcarClienteUsado(p.id, n.rascunho.clienteId);
  if (n.rascunho.servicoId) repo.marcarServicoUsado(p.id, n.rascunho.servicoId);
  return { situacao: resultado.situacao, nota: notaCurta(repo, p, resultado) };
}
