// Gera um certificado A1 FICTÍCIO (somente para testes automatizados e modo
// demonstração). Não tem validade jurídica e é rejeitado pela Receita.
import forge from 'node-forge';

const { asn1, pki } = forge;

function sanComCnpj(cnpj) {
  const otherName = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer('2.16.76.1.3.3').getBytes()),
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
      asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, cnpj),
    ]),
  ]);
  return asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [otherName])).getBytes();
}

export function gerarCertificadoTeste({ cnpj = '11222333000181', senha = 'teste', validoAte, nome = 'MEI TESTE' } = {}) {
  const ca = pki.rsa.generateKeyPair(2048);
  const caCert = pki.createCertificate();
  caCert.publicKey = ca.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date(Date.now() - 86400_000);
  caCert.validity.notAfter = new Date(Date.now() + 3 * 365 * 86400_000);
  const caAttrs = [{ name: 'commonName', value: 'AC TESTE NotaVez' }, { name: 'organizationName', value: 'ICP-Brasil (SIMULADO - SOMENTE TESTE)' }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([{ name: 'basicConstraints', cA: true }]);
  caCert.sign(ca.privateKey, forge.md.sha256.create());

  const k = pki.rsa.generateKeyPair(2048);
  const c = pki.createCertificate();
  c.publicKey = k.publicKey;
  c.serialNumber = '02';
  c.validity.notBefore = new Date(Date.now() - 86400_000);
  c.validity.notAfter = validoAte || new Date(Date.now() + 365 * 86400_000);
  c.setSubject([{ name: 'commonName', value: `${nome}:${cnpj}` }]);
  c.setIssuer(caAttrs);
  c.setExtensions([
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, keyEncipherment: true },
    { name: 'extKeyUsage', clientAuth: true },
    { id: '2.5.29.17', value: sanComCnpj(cnpj) },
  ]);
  c.sign(ca.privateKey, forge.md.sha256.create());

  const p12 = forge.pkcs12.toPkcs12Asn1(k.privateKey, [c, caCert], senha, { algorithm: '3des' });
  return {
    pfx: Buffer.from(asn1.toDer(p12).getBytes(), 'binary'),
    senha,
    certPem: pki.certificateToPem(c),
    chavePem: pki.privateKeyToPem(k.privateKey),
    caPem: pki.certificateToPem(caCert),
    caChavePem: pki.privateKeyToPem(ca.privateKey),
  };
}
