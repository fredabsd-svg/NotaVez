// Validação local contra os esquemas XSD OFICIAIS (pacote
// esquemas-nfse-rtc-v1-01-20260727, Portal Nacional da NFS-e), antes de
// assinar e enviar. Evita rejeições E1235 (falha de esquema).
import { readFileSync, readdirSync } from 'node:fs';
import { validateXML } from 'xmllint-wasm';

const dir = new URL('./xsd/', import.meta.url);
const arquivos = readdirSync(dir).filter((f) => f.endsWith('.xsd'));
const preload = arquivos.map((f) => ({ fileName: f, contents: readFileSync(new URL(f, dir), 'utf8') }));

export async function validarXsd(xml, raiz = 'DPS_v1.01.xsd') {
  const schema = preload.find((p) => p.fileName === raiz);
  const r = await validateXML({
    xml: [{ fileName: 'documento.xml', contents: xml }],
    schema: [schema],
    preload: preload.filter((p) => p.fileName !== raiz),
  });
  return { valido: r.valid, erros: r.errors.map((e) => e.message || e.rawMessage || String(e)) };
}
