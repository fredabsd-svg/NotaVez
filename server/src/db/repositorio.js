// Acesso a dados com cifragem transparente dos campos sensíveis.
import { agora, novoId } from './banco.js';
import { cifrar, decifrar, decifrarJson, indiceCego } from '../security/cripto.js';

export function criarRepositorio(db) {
  const prestadorDe = (row) => row && {
    id: row.id,
    usuarioId: row.usuario_id,
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

  return {
    // ---------- prestador ----------
    prestadorDoUsuario: (usuarioId) => prestadorDe(db.get('SELECT * FROM prestadores WHERE usuario_id = ? ORDER BY criado_em LIMIT 1', usuarioId)),
    prestador: (id) => prestadorDe(db.get('SELECT * FROM prestadores WHERE id = ?', id)),
    salvarPrestador(usuarioId, p) {
      const atual = db.get('SELECT id FROM prestadores WHERE usuario_id = ? ORDER BY criado_em LIMIT 1', usuarioId);
      const campos = [
        p.tipoDocumento, cifrar(p.documento), indiceCego(p.documento), p.nome, p.municipioIbge, p.opSimpNac, p.regEspTrib ?? '0',
        p.inscricaoMunicipal || null, cifrar({ email: p.email || null, fone: p.fone || null }), p.serieDps || '1', p.ambiente || 'producao_restrita',
        JSON.stringify({ regApTribSN: p.regApTribSN || null, pTotTribSN: p.pTotTribSN || null, aliqIssSN: p.aliqIssSN || null }), agora(),
      ];
      if (atual) {
        db.run(`UPDATE prestadores SET tipo_documento=?, documento_cifrado=?, documento_indice=?, nome=?, municipio_ibge=?, op_simp_nac=?, reg_esp_trib=?,
          inscricao_municipal=?, contato_cifrado=?, serie_dps=?, ambiente=?, config_fiscal=?, atualizado_em=? WHERE id=?`, ...campos, atual.id);
        return atual.id;
      }
      const id = novoId();
      db.run(`INSERT INTO prestadores (tipo_documento, documento_cifrado, documento_indice, nome, municipio_ibge, op_simp_nac, reg_esp_trib,
        inscricao_municipal, contato_cifrado, serie_dps, ambiente, config_fiscal, atualizado_em, id, usuario_id, criado_em) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ...campos, id, usuarioId, agora());
      return id;
    },

    // ---------- certificado ----------
    certificadoAtivo(prestadorId) {
      const r = db.get('SELECT * FROM certificados WHERE prestador_id = ? AND removido_em IS NULL ORDER BY criado_em DESC LIMIT 1', prestadorId);
      return r && { id: r.id, titular: r.titular, emissor: r.emissor, documento: decifrar(r.documento_cifrado), validoDe: r.valido_de, validoAte: r.valido_ate, criadoEm: r.criado_em, _pfx: r.pfx_cifrado, _senha: r.senha_cifrada };
    },
    salvarCertificado(prestadorId, { pfx, senha, info }) {
      return db.transacao(() => {
        db.run('UPDATE certificados SET removido_em = ?, pfx_cifrado = ?, senha_cifrada = ? WHERE prestador_id = ? AND removido_em IS NULL', agora(), '', '', prestadorId);
        const id = novoId();
        db.run(`INSERT INTO certificados (id, prestador_id, pfx_cifrado, senha_cifrada, titular, documento_cifrado, emissor, valido_de, valido_ate, criado_em)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, id, prestadorId, cifrar(pfx), cifrar(senha), info.titular, cifrar(info.cnpj || info.cpf || ''), info.emissor, info.validoDe, info.validoAte, agora());
        return id;
      });
    },
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
    pendentes: () => db.all("SELECT * FROM notas WHERE situacao = 'pendente' ORDER BY ultimo_envio_em LIMIT 100").map(notaDe),
    criarNota(prestadorId, rascunho, { origemId = null, id = null } = {}) {
      const novo = id || novoId();
      db.run(`INSERT INTO notas (id, prestador_id, situacao, origem_id, rascunho_cifrado, valor, competencia, criado_em, atualizado_em)
        VALUES (?,?,'rascunho',?,?,?,?,?,?)`, novo, prestadorId, origemId, cifrar(rascunho), rascunho.valor ?? null, rascunho.competencia ?? null, agora(), agora());
      return novo;
    },
    // Só rascunhos (ou rejeitadas, que voltam a rascunho) podem ser editados.
    atualizarRascunho(prestadorId, id, rascunho, versao) {
      const r = db.run(`UPDATE notas SET rascunho_cifrado = ?, valor = ?, competencia = ?, atualizado_em = ?, versao = versao + 1
        WHERE prestador_id = ? AND id = ? AND situacao IN ('rascunho','rejeitada') ${versao ? 'AND versao = ?' : ''}`,
      cifrar(rascunho), rascunho.valor ?? null, rascunho.competencia ?? null, agora(), prestadorId, id, ...(versao ? [versao] : []));
      return r.changes === 1;
    },
    removerRascunho: (prestadorId, id) => db.run("DELETE FROM notas WHERE prestador_id = ? AND id = ? AND situacao IN ('rascunho','rejeitada')", prestadorId, id).changes === 1,
    xmlDps: (id) => decifrar(db.get('SELECT dps_xml_cifrado x FROM notas WHERE id = ?', id)?.x),
    xmlNfse: (id) => decifrar(db.get('SELECT nfse_xml_cifrado x FROM notas WHERE id = ?', id)?.x),

    // Transição atômica de estado (compare-and-set). Retorna true se aplicou.
    transicionar(id, de, para, campos = {}) {
      const mapa = {
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
        vals.push(k === 'dpsXml' || k === 'nfseXml' ? cifrar(v) : (k === 'erros' || k === 'alertas') && v !== null ? JSON.stringify(v) : v);
      }
      const origem = Array.isArray(de) ? de : [de];
      return db.run(`UPDATE notas SET ${sets.join(', ')} WHERE id = ? AND situacao IN (${origem.map(() => '?').join(',')})`, ...vals, id, ...origem).changes === 1;
    },

    proximoNumeroDps(documentoEmitente, ambiente, serie) {
      const e = indiceCego(`emitente:${documentoEmitente}`);
      return db.transacao(() => {
        db.run('INSERT INTO contadores_dps (emitente_indice, ambiente, serie, ultimo) VALUES (?,?,?,0) ON CONFLICT DO NOTHING', e, ambiente, serie);
        db.run('UPDATE contadores_dps SET ultimo = ultimo + 1 WHERE emitente_indice = ? AND ambiente = ? AND serie = ?', e, ambiente, serie);
        return db.get('SELECT ultimo FROM contadores_dps WHERE emitente_indice = ? AND ambiente = ? AND serie = ?', e, ambiente, serie).ultimo;
      });
    },
    notaPorChave: (prestadorId, chave) => notaDe(db.get('SELECT * FROM notas WHERE prestador_id = ? AND chave_indice = ?', prestadorId, indiceCego(chave))),

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
