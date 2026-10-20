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
  const caAttrs = [{ name: 'commonName', value: 'AC TESTE Nota Sem Stress' }, { name: 'organizationName', value: 'ICP-Brasil (SIMULADO - SOMENTE TESTE)' }];
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

// ---------- Cadeia ICP-Brasil FICTÍCIA para testar o login com certificado ----------
// Raiz → AC intermediária → titular (e-CPF ou e-CNPJ), com a política ICP-Brasil
// (OID 2.16.76.1.2.*) e o CPF/CNPJ no subjectAltName, como nos certificados reais.
function otherName(oid, valor) {
  return asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oid).getBytes()),
    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, valor)]),
  ]);
}
const seq = (itens) => asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, itens)).getBytes();
const politica = (oid) => seq([asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
  asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(oid).getBytes())])]);

function emitir({ chave, assinante, emissorAttrs, sujeitoAttrs, serial, ca = false, extensoes = [], de, ate }) {
  const c = pki.createCertificate();
  c.publicKey = chave.publicKey;
  c.serialNumber = serial;
  c.validity.notBefore = de || new Date(Date.now() - 86400_000);
  c.validity.notAfter = ate || new Date(Date.now() + 365 * 86400_000);
  c.setSubject(sujeitoAttrs);
  c.setIssuer(emissorAttrs);
  c.setExtensions([{ name: 'basicConstraints', cA: ca, critical: true }, ...extensoes]);
  c.sign(assinante, forge.md.sha256.create());
  return c;
}

export function gerarCadeiaIcpTeste() {
  const raizK = pki.rsa.generateKeyPair(2048);
  const raizAttrs = [{ name: 'commonName', value: 'AC Raiz TESTE ICP-Brasil' }, { name: 'organizationName', value: 'ICP-Brasil (SIMULADO)' }];
  const raiz = emitir({ chave: raizK, assinante: raizK.privateKey, emissorAttrs: raizAttrs, sujeitoAttrs: raizAttrs, serial: '10', ca: true, ate: new Date(Date.now() + 5 * 365 * 86400_000) });
  const intK = pki.rsa.generateKeyPair(2048);
  const intAttrs = [{ name: 'commonName', value: 'AC Intermediaria TESTE' }, { name: 'organizationName', value: 'ICP-Brasil (SIMULADO)' }];
  const inter = emitir({ chave: intK, assinante: raizK.privateKey, emissorAttrs: raizAttrs, sujeitoAttrs: intAttrs, serial: '11', ca: true });
  let serie = 20;
  const titular = ({ cpf, cnpj, comPolitica = true, vencido = false, assinante = intK.privateKey, emissorAttrs = intAttrs } = {}) => {
    const k = pki.rsa.generateKeyPair(1024);
    const nomes = [cpf ? otherName('2.16.76.1.3.1', `01011990${cpf}00000000000`) : null, cnpj ? otherName('2.16.76.1.3.3', cnpj) : null].filter(Boolean);
    const c = emitir({
      chave: k, assinante, emissorAttrs, sujeitoAttrs: [{ name: 'commonName', value: `TITULAR TESTE:${cpf || cnpj}` }], serial: String(serie += 1),
      extensoes: [
        { name: 'keyUsage', digitalSignature: true },
        { id: '2.5.29.17', value: seq(nomes) },
        ...(comPolitica ? [{ id: '2.5.29.32', value: politica('2.16.76.1.2.1.51') }] : []),
      ],
      ...(vencido ? { de: new Date(Date.now() - 3 * 86400_000), ate: new Date(Date.now() - 86400_000) } : {}),
    });
    return Buffer.from(asn1.toDer(pki.certificateToAsn1(c)).getBytes(), 'binary').toString('base64');
  };
  // Outra "raiz" fora do pacote confiável.
  const forasteiraK = pki.rsa.generateKeyPair(1024);
  const forasteiraAttrs = [{ name: 'commonName', value: 'AC FORA DA ICP' }];
  return {
    cadeiasPem: pki.certificateToPem(raiz) + pki.certificateToPem(inter),
    titular,
    forasteiro: (opcoes) => titular({ ...opcoes, assinante: forasteiraK.privateKey, emissorAttrs: forasteiraAttrs }),
    // Mesmo nome da AC intermediária, mas assinado por outra chave (falsificação).
    falsificado: (opcoes) => titular({ ...opcoes, assinante: forasteiraK.privateKey }),
  };
}
