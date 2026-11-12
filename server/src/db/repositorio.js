// Acesso a dados com cifragem transparente dos campos sensíveis.
import { agora, novoId } from './banco.js';
import { ErroApp } from '../util/erros.js';
import { XMLParser } from 'fast-xml-parser';
import { cifrar, decifrar, decifrarJson, indiceCego } from '../security/cripto.js';

// O CN do ICP-Brasil é "NOME:CPF" ou "RAZÃO:CNPJ": guarda só o nome (o documento já vai cifrado).
export const nomeTitular = (cn) => String(cn || '').replace(/:[0-9A-Z]{11,14}$/i, '').trim() || null;

// Bancos anteriores não tinham snapshot. A identidade só pode vir da DPS
// persistida, nunca do perfil atual (que pode ter mudado desde o envio).
function contextoLegado(row) {
  if (!row.dps_xml_cifrado || !row.ambiente) return null;
  try {
    const inf = new XMLParser({ removeNSPrefix: true, parseTagValue: false }).parse(decifrar(row.dps_xml_cifrado))?.DPS?.infDPS;
    const documento = inf?.prest?.CNPJ || inf?.prest?.CPF;
    if (!documento || String(inf.tpAmb) !== (row.ambiente === 'producao' ? '1' : '2')) return null;
    return { id: row.prestador_id, documento: String(documento), tipoDocumento: inf.prest.CNPJ ? 'CNPJ' : 'CPF', ambiente: row.ambiente, municipioIbge: String(inf.cLocEmi) };
  } catch { return null; }
}

export function criarRepositorio(db) {
  const prestadorDe = (row) => row && {
    id: row.id,
    usuarioId: row.usuario_id,
    versao: row.versao,
    tipoDocumento: row.tipo_documento,
    documento: decifrar(row.documento_cifrado),
    nome: row.nome,
    municipioIbge: row.municipio_ibge,
    opSimpNac: row.op_simp_nac,
    regEspTrib: row.reg_esp_trib,
    inscricaoMunicipal: row.inscricao_municipal,
    ...(decifrarJson(row.contato_cifrado) || {}),
    serieDps: row.serie_dps,
    ambiente: row.ambiente,
    usaProcuracao: !!row.usa_procuracao,
    ...(row.config_fiscal ? JSON.parse(row.config_fiscal) : {}),
  };

  const clienteDe = (row) => row && { id: row.id, ...decifrarJson(row.dados_cifrados), atualizadoEm: row.atualizado_em, usadoEm: row.usado_em };

  const servicoDe = (row) => row && {
    id: row.id, apelido: row.apelido, cTribNac: row.c_trib_nac, cTribMun: row.c_trib_mun, cNBS: row.c_nbs,
    descricao: row.descricao, valorPadrao: row.valor_padrao, usadoEm: row.usado_em,
  };

  const notaDe = (row) => row && {
    id: row.id,
    prestadorId: row.prestador_id,
    situacao: row.situacao,
    origemId: row.origem_id,
    rascunho: decifrarJson(row.rascunho_cifrado),
    valor: row.valor,
    competencia: row.competencia,
    ambiente: row.ambiente,
    contextoEmitente: row.contexto_emitente_cifrado ? decifrarJson(row.contexto_emitente_cifrado) : contextoLegado(row),
    processamentoToken: row.processamento_token,
    processamentoAte: row.processamento_ate,
    proximaVerificacaoEm: row.proxima_verificacao_em,
    verificacoes: row.verificacoes,
    serie: row.serie,
    nDps: row.n_dps,
    idDps: decifrar(row.id_dps_cifrado),
    chaveAcesso: decifrar(row.chave_cifrada),
    nNfse: row.n_nfse,
    temXml: !!row.nfse_xml_cifrado,
    erros: row.erros_json ? JSON.parse(row.erros_json) : null,
    alertas: row.alertas_json ? JSON.parse(row.alertas_json) : null,
    tentativas: row.tentativas,
    ultimoEnvioEm: row.ultimo_envio_em,
    emitidaEm: row.emitida_em,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
    versao: row.versao,
    canal: row.canal ?? null,
    importadaConferida: !!row.importada_conferida,
  };

  const tomadaDe = (row) => row && {
    id: row.id, ambiente: row.ambiente, nsu: row.nsu, chaveAcesso: decifrar(row.chave_cifrada), ...decifrarJson(row.resumo_cifrado),
    nNfse: row.n_nfse, competencia: row.competencia, emitidaEm: row.emitida_em, valor: row.valor, valorLiquido: row.valor_liquido,
    issRetido: !!row.iss_retido, situacao: row.situacao, baixadaEm: row.baixada_em,
  };

  return {
    // ---------- prestador ----------
    prestadorDoUsuario: (usuarioId) => prestadorDe(db.get('SELECT * FROM prestadores WHERE usuario_id = ? ORDER BY criado_em LIMIT 1', usuarioId)),
    prestador: (id) => prestadorDe(db.get('SELECT * FROM prestadores WHERE id = ?', id)),
    // Toda seleção de empresa passa pelo dono: o id vindo do app nunca basta.
    prestadorDoUsuarioPorId: (usuarioId, id) => prestadorDe(db.get('SELECT * FROM prestadores WHERE usuario_id = ? AND id = ?', usuarioId, String(id ?? ''))),
    contarPrestadores: (usuarioId) => db.get('SELECT count(*) n FROM prestadores WHERE usuario_id = ?', usuarioId).n,
    prestadorPorDocumento: (usuarioId, documento) => prestadorDe(db.get('SELECT * FROM prestadores WHERE usuario_id = ? AND documento_indice = ?', usuarioId, indiceCego(documento))),
    // Lista de empresas da conta com os números de cada uma (uma consulta por tabela, não por empresa).
    listarPrestadores(usuarioId) {
      const certs = new Map(db.all(`SELECT c.prestador_id, c.valido_ate FROM certificados c JOIN prestadores p ON p.id = c.prestador_id
        WHERE p.usuario_id = ? AND c.removido_em IS NULL`, usuarioId).map((r) => [r.prestador_id, r.valido_ate]));
      const notas = new Map(db.all(`SELECT n.prestador_id,
          sum(n.situacao = 'rascunho') rascunhos, sum(n.situacao IN ('pendente','enviando')) pendentes,
          sum(n.situacao = 'emitida' AND substr(n.competencia, 1, 7) = ?) emitidas_mes,
          max(n.emitida_em) ultima_emissao
        FROM notas n JOIN prestadores p ON p.id = n.prestador_id WHERE p.usuario_id = ? GROUP BY n.prestador_id`, agora().slice(0, 7), usuarioId).map((r) => [r.prestador_id, r]));
      // Mesmo critério da tela de tomadas: só as do ambiente atual da empresa.
      const tomadas = new Map(db.all(`SELECT t.prestador_id, count(*) n FROM notas_tomadas t JOIN prestadores p ON p.id = t.prestador_id
        WHERE p.usuario_id = ? AND t.ambiente = p.ambiente GROUP BY t.prestador_id`, usuarioId).map((r) => [r.prestador_id, r.n]));
      const procurador = db.get('SELECT valido_ate FROM certificados_procurador WHERE usuario_id = ? AND removido_em IS NULL ORDER BY criado_em DESC LIMIT 1', usuarioId);
      // Última consulta ao ADN (notas tomadas e emitidas fora do app), no ambiente atual de cada empresa.
      const sincronizacoes = new Map(db.all(`SELECT d.prestador_id, max(d.sincronizado_em) em FROM distribuicao_dfe d JOIN prestadores p ON p.id = d.prestador_id
        WHERE p.usuario_id = ? AND d.ambiente = p.ambiente GROUP BY d.prestador_id`, usuarioId).map((r) => [r.prestador_id, r.em]));
      // Recusa da Receita ainda em aberto (some quando uma consulta volta a dar certo).
      const recusas = new Map(db.all(`SELECT d.prestador_id, d.falha_em, d.falha_cifrada FROM distribuicao_dfe d JOIN prestadores p ON p.id = d.prestador_id
        WHERE p.usuario_id = ? AND d.ambiente = p.ambiente AND d.falha_em IS NOT NULL ORDER BY d.falha_em`, usuarioId).map((r) => [r.prestador_id, r]));
      return db.all('SELECT * FROM prestadores WHERE usuario_id = ? ORDER BY lower(nome), criado_em', usuarioId).map((row) => {
        const n = notas.get(row.id) || {};
        return {
          ...prestadorDe(row), certificadoValidoAte: (row.usa_procuracao ? procurador?.valido_ate : certs.get(row.id)) || null,
          rascunhos: n.rascunhos || 0, pendentes: n.pendentes || 0, emitidasNoMes: n.emitidas_mes || 0, ultimaEmissao: n.ultima_emissao || null,
          tomadas: tomadas.get(row.id) || 0, certificadoProprio: certs.has(row.id), sincronizadoEm: sincronizacoes.get(row.id) || null,
          consultaRecusadaEm: recusas.get(row.id)?.falha_em || null, consultaRecusadaMotivo: recusas.has(row.id) ? decifrar(recusas.get(row.id).falha_cifrada) : null,
        };
      });
    },
    // prestadorId nulo cria uma empresa nova na conta.
    salvarPrestador(usuarioId, prestadorId, p) {
      const atual = prestadorId ? db.get('SELECT * FROM prestadores WHERE usuario_id = ? AND id = ?', usuarioId, prestadorId) : null;
      if (prestadorId && !atual) throw new ErroApp(404, 'Empresa não encontrada.');
      const outra = db.get('SELECT id FROM prestadores WHERE usuario_id = ? AND documento_indice = ?', usuarioId, indiceCego(p.documento));
      if (outra && outra.id !== atual?.id) throw new ErroApp(409, 'Este CNPJ já está cadastrado na sua conta.', { campos: { documento: 'Este CNPJ já está cadastrado na sua conta.' }, empresaId: outra.id });
      if (atual && prestadorDe(atual).documento !== p.documento && db.all("SELECT * FROM notas WHERE prestador_id = ? AND situacao IN ('pendente','enviando')", atual.id).some((n) => notaDe(n).contextoEmitente?.documento !== p.documento)) {
        throw new ErroApp(409, 'Verifique as notas pendentes antes de mudar o CNPJ do perfil.');
      }
      // Com histórico fiscal (notas enviadas ou tomadas) ou certificado do CNPJ, o CNPJ não muda:
      // o histórico e o certificado pertencem ao CNPJ antigo. Outro CNPJ = outra empresa.
      if (atual && prestadorDe(atual).documento !== p.documento && (
        // Rejeitada não conta: a própria rejeição (ex.: E0082) pode mandar corrigir o CNPJ.
        db.get("SELECT 1 FROM notas WHERE prestador_id = ? AND situacao NOT IN ('rascunho','rejeitada') LIMIT 1", atual.id)
        || db.get('SELECT 1 FROM notas_tomadas WHERE prestador_id = ? LIMIT 1', atual.id)
        || db.get('SELECT 1 FROM certificados WHERE prestador_id = ? AND removido_em IS NULL LIMIT 1', atual.id))) {
        throw new ErroApp(409, 'Esta empresa já tem notas ou certificado deste CNPJ e o CNPJ não pode ser trocado. Cadastre o novo CNPJ como outra empresa em Empresas › Adicionar empresa.',
          { campos: { documento: 'O CNPJ não pode mudar depois de notas emitidas, notas tomadas ou certificado. Cadastre como outra empresa.' } });
      }
      const campos = [
        p.tipoDocumento, cifrar(p.documento), indiceCego(p.documento), p.nome, p.municipioIbge, p.opSimpNac, p.regEspTrib ?? '0',
        p.inscricaoMunicipal || null, cifrar({ email: p.email || null, fone: p.fone || null }), p.serieDps || '1', p.ambiente || 'producao_restrita',
        JSON.stringify(p.fiscal || {}), agora(),
      ];
      if (atual) {
        db.run(`UPDATE prestadores SET tipo_documento=?, documento_cifrado=?, documento_indice=?, nome=?, municipio_ibge=?, op_simp_nac=?, reg_esp_trib=?,
          inscricao_municipal=?, contato_cifrado=?, serie_dps=?, ambiente=?, config_fiscal=?, atualizado_em=?, versao=versao+1 WHERE id=?`, ...campos, atual.id);
        return atual.id;
      }
      const id = novoId();
      db.run(`INSERT INTO prestadores (tipo_documento, documento_cifrado, documento_indice, nome, municipio_ibge, op_simp_nac, reg_esp_trib,
        inscricao_municipal, contato_cifrado, serie_dps, ambiente, config_fiscal, atualizado_em, id, usuario_id, criado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ...campos, id, usuarioId, agora());
      return id;
    },
    // Só sai da conta a empresa que nunca enviou nota à Receita (o histórico fiscal fica).
    removerPrestador(usuarioId, id) {
      return db.transacao(() => {
        const p = db.get('SELECT id FROM prestadores WHERE usuario_id = ? AND id = ?', usuarioId, id);
        if (!p) throw new ErroApp(404, 'Empresa não encontrada.');
        // Cópias trazidas da Receita na sincronização não prendem a empresa: continuam lá e podem ser buscadas de novo.
        if (db.get("SELECT 1 FROM notas WHERE prestador_id = ? AND situacao <> 'rascunho' AND COALESCE(canal, '') <> 'sincronizada' LIMIT 1", id)) {
          throw new ErroApp(409, 'Esta empresa já enviou notas à Receita e não pode ser removida. O histórico fiscal precisa ficar guardado.');
        }
        db.run("UPDATE certificados SET removido_em = ?, pfx_cifrado = '', senha_cifrada = '', titular = NULL WHERE prestador_id = ?", agora(), id);
        db.run('DELETE FROM prestadores WHERE id = ?', id);
      });
    },

    // ---------- certificado ----------
    certificadoAtivo(prestadorId) {
      const r = db.get('SELECT * FROM certificados WHERE prestador_id = ? AND removido_em IS NULL ORDER BY criado_em DESC LIMIT 1', prestadorId);
      return r && { id: r.id, titular: r.titular, emissor: r.emissor, documento: decifrar(r.documento_cifrado), validoDe: r.valido_de, validoAte: r.valido_ate, criadoEm: r.criado_em, _pfx: r.pfx_cifrado, _senha: r.senha_cifrada };
    },
    salvarCertificado(prestadorId, { pfx, senha, info }) {
      return db.transacao(() => {
        db.run('UPDATE certificados SET removido_em = ?, pfx_cifrado = ?, senha_cifrada = ?, titular = NULL WHERE prestador_id = ? AND removido_em IS NULL', agora(), '', '', prestadorId);
        const id = novoId();
        db.run(`INSERT INTO certificados (id, prestador_id, pfx_cifrado, senha_cifrada, titular, documento_cifrado, emissor, valido_de, valido_ate, criado_em)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, id, prestadorId, cifrar(pfx), cifrar(senha), nomeTitular(info.titular), cifrar(info.cnpj || info.cpf || ''), info.emissor, info.validoDe, info.validoAte, agora());
        return id;
      });
    },
    // ---------- certificado do procurador (conta) ----------
    certificadoProcurador(usuarioId) {
      const r = db.get('SELECT * FROM certificados_procurador WHERE usuario_id = ? AND removido_em IS NULL ORDER BY criado_em DESC LIMIT 1', usuarioId);
      return r && { id: r.id, procurador: true, titular: r.titular, emissor: r.emissor, tipoDocumento: r.tipo_documento, documento: decifrar(r.documento_cifrado),
        validoDe: r.valido_de, validoAte: r.valido_ate, criadoEm: r.criado_em, _pfx: r.pfx_cifrado, _senha: r.senha_cifrada };
    },
    salvarCertificadoProcurador(usuarioId, { pfx, senha, info }) {
      return db.transacao(() => {
        db.run("UPDATE certificados_procurador SET removido_em = ?, pfx_cifrado = '', senha_cifrada = '', titular = NULL WHERE usuario_id = ? AND removido_em IS NULL", agora(), usuarioId);
        const id = novoId();
        db.run(`INSERT INTO certificados_procurador (id, usuario_id, pfx_cifrado, senha_cifrada, titular, tipo_documento, documento_cifrado, emissor, valido_de, valido_ate, criado_em)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, usuarioId, cifrar(pfx), cifrar(senha), nomeTitular(info.titular), info.cnpj ? 'CNPJ' : 'CPF', cifrar(info.cnpj || info.cpf), info.emissor, info.validoDe, info.validoAte, agora());
        return id;
      });
    },
    removerCertificadoProcurador: (usuarioId) => db.run("UPDATE certificados_procurador SET removido_em = ?, pfx_cifrado = '', senha_cifrada = '', titular = NULL WHERE usuario_id = ? AND removido_em IS NULL", agora(), usuarioId),
    // Certificado que assina e conecta pela empresa: o dela ou, com procuração, o do procurador da conta.
    certificadoEmissao(prestador) {
      if (!prestador) return null;
      // Sempre pelo cadastro atual (a nota pode carregar um retrato antigo da empresa).
      const atual = prestadorDe(db.get('SELECT * FROM prestadores WHERE id = ?', prestador.id)) || prestador;
      if (!atual) return null;
      if (atual.usaProcuracao) return this.certificadoProcurador(atual.usuarioId);
      return this.certificadoAtivo(atual.id);
    },
    // Ambiente da Receita em que a empresa emite: 'producao' (notas reais) ou 'producao_restrita' (testes).
    definirAmbiente(usuarioId, prestadorId, ambiente) {
      const r = db.run('UPDATE prestadores SET ambiente = ?, versao = versao + 1, atualizado_em = ? WHERE usuario_id = ? AND id = ?', ambiente, agora(), usuarioId, prestadorId);
      if (r.changes !== 1) throw new ErroApp(404, 'Empresa não encontrada.');
    },
    definirProcuracao(usuarioId, prestadorId, ativa) {
      const r = db.run('UPDATE prestadores SET usa_procuracao = ?, versao = versao + 1, atualizado_em = ? WHERE usuario_id = ? AND id = ?', ativa ? 1 : 0, agora(), usuarioId, prestadorId);
      if (r.changes !== 1) throw new ErroApp(404, 'Empresa não encontrada.');
    },
    // Remoção apaga o material criptográfico (não só marca).
    removerCertificado: (prestadorId) => db.run("UPDATE certificados SET removido_em = ?, pfx_cifrado = '', senha_cifrada = '', titular = NULL WHERE prestador_id = ? AND removido_em IS NULL", agora(), prestadorId),

    // ---------- clientes ----------
    listarClientes: (prestadorId) => db.all('SELECT * FROM clientes WHERE prestador_id = ? ORDER BY COALESCE(usado_em, atualizado_em) DESC', prestadorId).map(clienteDe),
    cliente: (prestadorId, id) => clienteDe(db.get('SELECT * FROM clientes WHERE prestador_id = ? AND id = ?', prestadorId, id)),
    clientePorDocumento: (prestadorId, doc) => clienteDe(db.get('SELECT * FROM clientes WHERE prestador_id = ? AND documento_indice = ?', prestadorId, indiceCego(doc))),
    salvarCliente(prestadorId, id, dados) {
      const indice = dados.documento ? indiceCego(dados.documento) : null;
      if (id) {
        db.run('UPDATE clientes SET dados_cifrados = ?, documento_indice = ?, atualizado_em = ? WHERE prestador_id = ? AND id = ?', cifrar(dados), indice, agora(), prestadorId, id);
        return id;
      }
      const novo = novoId();
      db.run('INSERT INTO clientes (id, prestador_id, dados_cifrados, documento_indice, criado_em, atualizado_em) VALUES (?,?,?,?,?,?)', novo, prestadorId, cifrar(dados), indice, agora(), agora());
      return novo;
    },
    removerCliente: (prestadorId, id) => db.run('DELETE FROM clientes WHERE prestador_id = ? AND id = ?', prestadorId, id),
    marcarClienteUsado: (prestadorId, id) => db.run('UPDATE clientes SET usado_em = ? WHERE prestador_id = ? AND id = ?', agora(), prestadorId, id),

    // ---------- serviços salvos ----------
    listarServicos: (prestadorId) => db.all('SELECT * FROM servicos WHERE prestador_id = ? ORDER BY COALESCE(usado_em, atualizado_em) DESC', prestadorId).map(servicoDe),
    servico: (prestadorId, id) => servicoDe(db.get('SELECT * FROM servicos WHERE prestador_id = ? AND id = ?', prestadorId, id)),
    salvarServico(prestadorId, id, s) {
      const v = [s.apelido, s.cTribNac, s.cTribMun || null, s.cNBS || null, s.descricao, s.valorPadrao || null, agora()];
      if (id) {
        db.run('UPDATE servicos SET apelido=?, c_trib_nac=?, c_trib_mun=?, c_nbs=?, descricao=?, valor_padrao=?, atualizado_em=? WHERE prestador_id=? AND id=?', ...v, prestadorId, id);
        return id;
      }
      const novo = novoId();
      db.run('INSERT INTO servicos (apelido, c_trib_nac, c_trib_mun, c_nbs, descricao, valor_padrao, atualizado_em, id, prestador_id, criado_em) VALUES (?,?,?,?,?,?,?,?,?,?)', ...v, novo, prestadorId, agora());
      return novo;
    },
    removerServico: (prestadorId, id) => db.run('DELETE FROM servicos WHERE prestador_id = ? AND id = ?', prestadorId, id),
    marcarServicoUsado: (prestadorId, id) => db.run('UPDATE servicos SET usado_em = ? WHERE prestador_id = ? AND id = ?', agora(), prestadorId, id),

    // ---------- notas ----------
    nota: (prestadorId, id) => notaDe(db.get('SELECT * FROM notas WHERE prestador_id = ? AND id = ?', prestadorId, id)),
    notaPorId: (id) => notaDe(db.get('SELECT * FROM notas WHERE id = ?', id)),
    listarNotas(prestadorId, { situacao, limite = 50, antesDe, competencia } = {}) {
      const where = ['prestador_id = ?'];
      const p = [prestadorId];
      if (situacao) { where.push('situacao = ?'); p.push(situacao); }
      if (competencia) { where.push('substr(competencia, 1, 7) = ?'); p.push(competencia); }
      if (antesDe) { where.push('atualizado_em < ?'); p.push(antesDe); }
      return db.all(`SELECT * FROM notas WHERE ${where.join(' AND ')} ORDER BY atualizado_em DESC, competencia DESC, rowid DESC LIMIT ?`, ...p, limite).map(notaDe);
    },
    // Competências (AAAA-MM) com notas, da mais recente para a mais antiga: o filtro de mês da lista.
    mesesDasNotas: (prestadorId, situacao) => db.all(`SELECT DISTINCT substr(competencia, 1, 7) AS mes FROM notas WHERE prestador_id = ? AND competencia IS NOT NULL${situacao ? ' AND situacao = ?' : ''} ORDER BY mes DESC`,
      ...[prestadorId, ...(situacao ? [situacao] : [])]).map((r) => r.mes),
    // "Última nota" para clonar: a emissão confirmada mais recente.
    ultimaEmitida: (prestadorId) => notaDe(db.get("SELECT * FROM notas WHERE prestador_id = ? AND situacao = 'emitida' ORDER BY emitida_em DESC LIMIT 1", prestadorId)),
    ultimaEnviada: (prestadorId) => notaDe(db.get("SELECT * FROM notas WHERE prestador_id = ? AND situacao IN ('emitida','rejeitada','pendente','enviando') ORDER BY COALESCE(ultimo_envio_em, atualizado_em) DESC LIMIT 1", prestadorId)),
    // Contagem por situação sem decifrar nenhuma nota: é o que o Início precisa.
    contarNotasPorSituacao: (prestadorId) => Object.fromEntries(
      db.all('SELECT situacao, COUNT(*) AS n FROM notas WHERE prestador_id = ? GROUP BY situacao', prestadorId).map((r) => [r.situacao, r.n])),
    // Emitidas por competência (AAAA-MM) no intervalo [de, ate), de um só ambiente (testes não somam com produção).
    // A soma sai em centavos inteiros: valor e competência não são cifrados, então nada é decifrado aqui.
    emitidasPorMes: (prestadorId, ambiente, de, ate) => db.all(`SELECT substr(competencia, 1, 7) AS mes, COUNT(*) AS qtd,
      COALESCE(SUM(CAST(ROUND(CAST(valor AS REAL) * 100) AS INTEGER)), 0) AS centavos
      FROM notas WHERE prestador_id = ? AND situacao = 'emitida' AND ambiente = ? AND competencia >= ? AND competencia < ?
      GROUP BY mes`, prestadorId, ambiente, de, ate),
    pendentes: () => db.all(`SELECT * FROM notas WHERE situacao IN ('pendente','enviando')
      AND (processamento_ate IS NULL OR processamento_ate <= ?)
      AND (proxima_verificacao_em IS NULL OR proxima_verificacao_em <= ?)
      ORDER BY COALESCE(proxima_verificacao_em, ultimo_envio_em, criado_em), id LIMIT 100`, agora(), agora()).map(notaDe),
    criarNota(prestadorId, rascunho, { origemId = null, id = null } = {}) {
      const novo = id || novoId();
      db.run(`INSERT INTO notas (id, prestador_id, situacao, origem_id, rascunho_cifrado, valor, competencia, criado_em, atualizado_em)
        VALUES (?,?,'rascunho',?,?,?,?,?,?)`, novo, prestadorId, origemId, cifrar(rascunho), rascunho.valor ?? null, rascunho.competencia ?? null, agora(), agora());
      return novo;
    },
    // Só rascunhos (ou rejeitadas, que voltam a rascunho) podem ser editados.
    atualizarRascunho(prestadorId, id, rascunho, versao) {
      if (!Number.isSafeInteger(versao) || versao < 1) return false;
      const r = db.run(`UPDATE notas SET rascunho_cifrado = ?, valor = ?, competencia = ?, atualizado_em = ?, versao = versao + 1
        WHERE prestador_id = ? AND id = ? AND situacao IN ('rascunho','rejeitada') AND versao = ?`,
      cifrar(rascunho), rascunho.valor ?? null, rascunho.competencia ?? null, agora(), prestadorId, id, versao);
      return r.changes === 1;
    },
    // Nota emitida pela própria pessoa no Emissor Nacional (XML importado). Com
    // notaId, o rascunho que gerou o roteiro passa a ser a nota emitida.
    notaPorIdDps: (prestadorId, idDps) => notaDe(db.get('SELECT * FROM notas WHERE prestador_id = ? AND id_dps_indice = ?', prestadorId, indiceCego(idDps))),
    // A nota que o app enviou substitui a cópia da mesma NFS-e trazida de fora (XML importado ou sincronização com a Receita).
    removerImportadaDuplicada: (prestadorId, chave, exceto) => db.run("DELETE FROM notas WHERE prestador_id = ? AND chave_indice = ? AND canal IN ('emissor_nacional','sincronizada') AND id <> ?", prestadorId, indiceCego(chave), exceto),
    // Nota importada "não conferida" que agora foi conferida: guarda a versão oficial.
    // Tudo o que aparece na tela (valor, tomador, descrição, competência) passa a vir do XML oficial.
    reconferirImportada: (prestadorId, id, { xml, nNfse, emitidaEm, rascunho, ambiente }) => db.run(`UPDATE notas SET nfse_xml_cifrado = ?, n_nfse = ?, emitida_em = ?,
      rascunho_cifrado = ?, valor = ?, competencia = ?, ambiente = ?, importada_conferida = 1,
      atualizado_em = ?, versao = versao + 1 WHERE prestador_id = ? AND id = ? AND canal = 'emissor_nacional' AND importada_conferida = 0`,
    cifrar(xml), nNfse, emitidaEm, cifrar(rascunho), rascunho.valor || null, rascunho.competencia || null, ambiente, agora(), prestadorId, id).changes === 1,
    // canal: 'emissor_nacional' = XML trazido pela pessoa; 'sincronizada' = veio da Receita na sincronização com o ADN.
    // atualizadaEm: a nota sincronizada entra na lista na data em que foi emitida (e não no topo, como se fosse de agora).
    registrarImportada(prestadorId, notaId, { rascunho, chaveAcesso, nNfse, emitidaEm, ambiente, xml, contexto, conferida = false, canal = 'emissor_nacional', atualizadaEm = agora() }) {
      // Só dentro da empresa: a mesma NFS-e pode estar também na conta do contador ou do dono.
      const minha = db.get('SELECT id FROM notas WHERE prestador_id = ? AND chave_indice = ?', prestadorId, indiceCego(chaveAcesso));
      if (minha) throw new ErroApp(409, 'Esta NFS-e já está no histórico.', { notaId: minha.id });
      const campos = [cifrar(rascunho), rascunho.valor || null, rascunho.competencia || null, ambiente, cifrar(contexto),
        cifrar(chaveAcesso), indiceCego(chaveAcesso), nNfse, cifrar(xml), emitidaEm, atualizadaEm, conferida ? 1 : 0];
      if (notaId) {
        const r = db.run(`UPDATE notas SET situacao = 'emitida', canal = 'emissor_nacional', rascunho_cifrado = ?, valor = ?, competencia = ?, ambiente = ?,
          contexto_emitente_cifrado = ?, chave_cifrada = ?, chave_indice = ?, n_nfse = ?, nfse_xml_cifrado = ?, emitida_em = ?, atualizado_em = ?,
          importada_conferida = ?, erros_json = NULL, versao = versao + 1 WHERE prestador_id = ? AND id = ? AND situacao IN ('rascunho','rejeitada')`, ...campos, prestadorId, notaId);
        if (r.changes !== 1) throw new ErroApp(409, 'Esta nota não é mais um rascunho. Atualize a tela.');
        return notaId;
      }
      const id = novoId();
      db.run(`INSERT INTO notas (rascunho_cifrado, valor, competencia, ambiente, contexto_emitente_cifrado, chave_cifrada, chave_indice, n_nfse,
        nfse_xml_cifrado, emitida_em, atualizado_em, importada_conferida, id, prestador_id, situacao, canal, criado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'emitida',?,?)`,
      ...campos, id, prestadorId, canal === 'sincronizada' ? 'sincronizada' : 'emissor_nacional', agora());
      return id;
    },
    removerRascunho: (prestadorId, id) => db.run("DELETE FROM notas WHERE prestador_id = ? AND id = ? AND situacao IN ('rascunho','rejeitada')", prestadorId, id).changes === 1,
    xmlDps: (id) => decifrar(db.get('SELECT dps_xml_cifrado x FROM notas WHERE id = ?', id)?.x),
    xmlNfse: (id) => decifrar(db.get('SELECT nfse_xml_cifrado x FROM notas WHERE id = ?', id)?.x),

    // Transição atômica de estado (compare-and-set). Retorna true se aplicou.
    transicionar(id, de, para, campos = {}, esperado = {}) {
      const mapa = {
        contextoEmitente: 'contexto_emitente_cifrado', processamentoToken: 'processamento_token', processamentoAte: 'processamento_ate',
        proximaVerificacaoEm: 'proxima_verificacao_em', verificacoes: 'verificacoes',
        ambiente: 'ambiente', serie: 'serie', nDps: 'n_dps', nNfse: 'n_nfse',
        erros: 'erros_json', alertas: 'alertas_json', ultimoEnvioEm: 'ultimo_envio_em', emitidaEm: 'emitida_em',
        dpsXml: 'dps_xml_cifrado', nfseXml: 'nfse_xml_cifrado', tentativas: 'tentativas',
      };
      const sets = ['situacao = ?', 'atualizado_em = ?', 'versao = versao + 1'];
      const vals = [para, agora()];
      for (const [k, v] of Object.entries(campos)) {
        if (k === 'idDps' || k === 'chaveAcesso') {
          const [colC, colI] = k === 'idDps' ? ['id_dps_cifrado', 'id_dps_indice'] : ['chave_cifrada', 'chave_indice'];
          sets.push(`${colC} = ?`, `${colI} = ?`);
          vals.push(v ? cifrar(v) : null, v ? indiceCego(v) : null);
          continue;
        }
        if (!mapa[k]) throw new Error(`campo desconhecido ${k}`);
        sets.push(`${mapa[k]} = ?`);
        vals.push(['dpsXml', 'nfseXml', 'contextoEmitente'].includes(k) ? (v === null ? null : cifrar(v)) : (k === 'erros' || k === 'alertas') && v !== null ? JSON.stringify(v) : v);
      }
      const origem = Array.isArray(de) ? de : [de];
      const condicoes = []; const parametros = [];
      if (esperado.versao !== undefined) { condicoes.push('versao = ?'); parametros.push(esperado.versao); }
      if (esperado.token !== undefined) { condicoes.push('processamento_token = ?'); parametros.push(esperado.token); }
      if (esperado.prestadorVersao !== undefined) { condicoes.push('EXISTS (SELECT 1 FROM prestadores p WHERE p.id = notas.prestador_id AND p.versao = ?)'); parametros.push(esperado.prestadorVersao); }
      if (esperado.certificadoId !== undefined) {
        // O certificado precisa continuar sendo o de emissão desta empresa: o dela ou, com procuração, o do procurador.
        condicoes.push(`(EXISTS (SELECT 1 FROM certificados c JOIN prestadores p ON p.id = c.prestador_id WHERE c.id = ? AND c.prestador_id = notas.prestador_id AND c.removido_em IS NULL AND p.usa_procuracao = 0)
          OR EXISTS (SELECT 1 FROM certificados_procurador cp JOIN prestadores p ON p.usuario_id = cp.usuario_id WHERE cp.id = ? AND p.id = notas.prestador_id AND p.usa_procuracao = 1 AND cp.removido_em IS NULL))`);
        parametros.push(esperado.certificadoId, esperado.certificadoId);
      }
      return db.run(`UPDATE notas SET ${sets.join(', ')} WHERE id = ? AND situacao IN (${origem.map(() => '?').join(',')}) ${condicoes.length ? `AND ${condicoes.join(' AND ')}` : ''}`, ...vals, id, ...origem, ...parametros).changes === 1;
    },

    liberarProcessamento: (id, token) => db.run('UPDATE notas SET processamento_token = NULL, processamento_ate = NULL WHERE id = ? AND processamento_token = ?', id, token),

    proximoNumeroDps(documentoEmitente, ambiente, serie) {
      const e = indiceCego(`emitente:${documentoEmitente}`);
      return db.transacao(() => {
        db.run('INSERT INTO contadores_dps (emitente_indice, ambiente, serie, ultimo) VALUES (?,?,?,0) ON CONFLICT DO NOTHING', e, ambiente, serie);
        db.run('UPDATE contadores_dps SET ultimo = ultimo + 1 WHERE emitente_indice = ? AND ambiente = ? AND serie = ?', e, ambiente, serie);
        return db.get('SELECT ultimo FROM contadores_dps WHERE emitente_indice = ? AND ambiente = ? AND serie = ?', e, ambiente, serie).ultimo;
      });
    },
    notaPorChave: (prestadorId, chave) => notaDe(db.get('SELECT * FROM notas WHERE prestador_id = ? AND chave_indice = ?', prestadorId, indiceCego(chave))),

    // ---------- notas tomadas (recebidas pela empresa) ----------
    distribuicao(prestadorId, ambiente, documento) {
      const r = db.get('SELECT ultimo_nsu, sincronizado_em, leitura, falha_em, falha_cifrada FROM distribuicao_dfe WHERE prestador_id = ? AND ambiente = ? AND documento_indice = ?', prestadorId, ambiente, indiceCego(`nsu:${documento}`));
      return { ultimoNsu: r?.ultimo_nsu ?? 0, sincronizadoEm: r?.sincronizado_em ?? null, leitura: r?.leitura ?? 2,
        // A Receita recusou a última consulta (por procuração: sinal de procuração não vigente).
        recusadaEm: r?.falha_em ?? null, recusaMotivo: r?.falha_em ? decifrar(r.falha_cifrada) : null };
    },
    gravarDistribuicao: (prestadorId, ambiente, documento, ultimoNsu) => db.run(`INSERT INTO distribuicao_dfe (prestador_id, ambiente, documento_indice, ultimo_nsu, sincronizado_em, leitura) VALUES (?,?,?,?,?,2)
      ON CONFLICT (prestador_id, ambiente, documento_indice) DO UPDATE SET ultimo_nsu = max(ultimo_nsu, excluded.ultimo_nsu), sincronizado_em = excluded.sincronizado_em,
        falha_em = NULL, falha_cifrada = NULL`,
    prestadorId, ambiente, indiceCego(`nsu:${documento}`), ultimoNsu, agora()),
    // A Receita respondeu recusando a consulta: guarda o motivo (cifrado) até a próxima consulta que der certo.
    registrarRecusaDistribuicao: (prestadorId, ambiente, documento, motivo) => db.run(`INSERT INTO distribuicao_dfe (prestador_id, ambiente, documento_indice, ultimo_nsu, leitura, falha_em, falha_cifrada) VALUES (?,?,?,0,2,?,?)
      ON CONFLICT (prestador_id, ambiente, documento_indice) DO UPDATE SET falha_em = excluded.falha_em, falha_cifrada = excluded.falha_cifrada`,
    prestadorId, ambiente, indiceCego(`nsu:${documento}`), agora(), cifrar(String(motivo || '').slice(0, 500))),
    // Fila lida por uma versão que só guardava as notas tomadas: volta ao início uma única vez.
    reiniciarLeitura: (prestadorId, ambiente, documento) => db.run('UPDATE distribuicao_dfe SET ultimo_nsu = 0, leitura = 2 WHERE prestador_id = ? AND ambiente = ? AND documento_indice = ? AND leitura < 2',
      prestadorId, ambiente, indiceCego(`nsu:${documento}`)).changes === 1,
    // Nota emitida pela empresa e cancelada no portal: sai dos totais, mas continua no histórico com o XML.
    // A nota cancelada fica onde estava na lista (a data de alteração não muda): só a situação troca.
    cancelarEmitida: (prestadorId, chave) => db.run("UPDATE notas SET situacao = 'cancelada', versao = versao + 1 WHERE prestador_id = ? AND chave_indice = ? AND situacao = 'emitida'",
      prestadorId, indiceCego(chave)).changes === 1,
    // Empresas com certificado válido para falar com a Receita (o próprio ou o do escritório, por procuração).
    prestadoresComCertificado(usuarioId = null) {
      const agoraIso = agora();
      return db.all(`SELECT p.* FROM prestadores p WHERE ${usuarioId ? 'p.usuario_id = ? AND' : ''} (
          (p.usa_procuracao = 0 AND EXISTS (SELECT 1 FROM certificados c WHERE c.prestador_id = p.id AND c.removido_em IS NULL AND c.valido_ate > ?))
          OR (p.usa_procuracao = 1 AND EXISTS (SELECT 1 FROM certificados_procurador c WHERE c.usuario_id = p.usuario_id AND c.removido_em IS NULL AND c.valido_ate > ?)))
        ORDER BY lower(p.nome), p.criado_em`, ...(usuarioId ? [usuarioId] : []), agoraIso, agoraIso).map(prestadorDe);
    },
    // Idempotente: a mesma chave baixada de novo não duplica.
    salvarTomada(prestadorId, ambiente, t) {
      return db.run(`INSERT INTO notas_tomadas (id, prestador_id, ambiente, nsu, chave_cifrada, chave_indice, resumo_cifrado, n_nfse, competencia, emitida_em,
        valor, valor_liquido, iss_retido, situacao, xml_cifrado, baixada_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      novoId(), prestadorId, ambiente, t.nsu, cifrar(t.chaveAcesso), indiceCego(t.chaveAcesso), cifrar(t.resumo), t.nNfse, t.competencia, t.emitidaEm,
      t.valor, t.valorLiquido, t.issRetido ? 1 : 0, t.situacao || 'normal', cifrar(t.xml), agora()).changes === 1;
    },
    cancelarTomada: (prestadorId, ambiente, chave) => db.run("UPDATE notas_tomadas SET situacao = 'cancelada' WHERE prestador_id = ? AND ambiente = ? AND chave_indice = ? AND situacao <> 'cancelada'",
      prestadorId, ambiente, indiceCego(chave)).changes === 1,
    listarTomadas(prestadorId, ambiente, { competencia } = {}) {
      const filtro = competencia ? ' AND substr(competencia, 1, 7) = ?' : '';
      return db.all(`SELECT * FROM notas_tomadas WHERE prestador_id = ? AND ambiente = ?${filtro} ORDER BY COALESCE(emitida_em, baixada_em) DESC LIMIT 1000`,
        prestadorId, ambiente, ...(competencia ? [competencia] : [])).map(tomadaDe);
    },
    tomada: (prestadorId, id) => tomadaDe(db.get('SELECT * FROM notas_tomadas WHERE prestador_id = ? AND id = ?', prestadorId, id)),
    xmlTomada: (prestadorId, id) => decifrar(db.get('SELECT xml_cifrado x FROM notas_tomadas WHERE prestador_id = ? AND id = ?', prestadorId, id)?.x),

    // Cache de parâmetros municipais (dados públicos; sem cifragem).
    parametroEmCache(chave, validadeMs) {
      const r = db.get('SELECT dados, obtido_em FROM parametros_municipais_cache WHERE chave = ?', chave);
      if (!r || Date.now() - new Date(r.obtido_em).getTime() > validadeMs) return null;
      return JSON.parse(r.dados);
    },
    guardarParametro: (chave, dados) => db.run(
      'INSERT INTO parametros_municipais_cache (chave, dados, obtido_em) VALUES (?,?,?) ON CONFLICT(chave) DO UPDATE SET dados = excluded.dados, obtido_em = excluded.obtido_em',
      chave, JSON.stringify(dados), agora(),
    ),

    registrarChamada: (notaId, operacao, r) => db.run(
      'INSERT INTO chamadas_api (nota_id, operacao, http_status, resultado, codigos, duracao_ms, criado_em) VALUES (?,?,?,?,?,?,?)',
      notaId, operacao, r.http ?? null, r.tipo, r.erros ? r.erros.map((e) => e.codigo).join(',') : (r.motivo || r.detalhe || null), r.ms ?? null, agora(),
    ),
    chamadas: (notaId) => db.all('SELECT operacao, http_status, resultado, codigos, criado_em FROM chamadas_api WHERE nota_id = ? ORDER BY id', notaId),
  };
}
