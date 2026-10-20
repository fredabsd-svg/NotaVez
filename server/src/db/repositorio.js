// Acesso aos dados de UMA conta, no banco SQLite dessa conta, com cifragem
// transparente pela chave própria da conta (db.cripto). O que é comum a todas
// as contas (numeração da DPS, cache municipal) vem do catálogo central.
import { agora, novoId } from './banco.js';
import { ErroApp } from '../util/erros.js';
import { XMLParser } from 'fast-xml-parser';

// Bancos anteriores não tinham snapshot. A identidade só pode vir da DPS
// persistida, nunca do perfil atual (que pode ter mudado desde o envio).
function contextoLegado(row, decifrar) {
  if (!row.dps_xml_cifrado || !row.ambiente) return null;
  try {
    const inf = new XMLParser({ removeNSPrefix: true, parseTagValue: false }).parse(decifrar(row.dps_xml_cifrado))?.DPS?.infDPS;
    const documento = inf?.prest?.CNPJ || inf?.prest?.CPF;
    if (!documento || String(inf.tpAmb) !== (row.ambiente === 'producao' ? '1' : '2')) return null;
    return { id: row.prestador_id, documento: String(documento), tipoDocumento: inf.prest.CNPJ ? 'CNPJ' : 'CPF', ambiente: row.ambiente, municipioIbge: String(inf.cLocEmi) };
  } catch { return null; }
}

export function criarRepositorio(db, catalogo) {
  const { cifrar, decifrar, decifrarBuffer, decifrarJson, indiceCego, usuarioId: contaId } = db.cripto;
  if (!contaId || !catalogo) throw new Error('Repositório exige o banco de uma conta e o catálogo central.');
  const prestadorDe = (row) => row && {
    id: row.id,
    usuarioId: row.usuario_id,
    versao: row.versao,
    tipoDocumento: row.tipo_documento,
    documento: decifrar(row.documento_cifrado),
    nome: decifrar(row.nome_cifrado),
    municipioIbge: row.municipio_ibge,
    opSimpNac: row.op_simp_nac,
    regEspTrib: row.reg_esp_trib,
    inscricaoMunicipal: decifrar(row.inscricao_municipal_cifrada),
    ...(decifrarJson(row.contato_cifrado) || {}),
    serieDps: row.serie_dps,
    ambiente: row.ambiente,
    ...(row.config_fiscal ? JSON.parse(row.config_fiscal) : {}),
  };

  const clienteDe = (row) => row && { id: row.id, ...decifrarJson(row.dados_cifrados), atualizadoEm: row.atualizado_em, usadoEm: row.usado_em };

  const servicoDe = (row) => row && {
    id: row.id, apelido: decifrar(row.apelido_cifrado), cTribNac: row.c_trib_nac, cTribMun: row.c_trib_mun, cNBS: row.c_nbs,
    descricao: decifrar(row.descricao_cifrada), valorPadrao: decifrar(row.valor_padrao_cifrado), usadoEm: row.usado_em,
  };

  const notaDe = (row) => row && {
    id: row.id,
    prestadorId: row.prestador_id,
    situacao: row.situacao,
    origemId: row.origem_id,
    rascunho: decifrarJson(row.rascunho_cifrado),
    valor: decifrar(row.valor_cifrado),
    competencia: decifrar(row.competencia_cifrada),
    ambiente: row.ambiente,
    contextoEmitente: row.contexto_emitente_cifrado ? decifrarJson(row.contexto_emitente_cifrado) : contextoLegado(row, decifrar),
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
  };

  const encerrada = () => !!db.get("SELECT 1 FROM meta WHERE chave = 'encerrada'");

  return {
    usuarioId: contaId,
    // ---------- conta ----------
    // Marca a conta como encerrada na mesma transação que confere as pendências:
    // nenhuma emissão começa depois disso (transicionar para 'enviando' exige conta aberta).
    encerrar() {
      return db.transacao(() => {
        const pendente = db.get("SELECT id FROM notas WHERE situacao IN ('enviando','pendente') LIMIT 1");
        if (pendente) throw new ErroApp(409, 'Há uma nota com resultado ainda não confirmado. Verifique a situação antes de excluir a conta.', { codigo: 'CONTA_COM_EMISSAO_PENDENTE', notaId: pendente.id });
        db.run("INSERT INTO meta (chave, valor) VALUES ('encerrada', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor", agora());
      });
    },
    encerrada,
    contarIncertas: () => db.get("SELECT COUNT(*) n FROM notas WHERE situacao IN ('enviando','pendente')").n,

    // ---------- prestador ----------
    prestadorDoUsuario: (usuarioId) => (usuarioId === contaId ? prestadorDe(db.get('SELECT * FROM prestadores WHERE usuario_id = ? ORDER BY criado_em LIMIT 1', usuarioId)) : null),
    prestador: (id) => prestadorDe(db.get('SELECT * FROM prestadores WHERE id = ?', id)),
    salvarPrestador(usuarioId, p) {
      if (usuarioId !== contaId) throw new Error('Perfil de outra conta.');
      const atual = db.get('SELECT * FROM prestadores WHERE usuario_id = ? ORDER BY criado_em LIMIT 1', usuarioId);
      if (atual && prestadorDe(atual).documento !== p.documento && db.all("SELECT * FROM notas WHERE prestador_id = ? AND situacao IN ('pendente','enviando')", atual.id).some((n) => notaDe(n).contextoEmitente?.documento !== p.documento)) {
        throw new ErroApp(409, 'Verifique as notas pendentes antes de mudar o CNPJ do perfil.');
      }
      const campos = [
        p.tipoDocumento, cifrar(p.documento), indiceCego(p.documento), cifrar(p.nome ?? null), p.municipioIbge, p.opSimpNac, p.regEspTrib ?? '0',
        p.inscricaoMunicipal ? cifrar(p.inscricaoMunicipal) : null, cifrar({ email: p.email || null, fone: p.fone || null }), p.serieDps || '1', p.ambiente || 'producao_restrita',
        JSON.stringify(p.fiscal || {}), agora(),
      ];
      if (atual) {
        db.run(`UPDATE prestadores SET tipo_documento=?, documento_cifrado=?, documento_indice=?, nome_cifrado=?, municipio_ibge=?, op_simp_nac=?, reg_esp_trib=?,
          inscricao_municipal_cifrada=?, contato_cifrado=?, serie_dps=?, ambiente=?, config_fiscal=?, atualizado_em=?, versao=versao+1 WHERE id=?`, ...campos, atual.id);
        return atual.id;
      }
      const id = novoId();
      db.run(`INSERT INTO prestadores (tipo_documento, documento_cifrado, documento_indice, nome_cifrado, municipio_ibge, op_simp_nac, reg_esp_trib,
        inscricao_municipal_cifrada, contato_cifrado, serie_dps, ambiente, config_fiscal, atualizado_em, id, usuario_id, criado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ...campos, id, usuarioId, agora());
      return id;
    },

    // ---------- certificado ----------
    certificadoAtivo(prestadorId) {
      const r = db.get('SELECT * FROM certificados WHERE prestador_id = ? AND removido_em IS NULL ORDER BY criado_em DESC LIMIT 1', prestadorId);
      return r && { id: r.id, titular: decifrar(r.titular_cifrado), emissor: r.emissor, documento: decifrar(r.documento_cifrado), validoDe: r.valido_de, validoAte: r.valido_ate, criadoEm: r.criado_em, _pfx: r.pfx_cifrado, _senha: r.senha_cifrada };
    },
    salvarCertificado(prestadorId, { pfx, senha, info }) {
      return db.transacao(() => {
        db.run('UPDATE certificados SET removido_em = ?, pfx_cifrado = ?, senha_cifrada = ? WHERE prestador_id = ? AND removido_em IS NULL', agora(), '', '', prestadorId);
        const id = novoId();
        db.run(`INSERT INTO certificados (id, prestador_id, pfx_cifrado, senha_cifrada, titular_cifrado, documento_cifrado, emissor, valido_de, valido_ate, criado_em)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, id, prestadorId, cifrar(pfx), cifrar(senha), cifrar(info.titular ?? null), cifrar(info.cnpj || info.cpf || ''), info.emissor, info.validoDe, info.validoAte, agora());
        return id;
      });
    },
    // PFX e senha decifrados só na hora de assinar/conectar.
    materialCertificado: (certificado) => ({ pfx: decifrarBuffer(certificado._pfx), senha: decifrar(certificado._senha) }),
    // Remoção apaga o material criptográfico (não só marca).
    removerCertificado: (prestadorId) => db.run("UPDATE certificados SET removido_em = ?, pfx_cifrado = '', senha_cifrada = '' WHERE prestador_id = ? AND removido_em IS NULL", agora(), prestadorId),

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
      const v = [cifrar(s.apelido), s.cTribNac, s.cTribMun || null, s.cNBS || null, cifrar(s.descricao), s.valorPadrao ? cifrar(s.valorPadrao) : null, agora()];
      if (id) {
        db.run('UPDATE servicos SET apelido_cifrado=?, c_trib_nac=?, c_trib_mun=?, c_nbs=?, descricao_cifrada=?, valor_padrao_cifrado=?, atualizado_em=? WHERE prestador_id=? AND id=?', ...v, prestadorId, id);
        return id;
      }
      const novo = novoId();
      db.run('INSERT INTO servicos (apelido_cifrado, c_trib_nac, c_trib_mun, c_nbs, descricao_cifrada, valor_padrao_cifrado, atualizado_em, id, prestador_id, criado_em) VALUES (?,?,?,?,?,?,?,?,?,?)', ...v, novo, prestadorId, agora());
      return novo;
    },
    removerServico: (prestadorId, id) => db.run('DELETE FROM servicos WHERE prestador_id = ? AND id = ?', prestadorId, id),
    marcarServicoUsado: (prestadorId, id) => db.run('UPDATE servicos SET usado_em = ? WHERE prestador_id = ? AND id = ?', agora(), prestadorId, id),

    // ---------- notas ----------
    nota: (prestadorId, id) => notaDe(db.get('SELECT * FROM notas WHERE prestador_id = ? AND id = ?', prestadorId, id)),
    notaPorId: (id) => notaDe(db.get('SELECT * FROM notas WHERE id = ?', id)),
    listarNotas(prestadorId, { situacao, limite = 50, antesDe } = {}) {
      const where = ['prestador_id = ?'];
      const p = [prestadorId];
      if (situacao) { where.push('situacao = ?'); p.push(situacao); }
      if (antesDe) { where.push('atualizado_em < ?'); p.push(antesDe); }
      return db.all(`SELECT * FROM notas WHERE ${where.join(' AND ')} ORDER BY atualizado_em DESC LIMIT ?`, ...p, limite).map(notaDe);
    },
    // "Última nota" para clonar: a emissão confirmada mais recente.
    ultimaEmitida: (prestadorId) => notaDe(db.get("SELECT * FROM notas WHERE prestador_id = ? AND situacao = 'emitida' ORDER BY emitida_em DESC LIMIT 1", prestadorId)),
    ultimaEnviada: (prestadorId) => notaDe(db.get("SELECT * FROM notas WHERE prestador_id = ? AND situacao IN ('emitida','rejeitada','pendente','enviando') ORDER BY COALESCE(ultimo_envio_em, atualizado_em) DESC LIMIT 1", prestadorId)),
    pendentes: () => db.all(`SELECT * FROM notas WHERE situacao IN ('pendente','enviando')
      AND (processamento_ate IS NULL OR processamento_ate <= ?)
      AND (proxima_verificacao_em IS NULL OR proxima_verificacao_em <= ?)
      ORDER BY COALESCE(proxima_verificacao_em, ultimo_envio_em, criado_em), id LIMIT 100`, agora(), agora()).map(notaDe),
    criarNota(prestadorId, rascunho, { origemId = null, id = null } = {}) {
      const novo = id || novoId();
      db.run(`INSERT INTO notas (id, prestador_id, situacao, origem_id, rascunho_cifrado, valor_cifrado, competencia_cifrada, criado_em, atualizado_em)
        VALUES (?,?,'rascunho',?,?,?,?,?,?)`, novo, prestadorId, origemId, cifrar(rascunho), cifrar(rascunho.valor ?? null), cifrar(rascunho.competencia ?? null), agora(), agora());
      return novo;
    },
    // Só rascunhos (ou rejeitadas, que voltam a rascunho) podem ser editados.
    atualizarRascunho(prestadorId, id, rascunho, versao) {
      if (!Number.isSafeInteger(versao) || versao < 1) return false;
      const r = db.run(`UPDATE notas SET rascunho_cifrado = ?, valor_cifrado = ?, competencia_cifrada = ?, atualizado_em = ?, versao = versao + 1
        WHERE prestador_id = ? AND id = ? AND situacao IN ('rascunho','rejeitada') AND versao = ?`,
      cifrar(rascunho), cifrar(rascunho.valor ?? null), cifrar(rascunho.competencia ?? null), agora(), prestadorId, id, versao);
      return r.changes === 1;
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
      if (esperado.certificadoId !== undefined) { condicoes.push('EXISTS (SELECT 1 FROM certificados c WHERE c.id = ? AND c.prestador_id = notas.prestador_id AND c.removido_em IS NULL)'); parametros.push(esperado.certificadoId); }
      // Conta em exclusão não começa envio nenhum (corrida com DELETE /api/conta).
      if (para === 'enviando') condicoes.push("NOT EXISTS (SELECT 1 FROM meta WHERE chave = 'encerrada')");
      const ok = db.run(`UPDATE notas SET ${sets.join(', ')} WHERE id = ? AND situacao IN (${origem.map(() => '?').join(',')}) ${condicoes.length ? `AND ${condicoes.join(' AND ')}` : ''}`, ...vals, id, ...origem, ...parametros).changes === 1;
      if (ok && (para === 'enviando' || para === 'pendente')) catalogo.marcarPendente(contaId);
      return ok;
    },

    liberarProcessamento: (id, token) => db.run('UPDATE notas SET processamento_token = NULL, processamento_ate = NULL WHERE id = ? AND processamento_token = ?', id, token),

    proximoNumeroDps: (documentoEmitente, ambiente, serie) => catalogo.proximoNumeroDps(documentoEmitente, ambiente, serie),
    notaPorChave: (prestadorId, chave) => notaDe(db.get('SELECT * FROM notas WHERE prestador_id = ? AND chave_indice = ?', prestadorId, indiceCego(chave))),

    // Cache de parâmetros municipais: dados públicos, comuns a todas as contas.
    parametroEmCache: (chave, validadeMs) => catalogo.parametroEmCache(chave, validadeMs),
    guardarParametro: (chave, dados) => catalogo.guardarParametro(chave, dados),

    registrarChamada: (notaId, operacao, r) => db.run(
      'INSERT INTO chamadas_api (nota_id, operacao, http_status, resultado, codigos, duracao_ms, criado_em) VALUES (?,?,?,?,?,?,?)',
      notaId, operacao, r.http ?? null, r.tipo, r.erros ? r.erros.map((e) => e.codigo).join(',') : (r.motivo || r.detalhe || null), r.ms ?? null, agora(),
    ),
    chamadas: (notaId) => db.all('SELECT operacao, http_status, resultado, codigos, criado_em FROM chamadas_api WHERE nota_id = ? ORDER BY id', notaId),
  };
}
