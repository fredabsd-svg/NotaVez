// A NFS-e que a Receita devolve para um Id de DPS é mesmo a da DPS que este app enviou?
//
// O Id da DPS é município + CNPJ + série + número. Outro sistema da empresa (um ERP, outro emissor)
// pode já ter usado a mesma série e o mesmo número. Nesse caso a Receita recusa o envio por
// duplicidade (E0014) e a consulta pelo Id devolve a nota DELE. Concluir a nota do app com essa
// chave seria apresentar como emitida uma nota que não foi.
//
// A NFS-e traz dentro dela a DPS que a originou, como foi assinada. A data e a hora de emissão da
// DPS (dhEmi, com segundos) dizem se é a mesma: duas DPS diferentes com o mesmo Id e o mesmo
// instante de emissão não acontecem na prática.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false });
const instante = (v) => {
  const t = new Date(String(typeof v === 'object' && v !== null ? v['#text'] ?? '' : v ?? '').trim()).getTime();
  return Number.isFinite(t) ? t : null;
};

/** true: é a DPS enviada pelo app; false: é outra nota; null: não deu para conferir. */
export function mesmaDps(dpsEnviadaXml, nfseXml) {
  let nossa; let dela;
  try {
    nossa = parser.parse(String(dpsEnviadaXml || ''))?.DPS?.infDPS;
    dela = parser.parse(String(nfseXml || ''))?.NFSe?.infNFSe?.DPS?.infDPS;
  } catch { return null; }
  const a = instante(nossa?.dhEmi);
  const b = instante(dela?.dhEmi);
  if (a === null || b === null) return null;
  return a === b;
}
