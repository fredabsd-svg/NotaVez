// Arquivos que a pessoa manda no chat do assistente: planilhas (xlsx/csv), PDF, Word (docx), texto e XML.
// O conteúdo vira texto aqui no servidor e entra na conversa como DADO (nunca como instrução).
import { unzipSync, strFromU8 } from 'fflate';
import { invalido } from '../util/erros.js';

export const LIMITE_BYTES = 3 * 1024 * 1024;        // por arquivo (a Vercel aceita até 4,5 MB por requisição)
export const LIMITE_TOTAL_BYTES = 3 * 1024 * 1024;  // por mensagem
export const MAX_ARQUIVOS = 5;
const MAX_CARACTERES = 80_000;                      // por arquivo, depois de extraído
const MAX_LINHAS_ABA = 3000;

const TIPOS = {
  xlsx: 'planilha', xlsm: 'planilha', csv: 'planilha', tsv: 'planilha',
  pdf: 'pdf', docx: 'documento', txt: 'texto', md: 'texto', xml: 'xml', json: 'texto',
};
const extensao = (nome) => String(nome || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1] || '';

const entidades = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const desfazer = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : entidades[e.toLowerCase()]));

function texto(buf) {
  // Arquivos salvos pelo Excel em português costumam vir em Windows-1252: se não for UTF-8 válido, é ele.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, ''); } catch { return new TextDecoder('windows-1252').decode(buf); }
}
function zip(buf) {
  try { return unzipSync(new Uint8Array(buf)); } catch { throw invalido('Não foi possível abrir o arquivo: ele parece corrompido ou não é do tipo indicado.'); }
}
const lerXml = (arquivos, caminho) => (arquivos[caminho] ? strFromU8(arquivos[caminho]) : '');

// ---------------------------------------------------------------- Excel (.xlsx)
function colunaParaIndice(ref) {
  const letras = String(ref).match(/^[A-Z]+/)?.[0] || 'A';
  let n = 0;
  for (const c of letras) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}
function dataExcel(serial) {
  const ms = Math.round((Number(serial) - 25569) * 86400_000); // 25569 = dias entre 30/12/1899 e 01/01/1970
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${iso.slice(11, 16)}`;
}

function planilhaXlsx(buf) {
  const a = zip(buf);
  const compartilhadas = [...lerXml(a, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => desfazer([...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  // Estilos de data: formatos internos 14–22 e 45–47, ou formatos próprios com dia/mês/ano.
  const estilos = lerXml(a, 'xl/styles.xml');
  const formatosProprios = new Map([...estilos.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)].map((m) => [Number(m[1]), desfazer(m[2])]));
  const xfs = estilos.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] || '';
  const ehData = [...xfs.matchAll(/<xf\b[^>]*?numFmtId="(\d+)"/g)].map((m) => {
    const id = Number(m[1]);
    const f = formatosProprios.get(id);
    return (id >= 14 && id <= 22) || (id >= 45 && id <= 47) || (!!f && /[dy]/i.test(f.replace(/"[^"]*"|\[[^\]]*\]/g, '')));
  });
  const rels = new Map([...lerXml(a, 'xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const abas = [...lerXml(a, 'xl/workbook.xml').matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"/g)]
    .map((m) => ({ nome: desfazer(m[1]), caminho: `xl/${String(rels.get(m[2]) || '').replace(/^\/?xl\//, '').replace(/^\//, '')}` }));
  const saida = [];
  for (const aba of abas) {
    const xml = lerXml(a, aba.caminho);
    if (!xml) continue;
    const linhas = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (linhas.length >= MAX_LINHAS_ABA) { linhas.push(`… (aba com mais de ${MAX_LINHAS_ABA} linhas: o restante foi omitido)`); break; }
      const celulas = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
        const t = attrs.match(/\bt="(\w+)"/)?.[1];
        const s = Number(attrs.match(/\bs="(\d+)"/)?.[1] ?? -1);
        const corpo = c[2] || '';
        const v = corpo.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let valor = '';
        if (t === 's') valor = compartilhadas[Number(v)] ?? '';
        else if (t === 'inlineStr') valor = desfazer([...corpo.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
        else if (t === 'b') valor = v === '1' ? 'VERDADEIRO' : 'FALSO';
        else if (v !== undefined) valor = t !== 'str' && t !== 'e' && ehData[s] ? dataExcel(v) : desfazer(v);
        const i = ref ? colunaParaIndice(ref) : celulas.length;
        celulas[i] = String(valor).replace(/[\t\r\n]+/g, ' ').trim();
      }
      if (celulas.some((x) => x)) linhas.push(Array.from(celulas, (x) => x ?? '').join('\t'));
    }
    saida.push(`### Aba "${aba.nome}" (${linhas.length} linhas; colunas separadas por tabulação)\n${linhas.join('\n')}`);
  }
  if (!saida.length) throw invalido('A planilha não tem abas com dados legíveis.');
  return { texto: saida.join('\n\n'), detalhe: `${abas.length} aba(s)` };
}

// ---------------------------------------------------------------- Word (.docx)
function documentoDocx(buf) {
  const a = zip(buf);
  const xml = lerXml(a, 'word/document.xml');
  if (!xml) throw invalido('O arquivo Word não tem conteúdo legível (use .docx; o formato antigo .doc não é aceito).');
  const corpo = xml
    // Dentro de uma célula de tabela, parágrafos viram espaço (a célula fica numa linha só).
    .replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (tc) => tc.replace(/<\/w:p>/g, ' '))
    .replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>|<w:cr\/>/g, '\n')
    .replace(/<\/w:tc>/g, ' | ').replace(/<\/w:tr>/g, '\n').replace(/<\/w:p>/g, '\n')
    .replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (_, t) => `\u0000${t}\u0001`)
    .replace(/<[^>]+>/g, '')
    .replace(/\u0000([\s\S]*?)\u0001/g, (_, t) => t);
  const textoFinal = desfazer(corpo).replace(/ \| *\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { texto: textoFinal, detalhe: `${textoFinal.split(/\s+/).filter(Boolean).length} palavras` };
}

// ---------------------------------------------------------------- PDF
async function documentoPdf(buf) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  let pdf;
  try { pdf = await getDocumentProxy(new Uint8Array(buf)); } catch { throw invalido('Não foi possível abrir o PDF (corrompido ou protegido por senha).'); }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const paginas = (Array.isArray(text) ? text : [text]).map((t, i) => `--- página ${i + 1} ---\n${String(t || '').trim()}`);
  const textoFinal = paginas.join('\n\n').trim();
  const semTexto = !String(Array.isArray(text) ? text.join('') : text).replace(/\s/g, '');
  return { texto: semTexto ? '' : textoFinal, detalhe: `${totalPages} página(s)${semTexto ? ', sem texto (PDF digitalizado: a IA não lê imagens nesta versão)' : ''}` };
}

// ---------------------------------------------------------------- entrada
export async function extrairAnexo({ nome, base64 }) {
  const nomeLimpo = String(nome || 'arquivo').replace(/[\\/\0-\x1f]/g, '_').slice(0, 120);
  const ext = extensao(nomeLimpo);
  const tipo = TIPOS[ext];
  if (!tipo) {
    throw invalido(ext === 'xls' || ext === 'doc'
      ? `O formato antigo .${ext} não é aceito. Abra no ${ext === 'xls' ? 'Excel' : 'Word'} e salve como .${ext}x.`
      : 'Tipo de arquivo não aceito. Envie Excel (.xlsx), CSV, PDF, Word (.docx), XML ou texto.');
  }
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) throw invalido(`O arquivo ${nomeLimpo} está vazio.`);
  if (buf.length > LIMITE_BYTES) throw invalido(`O arquivo ${nomeLimpo} passa de 3 MB.`);
  let r;
  if (ext === 'xlsx' || ext === 'xlsm') r = planilhaXlsx(buf);
  else if (ext === 'docx') r = documentoDocx(buf);
  else if (ext === 'pdf') r = await documentoPdf(buf);
  else { const t = texto(buf); r = { texto: t, detalhe: `${t.split('\n').length} linha(s)` }; }
  let conteudo = r.texto || '';
  const cortado = conteudo.length > MAX_CARACTERES;
  if (cortado) conteudo = `${conteudo.slice(0, MAX_CARACTERES)}\n… [arquivo cortado: só os primeiros ${MAX_CARACTERES.toLocaleString('pt-BR')} caracteres foram lidos]`;
  return { nome: nomeLimpo, tipo, bytes: buf.length, caracteres: conteudo.length, detalhe: r.detalhe + (cortado ? ', cortado' : ''), texto: conteudo };
}

export async function lerAnexos(lista) {
  if (lista === undefined || lista === null) return [];
  if (!Array.isArray(lista)) throw invalido('Anexos em formato inválido.');
  if (lista.length > MAX_ARQUIVOS) throw invalido(`Envie até ${MAX_ARQUIVOS} arquivos por mensagem.`);
  const total = lista.reduce((s, a) => s + Math.floor(String(a?.base64 || '').length * 3 / 4), 0);
  if (total > LIMITE_TOTAL_BYTES) throw invalido('Os arquivos desta mensagem passam de 3 MB no total. Envie em mensagens separadas.');
  const r = [];
  for (const a of lista) r.push(await extrairAnexo(a || {}));
  return r;
}

// Como o anexo aparece para o modelo: delimitado e marcado como dado.
export const anexoParaModelo = (a) => `\n\n<arquivo_anexado nome="${a.nome.replace(/"/g, "'")}" tipo="${a.tipo}" detalhe="${a.detalhe}">\n${a.texto || '(nenhum texto encontrado no arquivo)'}\n</arquivo_anexado>`;
