// Cadastro de empresas em lote (escritórios): lê a lista de CNPJs (texto colado ou planilha),
// consulta cada um na base pública do CNPJ, monta o perfil fiscal com os padrões do regime e aponta
// o que precisa de revisão. Antes de salvar, a IA da conta revisa cada empresa (rota /api/ia/revisar-empresas);
// aqui ficam só as regras determinísticas, que valem com ou sem IA.
import { cnpjValido, normalizarCnpj, formatarDocumento, somenteDigitos } from '../util/documentos.js';
import { extrairAnexo } from '../ia/anexos.js';
import { municipio } from '../fiscal/tabelas.js';
import { ErroApp, invalido } from '../util/erros.js';
import { lerPerfil } from '../routes/perfil.js';

export const MAX_LOTE = 300;
const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const pctBr = (v) => String(v).replace('.', ',');

export const REGIMES = {
  mei: { rotulo: 'MEI', familia: 'mei' },
  simples: { rotulo: 'Simples Nacional (ME/EPP)', familia: 'simples' },
  presumido: { rotulo: 'Lucro Presumido', familia: 'lucro' },
  real: { rotulo: 'Lucro Real', familia: 'lucro' },
};

// "Simples", "SN", "ME/EPP optante", "MEI", "SIMEI", "Lucro Presumido", "LP", "Real"... → chave do regime.
export function regimeDoTexto(t) {
  const s = semAcento(t).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/\b(mei|simei)\b|microempreendedor/.test(s)) return 'mei';
  if (/simples|\bsn\b/.test(s)) return 'simples';
  if (/presumido|\blp\b/.test(s)) return 'presumido';
  if (/\breal\b|\blr\b/.test(s)) return 'real';
  return null;
}

export const regimeDoPerfil = (opSimpNac, apuracao) => (opSimpNac === '2' ? 'mei' : opSimpNac === '3' ? 'simples'
  : opSimpNac === '1' ? (apuracao === 'real' ? 'real' : 'presumido') : null);

// Parâmetros fiscais padrão de cada regime. São um ponto de partida declarado como tal: o aviso diz o
// que conferir, e o usuário ajusta depois em Dados da empresa.
export function fiscalPadrao(regime) {
  switch (regime) {
    case 'mei': return { opSimpNac: '2' };
    case 'simples': return { opSimpNac: '3', regApTribSN: '1', pTotTribSN: '6.00' };
    // Serviços no Presumido: PIS 0,65 + COFINS 3,00 + IRPJ 4,80 (15% × 32%) + CSLL 2,88 (9% × 32%) = 11,33%.
    case 'presumido': return { opSimpNac: '1', apuracao: 'presumido', cstPisCofins: '01', aliqPis: '0.65', aliqCofins: '3.00', pTotTribFed: '11.33', pTotTribEst: '0.00', pTotTribMun: '5.00' };
    case 'real': return { opSimpNac: '1', apuracao: 'real', cstPisCofins: '01', aliqPis: '1.65', aliqCofins: '7.60', pTotTribFed: '9.25', pTotTribEst: '0.00', pTotTribMun: '5.00' };
    default: return {};
  }
}
export const AVISO_PADRAO = {
  simples: `Percentual aproximado de tributos preenchido com ${pctBr('6.00')}% (Anexo III, 1ª faixa) e apuração do ISS pelo DAS: ajuste para a alíquota efetiva da empresa em Dados da empresa.`,
  presumido: 'Tributos aproximados com o padrão do Presumido para serviços (federais 11,33% = PIS 0,65 + COFINS 3,00 + IRPJ 4,80 + CSLL 2,88; municipais 5,00%): confira o ISS do município.',
  real: 'PIS 1,65% e COFINS 7,60% (não cumulativos); tributos federais aproximados de 9,25% sem IRPJ/CSLL, que dependem do lucro: ajuste em Dados da empresa.',
};

// ---------------------------------------------------------------- leitura da lista
// CNPJ com ou sem pontuação (inclusive o alfanumérico) ou só números (planilha que perdeu o zero à esquerda).
const PADRAO_CNPJ = /(?<![0-9A-Z])([0-9A-Z]{2}\.?[0-9A-Z]{3}\.?[0-9A-Z]{3}\/?[0-9A-Z]{4}-?\d{2}|\d{12,13})(?![0-9A-Z])/g;
const COLUNAS = {
  regime: /regime|tributa|enquadra|op[cç][aã]o/,
  inscricaoMunicipal: /inscri[cç][aã]o\s*municipal|insc\.?\s*mun|^im$|ccm/,
  email: /e-?mail/,
  nome: /raz[aã]o|^nome|empresa|cliente/,
};

function separador(linha) {
  if (linha.includes('\t')) return '\t';
  if (linha.includes(';')) return ';';
  return ',';
}

function cnpjsDaLinha(linha) {
  const achados = [];
  for (const m of linha.toUpperCase().matchAll(PADRAO_CNPJ)) {
    let c = normalizarCnpj(m[1]);
    if (/^\d{12,13}$/.test(c)) c = c.padStart(14, '0');
    achados.push({ original: m[1], cnpj: c, valido: cnpjValido(c) });
  }
  return achados;
}

// Devolve as empresas a consultar (sem repetição), os trechos que pareciam CNPJ mas não são e quantas linhas repetiam.
export async function lerLista({ texto, arquivo } = {}) {
  let conteudo = String(texto || '');
  let origem = 'texto';
  if (arquivo?.base64) {
    const a = await extrairAnexo({ nome: arquivo.nome, base64: arquivo.base64 });
    conteudo = `${conteudo}\n${a.texto}`;
    origem = a.nome;
  }
  if (!conteudo.trim()) throw invalido('Cole os CNPJs ou envie uma planilha.');
  let cabecalho = null;
  const vistos = new Map();
  const invalidos = [];
  let repetidos = 0;
  for (const bruta of conteudo.split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha || linha.startsWith('### Aba')) { if (linha.startsWith('### Aba')) cabecalho = null; continue; }
    const achados = cnpjsDaLinha(linha);
    if (!achados.length) {
      // Linha de títulos: guarda onde estão regime, inscrição municipal, e-mail e nome.
      if (/cnpj/i.test(linha)) {
        const sep = separador(linha);
        const titulos = linha.split(sep).map((t) => semAcento(t));
        cabecalho = { sep, cnpj: titulos.findIndex((t) => t.includes('cnpj')),
          ...Object.fromEntries(Object.entries(COLUNAS).map(([k, re]) => [k, titulos.findIndex((t) => re.test(t) && !t.includes('cnpj') && !(k === 'nome' && /fantasia/.test(t)))])) };
      }
      continue;
    }
    const celulas = cabecalho ? linha.split(cabecalho.sep).map((c) => c.trim()) : null;
    const coluna = (k) => (celulas && cabecalho[k] >= 0 ? celulas[cabecalho[k]] || '' : '');
    for (const a of achados) {
      if (!a.valido) { if (invalidos.length < 50) invalidos.push(a.original); continue; }
      if (vistos.has(a.cnpj)) { repetidos += 1; continue; }
      // Sem cabeçalho e um CNPJ só na linha ("11.222.333/0001-81 Simples"): o resto da linha pode dizer o regime.
      const resto = achados.length === 1 ? linha.toUpperCase().replace(a.original, ' ') : '';
      const regimeDeclarado = regimeDoTexto(coluna('regime')) || (!cabecalho ? regimeDoTexto(resto) : null);
      const email = coluna('email').toLowerCase();
      vistos.set(a.cnpj, {
        cnpj: a.cnpj, cnpjFormatado: formatarDocumento('CNPJ', a.cnpj), regimeDeclarado,
        inscricaoMunicipal: somenteDigitos(coluna('inscricaoMunicipal')).slice(0, 15) || null,
        email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email.slice(0, 80) : null,
        nome: coluna('nome').slice(0, 300) || null,
      });
    }
  }
  const linhas = [...vistos.values()];
  if (!linhas.length) throw new ErroApp(422, invalidos.length ? 'Nenhum CNPJ válido encontrado: confira os dígitos.' : 'Nenhum CNPJ encontrado. Cole um por linha ou envie a planilha com a coluna CNPJ.', { invalidos });
  return { origem, linhas: linhas.slice(0, MAX_LOTE), excedente: Math.max(0, linhas.length - MAX_LOTE), invalidos, repetidos };
}

// ---------------------------------------------------------------- preparação de cada empresa
const SETORES = [[1, 3, 'agropecuária'], [5, 9, 'extração mineral'], [10, 33, 'indústria'], [45, 47, 'comércio']];
const dataBr = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

export async function prepararEmpresa({ consultarCnpj }, entrada, { existentes = new Set() } = {}) {
  const cnpj = normalizarCnpj(entrada?.cnpj);
  const base = { cnpj, cnpjFormatado: formatarDocumento('CNPJ', cnpj), regimeDeclarado: REGIMES[entrada?.regimeDeclarado] ? entrada.regimeDeclarado : null };
  if (!cnpjValido(cnpj)) return { ...base, situacao: 'erro', problemas: ['CNPJ inválido.'], avisos: [] };
  if (existentes.has(cnpj)) return { ...base, situacao: 'ja_cadastrada', problemas: ['Esta empresa já está cadastrada na sua conta.'], avisos: [] };
  let d;
  try {
    d = await consultarCnpj(cnpj);
  } catch (e) {
    const temporario = !e.status || e.status >= 500 || e.status === 429;
    return { ...base, situacao: 'erro', temporario, problemas: [e.message || 'Falha ao consultar a base pública.'], avisos: [] };
  }
  const problemas = [];
  const avisos = [];
  if (d.ativa === false) problemas.push(`Situação cadastral na Receita: ${d.situacaoCadastral}. Empresa que não está ativa não deve emitir NFS-e.`);
  const ibge = municipio(d.endereco?.municipioIbge) ? String(d.endereco.municipioIbge) : null;
  if (!ibge) problemas.push('O município do endereço não foi identificado na base pública: cadastre esta empresa pela tela "Adicionar empresa".');

  // Regime: o que a planilha diz vale como escolha do usuário; a base pública confere.
  const enq = d.enquadramento || {};
  const publico = regimeDoPerfil(enq.opSimpNac, enq.apuracao);
  const familiaPublica = publico ? REGIMES[publico].familia : null;
  const apuracaoConhecida = enq.opSimpNac !== '1' || !!enq.apuracao;
  const declarado = base.regimeDeclarado;
  let regime = declarado || publico;
  let conflito = false;
  if (declarado && publico && (REGIMES[declarado].familia !== familiaPublica || (familiaPublica === 'lucro' && apuracaoConhecida && declarado !== publico))) {
    conflito = true;
    avisos.push(`A planilha diz ${REGIMES[declarado].rotulo}, mas a base pública indica ${enq.descricao || REGIMES[publico].rotulo}. Confira qual vale antes de salvar (a base aberta pode estar defasada).`);
  }
  if (!regime) {
    problemas.push('A base pública não informa o regime: escolha MEI, Simples, Presumido ou Real.');
  } else if (!declarado && enq.opSimpNac === '1' && !enq.apuracao) {
    avisos.push('A base pública só diz que a empresa não é do Simples: marcada como Lucro Presumido. Mude para Real se for o caso.');
  }
  if (d.simples?.excluidoEm) avisos.push(`Excluída do Simples Nacional em ${dataBr(d.simples.excluidoEm)}.`);
  if (d.mei?.excluidoEm && regime !== 'mei') avisos.push(`Desenquadrada do MEI em ${dataBr(d.mei.excluidoEm)}.`);
  if (regime === 'mei' && d.naturezaJuridica && !/empres.*individual/.test(semAcento(d.naturezaJuridica))) {
    avisos.push(`Natureza jurídica "${d.naturezaJuridica}" não é a de empresário individual, típica do MEI: confira o enquadramento.`);
  }
  if (regime === 'mei' && d.porte === 'DEMAIS') avisos.push('Porte "Demais" na Receita não combina com MEI: confira o enquadramento.');
  const divisao = Number(String(d.cnae?.codigo || '').slice(0, 2));
  const setor = SETORES.find(([de, ate]) => divisao >= de && divisao <= ate);
  if (setor) avisos.push(`Atividade principal de ${setor[2]} (CNAE ${d.cnae.codigo} — ${d.cnae.descricao}): confira se a empresa presta serviços sujeitos à NFS-e.`);
  // O lembrete dos parâmetros padrão (AVISO_PADRAO) a tela mostra conforme o regime escolhido nela.

  const perfil = {
    documento: cnpj, nome: (entrada?.nome || d.razaoSocial || '').slice(0, 300), municipioIbge: ibge,
    inscricaoMunicipal: entrada?.inscricaoMunicipal || null, email: entrada?.email || d.email || null, fone: d.fone || null,
  };
  const situacao = problemas.length ? (d.ativa === false || !ibge ? 'bloqueada' : 'revisar') : conflito ? 'revisar' : 'pronta';
  return {
    ...base, situacao, regime, regimePublico: publico, problemas, avisos, perfil,
    dados: {
      razaoSocial: d.razaoSocial, nomeFantasia: d.nomeFantasia, situacaoCadastral: d.situacaoCadastral, ativa: d.ativa, abertura: d.abertura,
      naturezaJuridica: d.naturezaJuridica, porte: d.porte, cnae: d.cnae, municipio: d.municipio ? { nome: d.municipio.nome, uf: d.municipio.uf } : null,
      enquadramento: enq.descricao || null, simples: d.simples, mei: d.mei, regimes: d.regimes || [], fonte: d.fonte,
    },
  };
}

// Corpo de cadastro (o mesmo de POST /api/empresas) a partir do perfil preparado e do regime escolhido.
export function corpoDoCadastro(perfil = {}, regime) {
  if (!REGIMES[regime]) throw invalido('Escolha o regime da empresa.');
  return {
    documento: perfil.documento, nome: perfil.nome, municipioIbge: perfil.municipioIbge, inscricaoMunicipal: perfil.inscricaoMunicipal || null,
    email: perfil.email || null, fone: perfil.fone || null, ...fiscalPadrao(regime),
  };
}

export const lerCadastro = (perfil, regime) => lerPerfil(corpoDoCadastro(perfil, regime));
