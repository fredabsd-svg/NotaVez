// Validação local contra os esquemas XSD OFICIAIS antes de assinar e enviar. Evita rejeições E1235 (falha de
// esquema). Dois leiautes convivem na transição da NT 009 (mesma versão "1.01" no XML):
// - "nt004": pacote esquemas-nfse-rtc-v1-01-20260727 (produção, NT 004 + domínio do tpRetPisCofins da NT 007);
// - "nt009": esquemas da produção restrita de 20/10/2026 (NT 009, "release 1"), previstos para a produção.
import { readFileSync, readdirSync } from 'node:fs';
import { validateXML } from 'xmllint-wasm';

export const LEIAUTES = ['nt004', 'nt009'];
const pastas = { nt004: './xsd/', nt009: './xsd-nt009/' };
const preloads = Object.fromEntries(LEIAUTES.map((l) => {
  const dir = new URL(pastas[l], import.meta.url);
  return [l, readdirSync(dir).filter((f) => f.endsWith('.xsd')).map((f) => ({ fileName: f, contents: readFileSync(new URL(f, dir), 'utf8') }))];
}));

export async function validarXsd(xml, raiz = 'DPS_v1.01.xsd', { leiaute = 'nt004' } = {}) {
  const preload = preloads[leiaute] || preloads.nt004;
  const schema = preload.find((p) => p.fileName === raiz);
  const r = await validateXML({
    xml: [{ fileName: 'documento.xml', contents: xml }],
    schema: [schema],
    preload: preload.filter((p) => p.fileName !== raiz),
  });
  return { valido: r.valid, erros: r.errors.map((e) => e.message || e.rawMessage || String(e)) };
}

// NFS-e trazida de fora (importação): vale se passar em qualquer um dos leiautes em uso.
export async function validarXsdQualquer(xml, raiz) {
  let primeiro = null;
  for (const leiaute of LEIAUTES) {
    const r = await validarXsd(xml, raiz, { leiaute });
    if (r.valido) return { ...r, leiaute };
    primeiro ||= r;
  }
  return primeiro;
}
