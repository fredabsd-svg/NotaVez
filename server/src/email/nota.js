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
  if (cp) retencoes.push({ tributo: 'INSS (contribuição previdenciária)', valor: cp });
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

// ------------------------------------------------------------------ texto sem IA (modelo simples)
export function textoModelo(f) {
  const n = f.nota;
  const r = f.retencao;
  const primeiroNome = f.cliente.tipo === 'pessoa física' && f.cliente.nomeNatural ? f.cliente.nomeNatural.split(' ')[0] : '';
  const linhaRetencao = r.houve
    ? `Nesta nota houve retenção de ${r.itens.map((i) => `${i.tributo} (${i.valor})`).join(', ')}, então o valor líquido fica em ${r.valorLiquido}.`
    : 'Não houve retenção de impostos nesta nota.';
  const anexos = f.anexos.length === 2 ? 'O PDF e o XML da nota estão em anexo.' : f.anexos.length === 1 ? `O ${f.anexos[0].startsWith('PDF') ? 'PDF' : 'XML'} da nota está em anexo.` : '';
  const corpo = [
    primeiroNome ? `Olá, ${primeiroNome}, tudo bem?` : 'Olá, tudo bem?',
    '',
    `Segue a nota fiscal de serviço nº ${n.numero}, referente a ${n.competenciaPorExtenso || n.competencia}, no valor de ${n.valorServico}. ${linhaRetencao}`,
    ...(anexos ? ['', anexos] : []),
    ...(f.teste ? ['', `Atenção: esta é uma ${f.teste}.`] : []),
    '',
    'Obrigado pela confiança de sempre!',
    '',
    'Abraço,',
    f.empresa.nomeNatural || f.empresa.nome,
  ].join('\n');
  return { assunto: `Nota fiscal nº ${n.numero} - ${n.competencia}`, corpo };
}

// ------------------------------------------------------------------ texto pela IA
export const SISTEMA_EMAIL = `Você escreve, em nome de uma empresa prestadora de serviços, o e-mail que acompanha a nota fiscal de serviço (NFS-e) enviada ao cliente dela. Quem envia é a empresa (ou o escritório de contabilidade que cuida dela); quem lê é o cliente que contratou o serviço. Escreva em português do Brasil.

O tom é o de uma pessoa de verdade escrevendo para um cliente que ela conhece: cordial, simples, direto e caloroso na medida certa. Pense em alguém atencioso de um pequeno negócio mandando a nota do mês, não em um robô, um banco ou uma central de atendimento.

O que o e-mail PRECISA trazer, sempre com os valores exatamente como estão nos fatos:
- o número da nota;
- a competência (mês e ano a que o serviço se refere);
- o valor do serviço;
- se houve ou não retenção de impostos. Se houve, diga quais tributos e os valores retidos, e o valor líquido. Se não houve, diga isso numa frase curta. Retenção de ISS "pelo tomador" quer dizer que o próprio cliente recolhe o ISS; pode dizer isso com naturalidade, sem explicar legislação;
- que a nota segue em anexo (cite só os anexos listados nos fatos: PDF, XML ou os dois);
- um agradecimento sincero e breve (pela parceria, pela confiança, pelo trabalho junto), sem exagero.

Como escrever:
- Curto: de 4 a 8 linhas no corpo, em parágrafos pequenos. Frases curtas. Nada de enrolação.
- Comece com uma saudação simples e humana ("Olá, Ana, tudo bem?", "Oi, pessoal da Padaria Central,", "Olá, tudo bem?"). Para pessoa física use só o primeiro nome. Para empresa, uma saudação ao pessoal da empresa ou só "Olá, tudo bem?". Se o nome vier todo em maiúsculas, escreva com iniciais maiúsculas.
- Termine com uma despedida curta ("Abraço,", "Um abraço,", "Obrigado e até mais,") e, na linha de baixo, o nome da empresa (em "nomeNatural").
- Varie a construção das frases; não siga um molde fixo.
- Se for nota de teste ou simulação (campo "teste"), avise isso numa frase, sem alarde.
- Se houver instruções do usuário sobre o texto, siga-as, desde que não contradigam os fatos nem estas regras.

Nunca:
- invente informação que não está nos fatos (vencimento, forma de pagamento, dados bancários, prazos, descontos, datas, nomes de pessoas);
- use expressões feitas de e-mail automático ou de telemarketing: "Espero que este e-mail o encontre bem", "Prezado(a) cliente", "Caro cliente", "Venho por meio deste", "Gostaríamos de informar", "Informamos que", "Não hesite em entrar em contato", "Estamos à inteira disposição", "Sem mais para o momento", "Cordialmente";
- use emojis, markdown (asteriscos, títulos, listas com marcadores), travessão longo (—), aspas desnecessárias ou mais de uma exclamação no e-mail inteiro;
- deixe espaços para preencher como [Nome] ou {valor};
- coloque a chave de acesso ou o link de consulta, a menos que o usuário peça.

O assunto é curto e objetivo, com o número da nota e a competência (exemplos de forma: "Nota fiscal nº 1234 - outubro/2026", "NFS-e 1234 | serviço de outubro/2026"), sem emojis.

Responda APENAS com um JSON, sem texto antes ou depois:
{"assunto": "…", "corpo": "…"}
No "corpo", use \\n para as quebras de linha.`;

// Pedido ao modelo: os fatos em JSON e, se houver, as instruções do usuário (tratadas como preferência de texto).
export function pedidoRedacao(fatos, { instrucao = '', anterior = null } = {}) {
  const partes = [`Escreva o e-mail da nota abaixo e responda só com o JSON pedido.\n\n<fatos>\n${JSON.stringify(fatos, null, 1)}\n</fatos>`];
  if (anterior?.corpo) partes.push(`Versão anterior (escreva outra diferente, mantendo os fatos):\n<anterior>\n${String(anterior.corpo).slice(0, 3000)}\n</anterior>`);
  if (instrucao) partes.push(`Preferências do usuário para este texto:\n<preferencias>\n${String(instrucao).slice(0, 500)}\n</preferencias>`);
  return partes.join('\n\n');
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
