// E-mail da NFS-e para o cliente: os fatos (sempre tirados do XML oficial), o texto escrito pela IA da conta
// (ou, sem IA, um modelo simples) e a conferência de que o texto cita o que precisa citar.
import { lerXmlNfse } from '../fiscal/danfse/index.js';
import { formatarDocumento } from '../util/documentos.js';

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const txt = (v) => (v === undefined || v === null ? '' : String(v).trim());
const numero = (v) => { const n = Number(txt(v)); return txt(v) && Number.isFinite(n) ? n : null; };
export const reais = (n) => `R$ ${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dataBr = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(txt(iso)); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };

// "ESTUDIO WEB LTDA" → "Estudio Web Ltda" (nome todo em maiúsculas parece carimbo); misto fica como está.
export function nomeNatural(nome) {
  const t = txt(nome).replace(/\s+/g, ' ');
  if (!t || t !== t.toUpperCase()) return t;
  const SIGLAS = /^(LTDA|ME|EPP|EIRELI|SA|S\/A|S\.A\.?|MEI|SS|SLU|CIA)$/;
  return t.toLowerCase().split(' ').map((p, i) => {
    if (SIGLAS.test(p.toUpperCase())) return p.toUpperCase() === 'LTDA' ? 'Ltda' : p.toUpperCase();
    if (i > 0 && /^(de|da|do|das|dos|e)$/.test(p)) return p;
    return p.charAt(0).toUpperCase() + p.slice(1);
  }).join(' ');
}

// Quem foi retido em PIS/COFINS/CSLL, pelo código da NFS-e (NT 007); vRetCSLL soma os retidos.
const CONTRIBUICOES = { 1: 'PIS/COFINS', 3: 'PIS/COFINS/CSLL', 4: 'PIS/COFINS', 5: 'PIS', 6: 'COFINS', 7: 'COFINS/CSLL', 8: 'CSLL', 9: 'PIS/CSLL' };

// Fatos da nota para o e-mail, a partir do XML oficial da NFS-e.
export function fatosDaNota(xml, { prestador = {}, consultaPublica = null, homologacao = false, simulacao = false, anexos = [] } = {}) {
  const inf = lerXmlNfse(xml);
  const dps = inf.DPS?.infDPS || {};
  const vDps = dps.valores || {};
  const trib = vDps.trib || {};
  const tribMun = trib.tribMun || {};
  const tribFed = trib.tribFed || {};
  const pc = tribFed.piscofins || {};
  const vNfse = inf.valores || {};
  const toma = dps.toma || {};
  const emit = inf.emit || {};

  const valorServico = numero(vDps.vServPrest?.vServ);
  const retencoes = [];
  const tpRetIss = txt(tribMun.tpRetISSQN);
  if (tpRetIss === '2' || tpRetIss === '3') {
    retencoes.push({ tributo: 'ISS', valor: numero(vNfse.vISSQN), detalhe: tpRetIss === '2' ? 'retido pelo tomador (o cliente recolhe o ISS)' : 'retido pelo intermediário' });
  }
  const irrf = numero(tribFed.vRetIRRF);
  if (irrf) retencoes.push({ tributo: 'IRRF', valor: irrf });
  const cp = numero(tribFed.vRetCP);
  if (cp) retencoes.push({ tributo: 'INSS', valor: cp });
  const tpPc = txt(pc.tpRetPisCofins);
  const contribuicoes = (numero(tribFed.vRetCSLL) || 0) + (tpPc === '1' ? (numero(pc.vPis) || 0) + (numero(pc.vCofins) || 0) : 0);
  if (contribuicoes > 0) retencoes.push({ tributo: CONTRIBUICOES[tpPc] || 'CSLL', valor: Math.round(contribuicoes * 100) / 100 });

  const somaRetida = Math.round(retencoes.reduce((s, r) => s + (r.valor || 0), 0) * 100) / 100;
  const totalRetido = numero(vNfse.vTotalRet) ?? somaRetida;
  const liquido = numero(vNfse.vLiq) ?? (valorServico !== null ? Math.round((valorServico - totalRetido) * 100) / 100 : null);
  const compet = /^(\d{4})-(\d{2})/.exec(txt(dps.dCompet));
  const docToma = toma.CNPJ ? { tipo: 'CNPJ', n: txt(toma.CNPJ) } : toma.CPF ? { tipo: 'CPF', n: txt(toma.CPF) } : null;
  const nomeEmpresa = txt(emit.xNome) || txt(dps.prest?.xNome) || txt(prestador.nome);

  return {
    empresa: { nome: nomeEmpresa, nomeNatural: nomeNatural(nomeEmpresa), documento: prestador.documento ? formatarDocumento(prestador.tipoDocumento || 'CNPJ', prestador.documento) : null },
    cliente: {
      nome: txt(toma.xNome) || null,
      nomeNatural: nomeNatural(toma.xNome) || null,
      tipo: docToma?.tipo === 'CPF' ? 'pessoa física' : docToma?.tipo === 'CNPJ' ? 'empresa' : 'não identificado',
      documento: docToma ? formatarDocumento(docToma.tipo, docToma.n) : null,
    },
    nota: {
      numero: txt(inf.nNFSe),
      emitidaEm: dataBr(inf.dhProc || dps.dhEmi),
      competencia: compet ? `${compet[2]}/${compet[1]}` : '',
      competenciaPorExtenso: compet ? `${MESES[Number(compet[2]) - 1]} de ${compet[1]}` : '',
      valorServico: valorServico !== null ? reais(valorServico) : '',
      descricaoServico: txt(dps.serv?.cServ?.xDescServ).replace(/\s+/g, ' ').slice(0, 600),
      servicoNacional: txt(inf.xTribNac).replace(/\s+/g, ' ').slice(0, 300),
      chaveAcesso: String(inf['@Id'] || '').replace(/^NFS/, ''),
      consultaPublica: consultaPublica || null,
    },
    retencao: {
      houve: retencoes.length > 0,
      itens: retencoes.map((r) => ({ tributo: r.tributo, valor: r.valor !== null ? reais(r.valor) : 'valor não informado', ...(r.detalhe ? { detalhe: r.detalhe } : {}) })),
      totalRetido: retencoes.length ? reais(totalRetido) : reais(0),
      valorLiquido: liquido !== null ? reais(liquido) : '',
    },
    anexos,
    teste: homologacao || simulacao ? (simulacao ? 'simulação do aplicativo (não é nota fiscal)' : 'nota de teste da Receita (homologação), sem valor fiscal') : null,
  };
}

// E-mails do cliente: os do cadastro (atual) e os que vieram na própria nota, sem repetir.
export function emailsDoCliente(...fontes) {
  const vistos = new Set();
  const lista = [];
  for (const f of fontes.flat()) {
    for (const e of txt(f).split(/[\s,;]+/)) {
      const x = e.toLowerCase();
      if (x && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x) && !vistos.has(x)) { vistos.add(x); lista.push(x); }
    }
  }
  return lista;
}

// ------------------------------------------------------------------ modelo do e-mail (da conta)
// O texto sai de um modelo com campos entre chaves, preenchidos com os dados do XML oficial. O modelo padrão segue
// o jeito de escrever pedido pelo usuário; cada conta pode trocar o seu em Conta › E-mail para enviar notas.
export const MODELO_PADRAO = {
  assunto: 'Nota fiscal nº {numero} - {competencia}',
  corpo: '{saudacao},\n\nA nota fiscal nº {numero}, referente aos {servicos} de {competencia}, segue emitida. O valor do serviço é de {valor}, {retencao}.\n\n{anexos}\n\nAgradeço pela confiança e pela parceria.',
};
export const CAMPOS_MODELO = {
  saudacao: 'Bom dia, Boa tarde ou Boa noite, pela hora',
  numero: 'número da NFS-e (ex.: 15)',
  servicos: 'tipo do serviço, escrito pela IA a partir da descrição da nota (ex.: serviços contábeis); sem IA, "serviços"',
  competencia: 'mês por extenso (ex.: novembro de 2026)',
  mes_ano: 'mês em números (ex.: 11/2026)',
  valor: 'valor do serviço (ex.: R$ 400,00)',
  retencao: '"sem retenção de impostos" ou "com retenção de ISS de R$ 30,00, ficando o valor líquido em R$ 1.470,00"',
  valor_liquido: 'valor depois das retenções',
  anexos: 'frase dos anexos marcados (ex.: Os arquivos em PDF (DANFSe) e XML da NFS-e acompanham este e-mail.)',
  cliente: 'nome do cliente',
  empresa: 'nome da empresa que emitiu a nota',
};
const CAMPO = /\{([a-z_]+)\}/g;
export const camposDesconhecidos = (texto) => [...new Set([...String(texto || '').matchAll(CAMPO)].map((m) => m[1]).filter((c) => !CAMPOS_MODELO[c]))];

// "Bom dia" até 12h, "Boa tarde" até 18h, "Boa noite" depois (hora de Brasília).
export function saudacaoPelaHora(agora = new Date()) {
  const hora = Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Sao_Paulo' }).format(agora));
  return hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
}

const listaNatural = (itens) => (itens.length <= 1 ? itens.join('') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`);

export function valoresDoModelo(f, { servicos = 'serviços', anexos = ['pdf', 'xml'], agora = new Date() } = {}) {
  const r = f.retencao;
  const temPdf = anexos.includes('pdf'); const temXml = anexos.includes('xml');
  return {
    saudacao: saudacaoPelaHora(agora),
    numero: f.nota.numero,
    servicos,
    competencia: f.nota.competenciaPorExtenso || f.nota.competencia,
    mes_ano: f.nota.competencia,
    valor: f.nota.valorServico,
    retencao: r.houve ? `com retenção de ${listaNatural(r.itens.map((i) => `${i.tributo} de ${i.valor}`))}, ficando o valor líquido em ${r.valorLiquido}` : 'sem retenção de impostos',
    valor_liquido: r.valorLiquido || f.nota.valorServico,
    anexos: temPdf && temXml ? 'Os arquivos em PDF (DANFSe) e XML da NFS-e acompanham este e-mail.'
      : temPdf ? 'O arquivo em PDF (DANFSe) da NFS-e acompanha este e-mail.' : temXml ? 'O arquivo XML da NFS-e acompanha este e-mail.' : '',
    cliente: f.cliente.nomeNatural || f.cliente.nome || '',
    empresa: f.empresa.nomeNatural || f.empresa.nome || '',
  };
}

// Preenche o modelo; linha que ficou vazia (ex.: sem anexos) some. Nota de teste ganha um aviso no fim.
export function preencherModelo(modelo, valores, { teste = null } = {}) {
  const trocar = (t) => String(t || '').replace(CAMPO, (m, c) => (Object.hasOwn(valores, c) ? String(valores[c] ?? '') : m));
  const assunto = trocar(modelo.assunto).replace(/\s+/g, ' ').trim().slice(0, 200);
  let corpo = trocar(modelo.corpo).replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (teste) corpo += `\n\nObservação: esta é uma ${teste}.`;
  return { assunto, corpo };
}

// ------------------------------------------------------------------ IA: tipo do serviço e ajustes pedidos
export const SISTEMA_SERVICOS = `Você completa, com poucas palavras e em português do Brasil, a frase do e-mail que acompanha uma nota fiscal de serviço:
"A nota fiscal nº 15, referente aos ___ de novembro de 2026, segue emitida."

Escreva só o que vai no espaço: o tipo de serviço, no plural e começando por "serviços". Exemplos: "serviços contábeis", "serviços de consultoria em gestão", "serviços de desenvolvimento de site", "serviços de manutenção predial", "serviços de fisioterapia", "serviços de transporte".

Regras:
- Baseie-se na descrição escrita na nota; se ela for vaga, use a descrição do código de serviço.
- No máximo 6 palavras, em letras minúsculas (exceto siglas e nomes próprios).
- Sem mês, ano, valor, número, nome de empresa ou de cliente, e sem pontuação no fim.
- Se não der para saber o tipo de serviço, responda "serviços".

Responda APENAS com um JSON: {"servicos": "..."}`;

export function pedidoServicos(f) {
  return `<nota>\n${JSON.stringify({ descricaoNaNota: f.nota.descricaoServico, codigoDeServico: f.nota.servicoNacional }, null, 1)}\n</nota>`;
}

export function lerServicos(texto) {
  const t = String(texto || '');
  let dados = null;
  for (const candidato of [t, (/```(?:json)?\s*([\s\S]*?)```/.exec(t) || [])[1], t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)]) {
    if (!candidato) continue;
    try { dados = JSON.parse(candidato); break; } catch { /* tenta o próximo formato */ }
  }
  const s = String(dados?.servicos || '').replace(/\s+/g, ' ').trim().replace(/[.;:!]+$/, '');
  if (!/^serviços\b/i.test(s) || s.length > 70 || /[\d\n{}<>"]|R\$/.test(s) || s.split(' ').length > 8) return null;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export const SISTEMA_AJUSTE = `Você ajusta o e-mail que acompanha uma nota fiscal de serviço (NFS-e) enviada ao cliente. O e-mail atual foi escrito pelo próprio usuário (ou montado com o modelo dele): esse é o jeito dele de escrever e deve ser mantido.

Faça SÓ a mudança pedida e mantenha todo o resto igual: mesma saudação, mesmas frases, mesmo tom (cordial e profissional) e mesma despedida. Se o pedido for para incluir algo, acrescente uma frase curta no lugar mais natural.

Nunca:
- altere ou remova o número da nota, a competência, o valor, a informação de retenção (com os valores) ou a frase dos anexos;
- invente dados que não estejam nos fatos ou no pedido (vencimento, forma de pagamento, dados bancários, prazos, valores, nomes);
- use emojis, markdown (asteriscos, títulos, listas), travessão longo (—) ou exclamações que o texto não tinha;
- use expressões de e-mail automático ("Espero que este e-mail o encontre bem", "Venho por meio deste", "Não hesite em entrar em contato").

Português do Brasil. Responda APENAS com um JSON, sem texto antes ou depois:
{"assunto": "…", "corpo": "…"}
No "corpo", use \\n para as quebras de linha.`;

export function pedidoAjuste(f, atual, instrucao) {
  return [
    `<fatos>\n${JSON.stringify({ nota: f.nota, retencao: f.retencao, anexos: f.anexos, cliente: f.cliente.nomeNatural, empresa: f.empresa.nomeNatural, teste: f.teste }, null, 1)}\n</fatos>`,
    `<email_atual>\nAssunto: ${String(atual.assunto || '').slice(0, 200)}\n\n${String(atual.corpo || '').slice(0, 4000)}\n</email_atual>`,
    `<pedido>\n${String(instrucao).slice(0, 500)}\n</pedido>`,
  ].join('\n\n');
}

// Lê {assunto, corpo} da resposta (com ou sem bloco de código) e limpa marcas de IA que escapem.
export function lerRedacao(texto) {
  const t = String(texto || '');
  let dados = null;
  for (const candidato of [t, (/```(?:json)?\s*([\s\S]*?)```/.exec(t) || [])[1], t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)]) {
    if (!candidato) continue;
    try { dados = JSON.parse(candidato); break; } catch { /* tenta o próximo formato */ }
  }
  if (!dados || typeof dados.assunto !== 'string' || typeof dados.corpo !== 'string') return null;
  const limpar = (s) => s.replace(/\*\*|__/g, '').replace(/\s*—\s*/g, ' - ').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const assunto = limpar(dados.assunto).replace(/\s+/g, ' ').slice(0, 200);
  const corpo = limpar(dados.corpo).slice(0, 8000);
  return assunto && corpo ? { assunto, corpo } : null;
}

// O que o texto (talvez editado pelo usuário) deixou de citar: aviso na tela, nunca bloqueio.
export function faltasNoTexto(f, corpo) {
  const c = String(corpo || '');
  const semEspaco = c.replace(/\s/g, '');
  const faltas = [];
  if (f.nota.numero && !new RegExp(`(^|\\D)${f.nota.numero}(\\D|$)`).test(c)) faltas.push('o número da nota');
  const [mes, ano] = f.nota.competencia.split('/');
  const nomeMes = MESES[Number(mes) - 1] || '-';
  if (f.nota.competencia && !(c.includes(f.nota.competencia) || (new RegExp(nomeMes, 'i').test(c) && c.includes(ano)) || c.includes(`${mes}/${ano}`))) faltas.push('a competência');
  if (f.nota.valorServico && !semEspaco.includes(f.nota.valorServico.replace(/\s/g, ''))) faltas.push('o valor do serviço');
  if (!/reten|retid/i.test(c)) faltas.push('se houve retenção');
  return faltas;
}
