// Assinatura XMLDSig da DPS (enveloped, RSA-SHA256, digest SHA-256), com a
// referência apontando para o Id de infDPS e a <Signature> como irmã de infDPS.
import { SignedXml } from 'xml-crypto';

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ALG = {
  assinatura: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  digest: 'http://www.w3.org/2001/04/xmlenc#sha256',
  c14n: process.env.NOTAVEZ_C14N || C14N,
};

const certBase64 = (pem) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');

export function assinarDps(xml, { chavePem, certPem }) {
  const sig = new SignedXml({
    privateKey: chavePem,
    publicCert: certPem,
    signatureAlgorithm: ALG.assinatura,
    canonicalizationAlgorithm: ALG.c14n,
    getKeyInfoContent: () => `<X509Data><X509Certificate>${certBase64(certPem)}</X509Certificate></X509Data>`,
  });
  sig.addReference({
    xpath: "//*[local-name(.)='infDPS']",
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', ALG.c14n],
    digestAlgorithm: ALG.digest,
  });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='infDPS']", action: 'after' } });
  return sig.getSignedXml();
}

export function conferirAssinatura(xmlAssinado, certPem) {
  const doc = xmlAssinado;
  const m = doc.match(/<Signature[\s\S]*<\/Signature>/);
  if (!m) return false;
  const v = new SignedXml({ publicCert: certPem });
  v.loadSignature(m[0]);
  return v.checkSignature(doc);
}
