// Dados de UMA conta no backup: o que entra, como sai do banco e como volta.
//
// - Entra tudo o que reconstrói o estado da conta: empresas e parâmetros fiscais, certificados (inclusive o do
//   escritório), clientes, serviços, notas (rascunhos, XML da DPS e da NFS-e, situação), notas tomadas com o XML,
//   posição da leitura na Receita (NSU), assistente de IA (configuração e conversas), e-mail das notas (configuração
//   de envio e histórico do que foi enviado), numeração das DPS e auditoria.
// - Não entra o que é da identidade e da sessão (e-mail, senha, gov.br, sessões, aparelhos), nem caches e limites.
// - Campos cifrados com a chave mestra do servidor saem DECIFRADOS dentro do arquivo (que é inteiro cifrado com a
//   senha do backup) e voltam cifrados com a chave do servidor que restaura: o backup serve até para um servidor
//   reinstalado com outra chave. Índices cegos (busca por CPF/CNPJ/chave) são recalculados na restauração.
import { createHash } from 'node:crypto';
import { cifrar, decifrarBuffer, indiceCego } from '../security/cripto.js';
import { formatarDocumento } from '../util/documentos.js';
import { ErroApp } from '../util/erros.js';
import { canonico } from './formato.js';

// 2: e-mail das notas (configuração de envio da conta e histórico de envios de cada nota).
export const ESQUEMA = 2;
const T = 'texto'; const I = 'inteiro'; const C = 'cifrado'; const CJ = 'cifrado-json'; const CB = 'cifrado-binario';
const col = (nome, tipo = T, obrigatoria = false, padrao = null) => ({ nome, tipo, obrigatoria, padrao });
const texto = (v) => (v === null || v === undefined || v === '' ? null : typeof v === 'string' ? v : Buffer.from(v.$b64, 'base64').toString('utf8'));
const json = (v) => { const t = texto(v); return t ? JSON.parse(t) : null; };

// escopo: 'conta' = linha com usuario_id; 'empresa' = linha de uma empresa da conta (prestador_id).
// ignorar: colunas que existem no banco mas não vão para o backup (dono, ordem interna, índices recalculados).
export const TABELAS = [
  { nome: 'prestadores', escopo: 'conta', ordem: 'id', ignorar: ['usuario_id', 'documento_indice'],
    colunas: [col('id', T, true), col('documento_cifrado', C), col('tipo_documento'), col('nome'), col('municipio_ibge'), col('op_simp_nac'),
      col('reg_esp_trib', T, false, '0'), col('inscricao_municipal'), col('contato_cifrado', CJ), col('serie_dps', T, true, '1'), col('versao', I, true, 1),
      col('config_fiscal'), col('ambiente', T, true, 'producao_restrita'), col('criado_em', T, true), col('atualizado_em', T, true), col('usa_procuracao', I, true, 0)],
    indices: { documento_indice: (l) => (texto(l.documento_cifrado) ? indiceCego(texto(l.documento_cifrado)) : null) } },
  { nome: 'certificados', escopo: 'empresa', ordem: 'id', ignorar: [],
    colunas: [col('id', T, true), col('prestador_id', T, true), col('pfx_cifrado', CB, true), col('senha_cifrada', C, true), col('titular'),
      col('documento_cifrado', C), col('emissor'), col('valido_de'), col('valido_ate'), col('criado_em', T, true), col('removido_em')] },
  { nome: 'clientes', escopo: 'empresa', ordem: 'id', ignorar: ['documento_indice'],
    colunas: [col('id', T, true), col('prestador_id', T, true), col('dados_cifrados', CJ, true), col('criado_em', T, true), col('atualizado_em', T, true), col('usado_em')],
    indices: { documento_indice: (l) => { const d = json(l.dados_cifrados); return d?.documento ? indiceCego(d.documento) : null; } } },
  { nome: 'servicos', escopo: 'empresa', ordem: 'id', ignorar: [],
    colunas: [col('id', T, true), col('prestador_id', T, true), col('apelido', T, true), col('c_trib_nac', T, true), col('c_trib_mun'), col('c_nbs'),
      col('descricao', T, true), col('valor_padrao'), col('criado_em', T, true), col('atualizado_em', T, true), col('usado_em')] },
  { nome: 'notas', escopo: 'empresa', ordem: 'ordem', ignorar: ['ordem', 'id_dps_indice', 'chave_indice'],
    colunas: [col('id', T, true), col('prestador_id', T, true), col('situacao', T, true), col('origem_id'), col('rascunho_cifrado', CJ, true), col('valor'),
      col('competencia'), col('ambiente'), col('contexto_emitente_cifrado', CJ), col('processamento_token'), col('processamento_ate'),
      col('proxima_verificacao_em'), col('verificacoes', I, true, 0), col('serie'), col('n_dps'), col('id_dps_cifrado', C), col('dps_xml_cifrado', C),
      col('chave_cifrada', C), col('n_nfse'), col('nfse_xml_cifrado', C), col('erros_json'), col('alertas_json'), col('tentativas', I, true, 0),
      col('ultimo_envio_em'), col('emitida_em'), col('criado_em', T, true), col('atualizado_em', T, true), col('versao', I, true, 1),
      col('canal'), col('importada_conferida', I, true, 0)],
    indices: { id_dps_indice: (l) => (texto(l.id_dps_cifrado) ? indiceCego(texto(l.id_dps_cifrado)) : null),
      chave_indice: (l) => (texto(l.chave_cifrada) ? indiceCego(texto(l.chave_cifrada)) : null) } },
  // E-mails enviados com cada nota (depois de notas: aponta para elas).
  { nome: 'notas_emails', escopo: 'empresa', ordem: 'id', ignorar: [],
    colunas: [col('id', T, true), col('prestador_id', T, true), col('nota_id', T, true), col('dados_cifrados', CJ, true), col('enviado_em', T, true)] },
  { nome: 'notas_tomadas', escopo: 'empresa', ordem: 'id', ignorar: ['chave_indice'],
    colunas: [col('id', T, true), col('prestador_id', T, true), col('ambiente', T, true), col('nsu', I, true), col('chave_cifrada', C, true),
      col('resumo_cifrado', CJ, true), col('n_nfse'), col('competencia'), col('emitida_em'), col('valor'), col('valor_liquido'),
      col('iss_retido', I, true, 0), col('situacao', T, true, 'normal'), col('xml_cifrado', C, true), col('baixada_em', T, true)],
    indices: { chave_indice: (l) => indiceCego(texto(l.chave_cifrada)) } },
  // Posição da leitura no ADN. O índice é HMAC de "nsu:<CNPJ consultado>": sai o CNPJ (para recalcular em outro servidor).
  { nome: 'distribuicao_dfe', escopo: 'empresa', ordem: 'prestador_id', ignorar: ['documento_indice'],
    colunas: [col('prestador_id', T, true), col('ambiente', T, true), col('documento_consulta'), col('indice_original'), col('ultimo_nsu', I, true, 0),
      col('sincronizado_em'), col('leitura', I, true, 2), col('falha_em'), col('falha_cifrada', C)] },
  { nome: 'certificados_procurador', escopo: 'conta', ordem: 'id', ignorar: ['usuario_id'],
    colunas: [col('id', T, true), col('pfx_cifrado', CB, true), col('senha_cifrada', C, true), col('titular'), col('tipo_documento'),
      col('documento_cifrado', C), col('emissor'), col('valido_de'), col('valido_ate'), col('criado_em', T, true), col('removido_em')] },
  { nome: 'ia_config', escopo: 'conta', ordem: 'provedor', ignorar: ['usuario_id'],
    colunas: [col('provedor', T, true), col('modelo', T, true), col('chave_cifrada', C), col('base_url'), col('esforco'),
      col('emissao_autonoma', I, true, 0), col('atualizado_em', T, true)] },
  { nome: 'ia_conversas', escopo: 'conta', ordem: 'id', ignorar: ['usuario_id'],
    colunas: [col('id', T, true), col('prestador_id'), col('titulo_cifrado', C), col('mensagens_cifradas', CJ, true), col('pendentes_cifrados', CJ),
      col('versao', I, true, 1), col('criado_em', T, true), col('atualizado_em', T, true)] },
  { nome: 'email_config', escopo: 'conta', ordem: 'atualizado_em', ignorar: ['usuario_id'],
    colunas: [col('dados_cifrados', CJ, true), col('atualizado_em', T, true)] },
  // Numeração das DPS por emitente: na restauração ela só sobe (número já usado na Receita nunca volta).
  { nome: 'contadores_dps', escopo: 'derivada', ordem: 'documento', ignorar: [],
    colunas: [col('documento', T, true), col('ambiente', T, true), col('serie', T, true), col('ultimo', I, true)] },
  // Auditoria: na restauração é somada à atual (nada do histórico atual é apagado).
  { nome: 'auditoria', escopo: 'derivada', ordem: 'id', ignorar: [],
    colunas: [col('id', I), col('prestador_id'), col('acao', T, true), col('entidade'), col('entidade_id'), col('detalhes'), col('ip'), col('criado_em', T, true)] },
];
export const POR_NOME = Object.fromEntries(TABELAS.map((t) => [t.nome, t]));
// Tabelas que a restauração substitui (as demais são somadas: numeração e auditoria).
export const SUBSTITUIDAS = TABELAS.filter((t) => t.escopo !== 'derivada').map((t) => t.nome);
const SENTINELA = 'nota-sem-stress:backup:sentinela-indice';

const erro = (mensagem, extra = {}) => new ErroApp(422, mensagem, { codigo: 'BACKUP_INVALIDO', ...extra });
const vazio = (v) => v === null || v === undefined;

// ---------------------------------------------------------------- exportação
const utf8 = new TextDecoder('utf-8', { fatal: true });
function decifrarCampo(valor, tipo) {
  if (vazio(valor)) return null;
  if (valor === '') return ''; // material apagado (ex.: certificado removido)
  const bruto = decifrarBuffer(valor);
  if (tipo === CB) return { $b64: bruto.toString('base64') };
  try { return utf8.decode(bruto); } catch { return { $b64: bruto.toString('base64') }; }
}

// SHA-256 de uma tabela: uma linha canônica por registro, calculado em fluxo (sem montar tudo na memória).
export const hashLinhas = (linhas) => {
  const h = createHash('sha256');
  for (const l of linhas) h.update(`${canonico(l)}\n`);
  return h.digest('hex');
};

async function colunasDoBanco(db, tabela) {
  return (await db.all("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?", tabela)).map((r) => r.c);
}

// Tabelas da conta que ficam de fora de propósito: identidade, sessão e o próprio histórico de backups.
export const FORA_DO_BACKUP = ['sessoes', 'recuperacoes_senha', 'aparelhos_confiaveis', 'govbr_fluxos', 'email_oauth_fluxos', 'backups', 'backup_operacoes'];

// Confere que o backup cobre todas as colunas do banco (coluna nova sem regra = backup incompleto: recusa) e
// toda tabela com dados de conta ou de empresa (tabela nova esquecida aqui também recusa).
export async function conferirCobertura(db) {
  const faltando = [];
  const comDono = await db.all("SELECT DISTINCT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('usuario_id', 'prestador_id')");
  for (const { t } of comDono) if (!POR_NOME[t] && !FORA_DO_BACKUP.includes(t)) faltando.push(`${t} (tabela inteira)`);
  for (const t of TABELAS.filter((x) => x.escopo !== 'derivada')) {
    const conhecidas = new Set([...t.colunas.map((c) => c.nome), ...t.ignorar]);
    for (const c of await colunasDoBanco(db, t.nome)) if (!conhecidas.has(c)) faltando.push(`${t.nome}.${c}`);
  }
  return faltando;
}

// Lê a conta inteira numa única transação (retrato consistente) e devolve o conteúdo do backup.
export async function exportarConta(db, usuarioId, { app = '0', agora = new Date().toISOString() } = {}) {
  return await db.transacao(async () => {
    const faltando = await conferirCobertura(db);
    if (faltando.length) throw new ErroApp(500, `O backup não sabe tratar as colunas ${faltando.join(', ')}. Nada foi gerado.`, { codigo: 'BACKUP_COBERTURA' });
    const conta = await db.get('SELECT id, email, nome FROM usuarios WHERE id = ?', usuarioId);
    if (!conta) throw new ErroApp(404, 'Conta não encontrada.');
    const tabelas = {};
    const avisos = [];
    const empresaDe = 'prestador_id IN (SELECT id FROM prestadores WHERE usuario_id = ?)';
    const prestadoresBrutos = await db.all('SELECT * FROM prestadores WHERE usuario_id = ? ORDER BY id', usuarioId);
    const docs = new Map(prestadoresBrutos.map((p) => [p.id, p.documento_cifrado ? texto(decifrarCampo(p.documento_cifrado, C)) : null]));

    for (const t of TABELAS.filter((x) => x.escopo !== 'derivada')) {
      let linhas;
      if (t.nome === 'prestadores') linhas = prestadoresBrutos;
      else if (t.escopo === 'conta') linhas = await db.all(`SELECT * FROM ${t.nome} WHERE usuario_id = ? ORDER BY ${t.ordem}`, usuarioId);
      else linhas = await db.all(`SELECT * FROM ${t.nome} WHERE ${empresaDe} ORDER BY ${t.ordem}${t.nome === 'distribuicao_dfe' ? ', ambiente, documento_indice' : t.ordem === 'id' ? '' : ', id'}`, usuarioId);
      tabelas[t.nome] = linhas.map((bruta) => {
        const l = {};
        for (const c of t.colunas) {
          if (c.nome === 'documento_consulta' || c.nome === 'indice_original') continue;
          const v = bruta[c.nome];
          l[c.nome] = [C, CJ, CB].includes(c.tipo) ? decifrarCampo(v, c.tipo) : (vazio(v) ? null : c.tipo === I ? Number(v) : v);
        }
        if (t.nome === 'distribuicao_dfe') {
          // Qual CNPJ gerou o índice? Em geral o da própria empresa.
          const candidatos = [docs.get(bruta.prestador_id), ...docs.values()].filter(Boolean);
          const doc = candidatos.find((d) => indiceCego(`nsu:${d}`) === bruta.documento_indice);
          l.documento_consulta = doc || null;
          l.indice_original = doc ? null : bruta.documento_indice;
          if (!doc) avisos.push(`distribuicao_dfe: posição de leitura sem CNPJ identificado (empresa ${bruta.prestador_id}).`);
        }
        // Índice gravado diferente do recalculado = dado inconsistente no banco (a restauração corrige).
        for (const [coluna, f] of Object.entries(t.indices || {})) {
          const calculado = f(l);
          if ((bruta[coluna] ?? null) !== calculado) avisos.push(`${t.nome}.${coluna}: índice divergente na linha ${bruta.id || bruta.prestador_id}.`);
        }
        return l;
      });
    }
    // Numeração das DPS dos emitentes da conta.
    const porIndice = new Map([...new Set(docs.values())].filter(Boolean).map((d) => [indiceCego(`emitente:${d}`), d]));
    const contadores = porIndice.size
      ? await db.all(`SELECT * FROM contadores_dps WHERE emitente_indice IN (${[...porIndice.keys()].map(() => '?').join(',')}) ORDER BY emitente_indice, ambiente, serie`, ...porIndice.keys())
      : [];
    tabelas.contadores_dps = contadores.map((r) => ({ documento: porIndice.get(r.emitente_indice), ambiente: r.ambiente, serie: r.serie, ultimo: Number(r.ultimo) }))
      .sort((a, b) => canonico(a).localeCompare(canonico(b)));
    tabelas.auditoria = (await db.all('SELECT * FROM auditoria WHERE usuario_id = ? ORDER BY id', usuarioId)).map((r) => ({
      id: Number(r.id), prestador_id: r.prestador_id ?? null, acao: r.acao, entidade: r.entidade ?? null, entidade_id: r.entidade_id ?? null,
      detalhes: r.detalhes ?? null, ip: r.ip ?? null, criado_em: r.criado_em }));

    const manifesto = Object.fromEntries(Object.entries(tabelas).map(([nome, linhas]) => [nome, { linhas: linhas.length, sha256: hashLinhas(linhas) }]));
    return {
      esquema: ESQUEMA, geradoEm: agora, app,
      conta: { id: conta.id, nome: conta.nome || null, email: conta.email || null },
      sentinelaIndice: indiceCego(SENTINELA),
      tabelas, manifesto, avisos,
    };
  });
}

// ---------------------------------------------------------------- validação (antes de qualquer alteração)
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
function conferirValor(t, c, v, onde) {
  if (vazio(v)) { if (c.obrigatoria) throw erro(`Backup inválido: ${onde}.${c.nome} é obrigatório.`); return; }
  const tipoErrado = () => erro(`Backup inválido: ${onde}.${c.nome} tem formato inesperado.`);
  switch (c.tipo) {
    case T: if (typeof v !== 'string') throw tipoErrado(); break;
    case I: if (!Number.isSafeInteger(v)) throw tipoErrado(); break;
    case CB: if (v !== '' && !(v && typeof v === 'object' && typeof v.$b64 === 'string' && B64.test(v.$b64) && Object.keys(v).length === 1)) throw tipoErrado(); break;
    case C: if (typeof v !== 'string' && !(v && typeof v === 'object' && typeof v.$b64 === 'string' && B64.test(v.$b64) && Object.keys(v).length === 1)) throw tipoErrado(); break;
    case CJ:
      if (typeof v !== 'string') throw tipoErrado();
      if (v !== '') { try { JSON.parse(v); } catch { throw erro(`Backup inválido: ${onde}.${c.nome} não é um JSON válido.`); } }
      break;
    default: throw tipoErrado();
  }
}

// Confere o conteúdo inteiro (estrutura, manifesto, tipos, referências e unicidade) e devolve o plano de restauração.
// Backups de versões anteriores (tabelas ou colunas que ainda não existiam) recebem os valores padrão.
export function validarConteudo(conteudo, { sentinelaAtual = indiceCego(SENTINELA) } = {}) {
  if (!conteudo || typeof conteudo !== 'object' || Array.isArray(conteudo)) throw erro('Backup inválido: conteúdo ilegível.');
  if (!Number.isInteger(conteudo.esquema) || conteudo.esquema < 1) throw erro('Backup inválido: versão dos dados desconhecida.');
  if (conteudo.esquema > ESQUEMA) {
    throw new ErroApp(422, `Este backup tem dados de uma versão mais nova do aplicativo (esquema ${conteudo.esquema}). Atualize o aplicativo para restaurá-lo.`, { codigo: 'BACKUP_VERSAO_NOVA' });
  }
  const { tabelas, manifesto } = conteudo;
  if (!tabelas || typeof tabelas !== 'object' || !manifesto || typeof manifesto !== 'object') throw erro('Backup inválido: faltam as tabelas ou o manifesto.');
  for (const nome of Object.keys(tabelas)) if (!POR_NOME[nome]) throw erro(`Backup inválido: tabela desconhecida "${nome}".`);
  for (const nome of Object.keys(manifesto)) if (!POR_NOME[nome]) throw erro(`Backup inválido: manifesto cita a tabela desconhecida "${nome}".`);

  const normalizadas = {};
  for (const t of TABELAS) {
    const m = manifesto[t.nome];
    const linhas = tabelas[t.nome];
    if (linhas === undefined && m === undefined) { normalizadas[t.nome] = []; continue; } // versão anterior: tabela não existia
    if (!Array.isArray(linhas) || !m || !Number.isInteger(m.linhas)) throw erro(`Backup incompleto: tabela ${t.nome} faltando ou sem manifesto.`);
    if (linhas.length !== m.linhas) throw erro(`Backup incompleto: ${t.nome} deveria ter ${m.linhas} linha(s) e tem ${linhas.length}.`);
    if (hashLinhas(linhas) !== m.sha256) throw erro(`Backup corrompido: o conteúdo de ${t.nome} não confere com o manifesto (SHA-256).`);
    const conhecidas = new Set(t.colunas.map((c) => c.nome));
    normalizadas[t.nome] = linhas.map((l, i) => {
      if (!l || typeof l !== 'object' || Array.isArray(l)) throw erro(`Backup inválido: linha ${i + 1} de ${t.nome}.`);
      for (const k of Object.keys(l)) if (!conhecidas.has(k)) throw erro(`Backup inválido: coluna desconhecida ${t.nome}.${k}.`);
      const n = {};
      for (const c of t.colunas) {
        const v = Object.hasOwn(l, c.nome) ? l[c.nome] : c.padrao;
        conferirValor(t, c, v, `${t.nome}[${i + 1}]`);
        n[c.nome] = vazio(v) ? null : v;
      }
      return n;
    });
  }
  const tb = normalizadas;

  // Unicidade e referências entre as tabelas do próprio backup.
  const unicos = (nome, chave, linhas = tb[nome]) => {
    const vistos = new Set();
    for (const l of linhas) {
      const k = chave(l);
      if (k === null) continue;
      if (vistos.has(k)) throw erro(`Backup inválido: registro repetido em ${nome}.`);
      vistos.add(k);
    }
  };
  for (const t of ['prestadores', 'certificados', 'clientes', 'servicos', 'notas', 'notas_emails', 'notas_tomadas', 'certificados_procurador', 'ia_conversas']) unicos(t, (l) => l.id);
  if (tb.ia_config.length > 1) throw erro('Backup inválido: mais de uma configuração do assistente.');
  if (tb.email_config.length > 1) throw erro('Backup inválido: mais de uma configuração de e-mail.');
  const empresas = new Set(tb.prestadores.map((p) => p.id));
  for (const t of ['certificados', 'clientes', 'servicos', 'notas', 'notas_emails', 'notas_tomadas', 'distribuicao_dfe']) {
    for (const l of tb[t]) if (!empresas.has(l.prestador_id)) throw erro(`Backup inválido: ${t} aponta para uma empresa que não está no backup.`);
  }
  const notasDe = new Map(tb.notas.map((n) => [n.id, n.prestador_id]));
  for (const l of tb.notas_emails) if (notasDe.get(l.nota_id) !== l.prestador_id) throw erro('Backup inválido: e-mail enviado aponta para uma nota que não está no backup.');
  unicos('clientes', (l) => { const d = json(l.dados_cifrados); return d?.documento ? `${l.prestador_id}:${d.documento}` : null; });
  unicos('notas', (l) => (texto(l.chave_cifrada) ? `${l.prestador_id}:${texto(l.chave_cifrada)}` : null));
  unicos('notas', (l) => (texto(l.id_dps_cifrado) ? `${l.ambiente}:${texto(l.id_dps_cifrado)}` : null));
  unicos('notas_tomadas', (l) => `${l.prestador_id}:${l.ambiente}:${texto(l.chave_cifrada)}`);
  unicos('contadores_dps', (l) => `${l.documento}:${l.ambiente}:${l.serie}`);
  const mesmaChave = conteudo.sentinelaIndice === sentinelaAtual;
  // Posição de leitura sem CNPJ identificado só volta no mesmo servidor (mesma chave de índice).
  const descartadas = tb.distribuicao_dfe.filter((l) => !l.documento_consulta && !(mesmaChave && l.indice_original));
  tb.distribuicao_dfe = tb.distribuicao_dfe.filter((l) => !descartadas.includes(l));
  for (const l of tb.distribuicao_dfe) if (!l.documento_consulta && !l.indice_original) throw erro('Backup inválido: posição de leitura sem identificação.');
  unicos('distribuicao_dfe', (l) => `${l.prestador_id}:${l.ambiente}:${l.documento_consulta ? indiceCego(`nsu:${l.documento_consulta}`) : l.indice_original}`);

  const avisos = [...(Array.isArray(conteudo.avisos) ? conteudo.avisos.filter((a) => typeof a === 'string').slice(0, 50) : [])];
  if (descartadas.length) avisos.push(`${descartadas.length} posição(ões) de leitura na Receita não puderam ser recuperadas neste servidor: a próxima busca relê a fila desde o início (sem duplicar notas).`);
  return {
    esquema: conteudo.esquema, geradoEm: typeof conteudo.geradoEm === 'string' ? conteudo.geradoEm : null, app: typeof conteudo.app === 'string' ? conteudo.app : null,
    conta: conteudo.conta && typeof conteudo.conta === 'object' ? { id: String(conteudo.conta.id || ''), nome: conteudo.conta.nome || null, email: conteudo.conta.email || null } : null,
    mesmaChave, tabelas: tb, avisos,
    // O que a reexportação depois da restauração tem de reproduzir, tabela por tabela.
    esperado: Object.fromEntries(SUBSTITUIDAS.map((n) => [n, { linhas: tb[n].length, sha256: hashLinhas(tb[n]) }])),
  };
}

// Resumo legível do backup (para conferir antes de restaurar).
export function resumoDoPlano(plano) {
  const tb = plano.tabelas;
  const contar = (t, id) => tb[t].filter((l) => l.prestador_id === id).length;
  return {
    geradoEm: plano.geradoEm, app: plano.app, esquema: plano.esquema,
    empresas: tb.prestadores.map((p) => ({ id: p.id, nome: p.nome, documento: formatarDocumento(p.tipo_documento || 'CNPJ', texto(p.documento_cifrado) || ''),
      notas: contar('notas', p.id), tomadas: contar('notas_tomadas', p.id), clientes: contar('clientes', p.id), servicos: contar('servicos', p.id),
      certificado: tb.certificados.some((c) => c.prestador_id === p.id && !c.removido_em) })),
    contagens: Object.fromEntries(TABELAS.map((t) => [t.nome, tb[t.nome].length])),
  };
}

// ---------------------------------------------------------------- restauração
const recifrar = (v) => (vazio(v) ? null : v === '' ? '' : cifrar(typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.$b64, 'base64')));

async function inserirLote(db, tabela, colunas, linhas, sondas, sufixo = '') {
  const POR_LOTE = Math.max(1, Math.floor(6000 / colunas.length));
  for (let i = 0; i < linhas.length; i += POR_LOTE) {
    const lote = linhas.slice(i, i + POR_LOTE);
    const marcadores = lote.map(() => `(${colunas.map(() => '?').join(',')})`).join(',');
    await db.run(`INSERT INTO ${tabela} (${colunas.join(',')}) VALUES ${marcadores}${sufixo}`, ...lote.flatMap((l) => colunas.map((c) => (l[c] === undefined ? null : l[c]))));
    await sondas?.aposLote?.(tabela, i + lote.length);
  }
}

// Linhas já no formato do banco (cifradas com a chave deste servidor e com os índices recalculados).
function paraBanco(t, l, usuarioId) {
  const r = {};
  for (const c of t.colunas) {
    if (c.nome === 'documento_consulta' || c.nome === 'indice_original') continue;
    r[c.nome] = [C, CJ, CB].includes(c.tipo) ? recifrar(l[c.nome]) : l[c.nome];
  }
  for (const [coluna, f] of Object.entries(t.indices || {})) r[coluna] = f(l);
  if (t.nome === 'distribuicao_dfe') r.documento_indice = l.documento_consulta ? indiceCego(`nsu:${l.documento_consulta}`) : l.indice_original;
  if (t.escopo === 'conta') r.usuario_id = usuarioId;
  return r;
}

// Dados atuais da conta que podem colidir com os de OUTRA conta deste servidor (o banco recusaria no meio).
export async function conflitosComOutrasContas(db, usuarioId, plano) {
  const tb = plano.tabelas;
  const achados = [];
  const emPartes = async (valores, consulta) => {
    for (let i = 0; i < valores.length; i += 500) {
      const parte = valores.slice(i, i + 500);
      if (parte.length) achados.push(...await db.all(consulta(parte.map(() => '?').join(',')), ...parte, usuarioId));
    }
  };
  await emPartes(tb.prestadores.map((l) => l.id), (q) => `SELECT 'prestadores' AS t, id FROM prestadores WHERE id IN (${q}) AND usuario_id <> ?`);
  for (const t of ['certificados', 'clientes', 'servicos', 'notas', 'notas_emails', 'notas_tomadas']) {
    await emPartes(tb[t].map((l) => l.id), (q) => `SELECT '${t}' AS t, x.id FROM ${t} x JOIN prestadores p ON p.id = x.prestador_id WHERE x.id IN (${q}) AND p.usuario_id <> ?`);
  }
  for (const t of ['certificados_procurador', 'ia_conversas']) {
    await emPartes(tb[t].map((l) => l.id), (q) => `SELECT '${t}' AS t, id FROM ${t} WHERE id IN (${q}) AND usuario_id <> ?`);
  }
  // Id da DPS é único por ambiente no servidor inteiro.
  const dps = tb.notas.filter((l) => texto(l.id_dps_cifrado)).map((l) => indiceCego(texto(l.id_dps_cifrado)));
  await emPartes(dps, (q) => `SELECT 'notas (DPS)' AS t, n.id FROM notas n JOIN prestadores p ON p.id = n.prestador_id WHERE n.id_dps_indice IN (${q}) AND p.usuario_id <> ?`);
  const porTabela = {};
  for (const a of achados) porTabela[a.t] = (porTabela[a.t] || 0) + 1;
  return { total: achados.length, porTabela };
}

// Contagens atuais da conta e o que se perderia (notas que estão no app e não no backup).
export async function estadoAtual(db, usuarioId, plano = null) {
  const contar = async (sql) => Number((await db.get(sql, usuarioId))?.n || 0);
  const emp = 'prestador_id IN (SELECT id FROM prestadores WHERE usuario_id = ?)';
  const contagens = {
    prestadores: await contar('SELECT count(*) AS n FROM prestadores WHERE usuario_id = ?'),
    certificados: await contar(`SELECT count(*) AS n FROM certificados WHERE ${emp}`),
    clientes: await contar(`SELECT count(*) AS n FROM clientes WHERE ${emp}`),
    servicos: await contar(`SELECT count(*) AS n FROM servicos WHERE ${emp}`),
    notas: await contar(`SELECT count(*) AS n FROM notas WHERE ${emp}`),
    notas_tomadas: await contar(`SELECT count(*) AS n FROM notas_tomadas WHERE ${emp}`),
    certificados_procurador: await contar('SELECT count(*) AS n FROM certificados_procurador WHERE usuario_id = ?'),
    ia_conversas: await contar('SELECT count(*) AS n FROM ia_conversas WHERE usuario_id = ?'),
  };
  let foraDoBackup = null;
  if (plano) {
    const noBackup = new Set(plano.tabelas.notas.map((n) => n.id));
    const atuais = await db.all(`SELECT id, situacao FROM notas WHERE ${emp}`, usuarioId);
    const fora = atuais.filter((n) => !noBackup.has(n.id));
    const empresasBackup = new Set(plano.tabelas.prestadores.map((p) => p.id));
    foraDoBackup = {
      notas: fora.length, emitidas: fora.filter((n) => ['emitida', 'cancelada'].includes(n.situacao)).length,
      emAberto: fora.filter((n) => ['pendente', 'enviando'].includes(n.situacao)).length,
      empresas: (await db.all('SELECT id, nome FROM prestadores WHERE usuario_id = ?', usuarioId)).filter((p) => !empresasBackup.has(p.id)).map((p) => p.nome || 'Empresa sem nome'),
    };
  }
  return { contagens, foraDoBackup };
}

// Troca os dados da conta pelos do backup. Precisa rodar DENTRO de uma transação (quem chama garante).
export async function aplicarPlano(db, usuarioId, plano, { sondas } = {}) {
  const tb = plano.tabelas;
  // 1) Apaga só o que é desta conta (as empresas levam em cascata certificados, clientes, serviços, notas, tomadas e NSU).
  await db.run('DELETE FROM ia_conversas WHERE usuario_id = ?', usuarioId);
  await db.run('DELETE FROM ia_config WHERE usuario_id = ?', usuarioId);
  await db.run('DELETE FROM email_config WHERE usuario_id = ?', usuarioId);
  await db.run('DELETE FROM certificados_procurador WHERE usuario_id = ?', usuarioId);
  await db.run('DELETE FROM prestadores WHERE usuario_id = ?', usuarioId);
  await sondas?.aposApagar?.();
  // 2) Insere o backup, das empresas para as dependentes (as notas na ordem original de criação).
  for (const nome of SUBSTITUIDAS) {
    const t = POR_NOME[nome];
    const linhas = tb[nome].map((l) => paraBanco(t, l, usuarioId));
    if (!linhas.length) continue;
    await inserirLote(db, nome, Object.keys(linhas[0]), linhas, sondas);
  }
  // 3) Numeração das DPS: só sobe (GREATEST), nunca reaproveita número já usado.
  for (const c of tb.contadores_dps) {
    await db.run(`INSERT INTO contadores_dps (emitente_indice, ambiente, serie, ultimo) VALUES (?,?,?,?)
      ON CONFLICT (emitente_indice, ambiente, serie) DO UPDATE SET ultimo = GREATEST(contadores_dps.ultimo, excluded.ultimo)`,
    indiceCego(`emitente:${c.documento}`), c.ambiente, c.serie, c.ultimo);
  }
  // 4) Auditoria: soma ao histórico atual o que só existe no backup (nada é apagado).
  const chave = (a) => canonico([a.criado_em, a.acao, a.entidade ?? null, a.entidade_id ?? null, a.prestador_id ?? null, a.detalhes ?? null]);
  const existentes = new Set((await db.all('SELECT criado_em, acao, entidade, entidade_id, prestador_id, detalhes FROM auditoria WHERE usuario_id = ?', usuarioId)).map(chave));
  const novas = tb.auditoria.filter((a) => !existentes.has(chave(a))).map((a) => ({ usuario_id: usuarioId, prestador_id: a.prestador_id, acao: a.acao,
    entidade: a.entidade, entidade_id: a.entidade_id, detalhes: a.detalhes, ip: a.ip, criado_em: a.criado_em }));
  if (novas.length) await inserirLote(db, 'auditoria', Object.keys(novas[0]), novas, sondas);
}

// Depois de aplicar e ANTES do commit: relê a conta e confere tabela por tabela com o backup.
export async function verificarRestauracao(db, usuarioId, plano, { app } = {}) {
  const depois = await exportarConta(db, usuarioId, { app });
  const divergentes = [];
  for (const nome of SUBSTITUIDAS) {
    const esperado = plano.esperado[nome];
    const obtido = depois.manifesto[nome];
    if (obtido.linhas !== esperado.linhas || obtido.sha256 !== esperado.sha256) divergentes.push(`${nome} (esperado ${esperado.linhas}, gravado ${obtido.linhas})`);
  }
  const contadores = new Map(depois.tabelas.contadores_dps.map((c) => [`${c.documento}:${c.ambiente}:${c.serie}`, c.ultimo]));
  for (const c of plano.tabelas.contadores_dps) {
    if (!((contadores.get(`${c.documento}:${c.ambiente}:${c.serie}`) ?? -1) >= c.ultimo)) divergentes.push('contadores_dps');
  }
  const chave = (a) => canonico([a.criado_em, a.acao, a.entidade, a.entidade_id, a.prestador_id, a.detalhes]);
  const auditoria = new Set(depois.tabelas.auditoria.map(chave));
  if (plano.tabelas.auditoria.some((a) => !auditoria.has(chave(a)))) divergentes.push('auditoria');
  if (divergentes.length) {
    throw new ErroApp(500, `A conferência depois da restauração encontrou diferenças (${divergentes.join(', ')}). Tudo foi desfeito; seus dados continuam como estavam.`, { codigo: 'BACKUP_VERIFICACAO' });
  }
  return { contagens: Object.fromEntries(Object.entries(depois.manifesto).map(([n, m]) => [n, m.linhas])) };
}
