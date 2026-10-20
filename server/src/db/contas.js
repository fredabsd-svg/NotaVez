// Um banco SQLite por conta. O catálogo central guarda só a chave de cada conta
// (envelopada pela chave mestra); o arquivo da conta guarda perfil, certificado,
// clientes, serviços e notas, cifrados com essa chave. Uma conta nunca abre o
// arquivo, a tabela ou a chave de outra.
import { mkdirSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { abrirBancoConta, tabelasLegadas } from './banco.js';
import { criarCatalogo } from './catalogo.js';
import { criarRepositorio } from './repositorio.js';
import { abrirChaveConta, criarCriptoConta, novaChaveConta, decifrar as decifrarServidor, decifrarBuffer as decifrarBufferServidor } from '../security/cripto.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Pasta dos bancos das contas: NOTAVEZ_CONTAS_DIR ou "<pasta do catálogo>/contas". Null = memória (testes). */
export function pastaDasContas(arquivoCentral, explicita = process.env.NOTAVEZ_CONTAS_DIR) {
  if (explicita) return resolve(explicita);
  if (!arquivoCentral || arquivoCentral === ':memory:') return null;
  return join(dirname(resolve(arquivoCentral)), 'contas');
}

export function criarContas({ central, pasta, criarServicos = () => ({}) }) {
  const catalogo = criarCatalogo(central);
  const abertas = new Map();
  if (pasta) mkdirSync(pasta, { recursive: true, mode: 0o700 });

  const arquivoDe = (usuarioId) => {
    if (!UUID.test(usuarioId)) throw new Error('Identificador de conta inválido.');
    return pasta ? join(pasta, `${usuarioId}.db`) : ':memory:';
  };

  function criptoDe(usuarioId) {
    const r = central.get('SELECT chave_conta FROM usuarios WHERE id = ?', usuarioId);
    if (!r?.chave_conta) throw new Error('Conta sem chave.');
    const dek = abrirChaveConta(usuarioId, r.chave_conta);
    try { return criarCriptoConta(usuarioId, dek); } finally { dek.fill(0); }
  }

  /** Abre (ou reaproveita) o banco da conta. Lança erro se a conta não existir. */
  function abrir(usuarioId) {
    const existente = abertas.get(usuarioId);
    if (existente) return existente;
    const arquivo = arquivoDe(usuarioId);
    const db = abrirBancoConta(arquivo, criptoDe(usuarioId));
    if (pasta) chmodSync(arquivo, 0o600);
    const repo = criarRepositorio(db, catalogo);
    const conta = { usuarioId, db, repo };
    Object.assign(conta, criarServicos(conta));
    abertas.set(usuarioId, conta);
    return conta;
  }

  function fecharConta(usuarioId) {
    const c = abertas.get(usuarioId);
    if (!c) return;
    c.emissao?.fecharClientes?.();
    c.db.fechar();
    abertas.delete(usuarioId);
  }

  /** Remove o arquivo da conta (com WAL/SHM). A chave é destruída junto com o usuário no catálogo. */
  function apagarArquivos(usuarioId) {
    fecharConta(usuarioId);
    if (!pasta) return;
    const arquivo = arquivoDe(usuarioId);
    for (const f of [arquivo, `${arquivo}-wal`, `${arquivo}-shm`]) rmSync(f, { force: true });
  }

  // Verificação periódica: só as contas marcadas com nota de resultado incerto.
  async function verificarPendentes() {
    for (const usuarioId of catalogo.contasPendentes()) {
      let conta;
      try { conta = abrir(usuarioId); } catch { catalogo.desmarcarPendente(usuarioId); continue; }
      await conta.emissao?.verificarPendentes?.();
      if (conta.repo.contarIncertas() === 0) catalogo.desmarcarPendente(usuarioId);
    }
  }

  // Ao iniciar: garante chave para toda conta, migra o banco único antigo e
  // reconstrói o índice de pendências (nada de nota incerta fica esquecida).
  function preparar() {
    for (const u of central.all('SELECT id FROM usuarios WHERE chave_conta IS NULL')) {
      central.run('UPDATE usuarios SET chave_conta = ? WHERE id = ? AND chave_conta IS NULL', novaChaveConta(u.id), u.id);
    }
    migrarBancoUnico();
    if (pasta) {
      for (const u of central.all('SELECT id FROM usuarios')) {
        if (!existsSync(arquivoDe(u.id))) continue;
        if (abrir(u.id).repo.contarIncertas() > 0) catalogo.marcarPendente(u.id);
      }
    }
  }

  // ---------- Migração do banco único (versões anteriores) ----------
  // Copia os dados de cada usuário para o banco da conta, trocando a chave do
  // servidor pela chave da conta, e só então apaga as tabelas antigas.
  function migrarBancoUnico() {
    const legadas = tabelasLegadas(central);
    if (!legadas.includes('prestadores')) return;
    const tem = (t) => legadas.includes(t);
    for (const u of central.all('SELECT DISTINCT usuario_id id FROM prestadores')) {
      if (!central.get('SELECT 1 FROM usuarios WHERE id = ?', u.id)) continue;
      // Recomeça do zero se uma migração anterior foi interrompida.
      apagarArquivos(u.id);
      const conta = abrir(u.id);
      const c = conta.db.cripto;
      const re = (v) => (v ? c.cifrar(decifrarServidor(v)) : null);
      const prestadores = central.all('SELECT * FROM prestadores WHERE usuario_id = ?', u.id);
      const ids = prestadores.map((p) => p.id);
      const em = `(${ids.map(() => '?').join(',')})`;
      conta.db.transacao(() => {
        for (const p of prestadores) {
          const doc = p.documento_cifrado ? decifrarServidor(p.documento_cifrado) : null;
          conta.db.run(`INSERT INTO prestadores (id, usuario_id, documento_cifrado, documento_indice, tipo_documento, nome_cifrado, municipio_ibge, op_simp_nac,
            reg_esp_trib, inscricao_municipal_cifrada, contato_cifrado, serie_dps, versao, config_fiscal, ambiente, criado_em, atualizado_em)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, p.id, u.id, doc ? c.cifrar(doc) : null, doc ? c.indiceCego(doc) : null, p.tipo_documento,
          c.cifrar(p.nome ?? null), p.municipio_ibge, p.op_simp_nac, p.reg_esp_trib, p.inscricao_municipal ? c.cifrar(p.inscricao_municipal) : null,
          re(p.contato_cifrado), p.serie_dps, p.versao ?? 1, p.config_fiscal, p.ambiente, p.criado_em, p.atualizado_em);
        }
        if (!ids.length) return;
        if (tem('certificados')) {
          for (const r of central.all(`SELECT * FROM certificados WHERE prestador_id IN ${em}`, ...ids)) {
            // PFX é binário: sai do formato antigo como Buffer, não como texto.
            const pfx = r.pfx_cifrado ? c.cifrar(decifrarBufferServidor(r.pfx_cifrado)) : '';
            conta.db.run(`INSERT INTO certificados (id, prestador_id, pfx_cifrado, senha_cifrada, titular_cifrado, documento_cifrado, emissor, valido_de, valido_ate, criado_em, removido_em)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`, r.id, r.prestador_id, pfx, r.senha_cifrada ? re(r.senha_cifrada) : '', c.cifrar(r.titular ?? null),
            re(r.documento_cifrado), r.emissor, r.valido_de, r.valido_ate, r.criado_em, r.removido_em);
          }
        }
        if (tem('clientes')) {
          for (const r of central.all(`SELECT * FROM clientes WHERE prestador_id IN ${em}`, ...ids)) {
            const dados = JSON.parse(decifrarServidor(r.dados_cifrados));
            conta.db.run('INSERT INTO clientes (id, prestador_id, dados_cifrados, documento_indice, criado_em, atualizado_em, usado_em) VALUES (?,?,?,?,?,?,?)',
              r.id, r.prestador_id, c.cifrar(dados), dados.documento ? c.indiceCego(dados.documento) : null, r.criado_em, r.atualizado_em, r.usado_em);
          }
        }
        if (tem('servicos')) {
          for (const r of central.all(`SELECT * FROM servicos WHERE prestador_id IN ${em}`, ...ids)) {
            conta.db.run(`INSERT INTO servicos (id, prestador_id, apelido_cifrado, c_trib_nac, c_trib_mun, c_nbs, descricao_cifrada, valor_padrao_cifrado, criado_em, atualizado_em, usado_em)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`, r.id, r.prestador_id, c.cifrar(r.apelido), r.c_trib_nac, r.c_trib_mun, r.c_nbs, c.cifrar(r.descricao),
            r.valor_padrao ? c.cifrar(r.valor_padrao) : null, r.criado_em, r.atualizado_em, r.usado_em);
          }
        }
        if (tem('notas')) {
          const colunas = new Set(central.all('PRAGMA table_info(notas)').map((x) => x.name));
          const col = (r, n) => (colunas.has(n) ? r[n] : null);
          for (const r of central.all(`SELECT * FROM notas WHERE prestador_id IN ${em}`, ...ids)) {
            const idDps = r.id_dps_cifrado ? decifrarServidor(r.id_dps_cifrado) : null;
            const chave = r.chave_cifrada ? decifrarServidor(r.chave_cifrada) : null;
            conta.db.run(`INSERT INTO notas (id, prestador_id, situacao, origem_id, rascunho_cifrado, valor_cifrado, competencia_cifrada, ambiente,
              contexto_emitente_cifrado, processamento_token, processamento_ate, proxima_verificacao_em, verificacoes, serie, n_dps, id_dps_cifrado,
              id_dps_indice, dps_xml_cifrado, chave_cifrada, chave_indice, n_nfse, nfse_xml_cifrado, erros_json, alertas_json, tentativas, ultimo_envio_em,
              emitida_em, criado_em, atualizado_em, versao) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            r.id, r.prestador_id, r.situacao, r.origem_id, re(r.rascunho_cifrado), c.cifrar(r.valor ?? null), c.cifrar(r.competencia ?? null), r.ambiente,
            re(col(r, 'contexto_emitente_cifrado')), col(r, 'processamento_token'), col(r, 'processamento_ate'), col(r, 'proxima_verificacao_em'),
            col(r, 'verificacoes') ?? 0, r.serie, r.n_dps, idDps ? c.cifrar(idDps) : null, idDps ? c.indiceCego(idDps) : null, re(r.dps_xml_cifrado),
            chave ? c.cifrar(chave) : null, chave ? c.indiceCego(chave) : null, r.n_nfse, re(r.nfse_xml_cifrado), r.erros_json, r.alertas_json,
            r.tentativas ?? 0, r.ultimo_envio_em, r.emitida_em, r.criado_em, r.atualizado_em, r.versao ?? 1);
          }
          if (tem('chamadas_api')) {
            for (const r of central.all(`SELECT * FROM chamadas_api WHERE nota_id IN (SELECT id FROM notas WHERE prestador_id IN ${em}) ORDER BY id`, ...ids)) {
              conta.db.run('INSERT INTO chamadas_api (nota_id, operacao, http_status, resultado, codigos, duracao_ms, criado_em) VALUES (?,?,?,?,?,?,?)',
                r.nota_id, r.operacao, r.http_status, r.resultado, r.codigos, r.duracao_ms, r.criado_em);
            }
          }
        }
        for (const r of central.all(`SELECT * FROM auditoria WHERE prestador_id IN ${em}`, ...ids)) {
          conta.db.run('INSERT INTO auditoria (usuario_id, prestador_id, acao, entidade, entidade_id, detalhes, ip, criado_em) VALUES (?,?,?,?,?,?,?,?)',
            r.usuario_id, r.prestador_id, r.acao, r.entidade, r.entidade_id, r.detalhes, r.ip ? c.cifrar(r.ip) : null, r.criado_em);
        }
      });
      // Os dados já estão no banco da conta: retira-os do catálogo central.
      central.transacao(() => {
        if (tem('chamadas_api') && tem('notas')) central.run(`DELETE FROM chamadas_api WHERE nota_id IN (SELECT id FROM notas WHERE prestador_id IN ${em})`, ...ids);
        central.run(`DELETE FROM auditoria WHERE prestador_id IN ${em}`, ...ids);
        central.run('DELETE FROM prestadores WHERE usuario_id = ?', u.id); // certificados, clientes, serviços e notas saem em cascata
      });
      if (conta.repo.contarIncertas() > 0) catalogo.marcarPendente(u.id);
    }
    // Sem dados restantes, as tabelas antigas deixam de existir no catálogo.
    if (!central.get('SELECT 1 FROM prestadores LIMIT 1')) {
      central.raw.exec(`DROP TABLE IF EXISTS chamadas_api; DROP TABLE IF EXISTS notas; DROP TABLE IF EXISTS clientes;
        DROP TABLE IF EXISTS servicos; DROP TABLE IF EXISTS certificados; DROP TABLE IF EXISTS prestadores; VACUUM;`);
    }
  }

  return {
    catalogo,
    abrir,
    preparar,
    apagarArquivos,
    verificarPendentes,
    abertas: () => [...abertas.keys()],
    arquivoDe,
    fechar() { for (const id of [...abertas.keys()]) fecharConta(id); },
  };
}
