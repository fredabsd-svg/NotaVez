// Leitura e verificação do certificado digital A1 (arquivo .pfx/.p12) do
// emitente. Só o servidor manipula a chave privada; ela fica cifrada em
// repouso e nunca volta para o aplicativo.
import forge from 'node-forge';

const OID_CNPJ = '2.16.76.1.3.3'; // ICP-Brasil: CNPJ da pessoa jurídica titular
const OID_CPF_PF = '2.16.76.1.3.1'; // ICP-Brasil: dados do titular PF (nascimento + CPF ...)

export class ErroCertificado extends Error {}

function lerOutrosNomes(cert) {
  const ext = cert.extensions.find((e) => e.name === 'subjectAltName');
  const achados = {};
  if (!ext || !ext.value) return achados;
  const asn = forge.asn1.fromDer(ext.value);
  for (const nome of asn.value) {
    // otherName: [0] { OID, [0] EXPLICIT valor }
    if (nome.tagClass !== forge.asn1.Class.CONTEXT_SPECIFIC || nome.type !== 0) continue;
    const [oidNode, valNode] = nome.value;
    const oid = forge.asn1.derToOid(oidNode.value);
    let v = valNode?.value?.[0]?.value;
    if (Array.isArray(v)) v = v.map((x) => x.value).join('');
    achados[oid] = String(v ?? '');
  }
  return achados;
}

export function lerCertificado(pfx, senha) {
  let p12;
  try {
    const asn = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn, false, senha);
  } catch (e) {
    throw new ErroCertificado(/mac|password|invalid/i.test(e.message)
      ? 'Senha do certificado incorreta ou arquivo danificado.'
      : 'Não foi possível ler o arquivo. Envie o certificado A1 no formato .pfx ou .p12.');
  }
  const chaves = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ];
  const certs = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  if (!chaves.length || !certs.length) throw new ErroCertificado('O arquivo não contém certificado e chave privada.');
  const chave = chaves[0].key;
  // Certificado do titular = o que corresponde à chave privada.
  const titular = certs.find((c) => c.cert.publicKey.n && c.cert.publicKey.n.equals(chave.n))?.cert;
  if (!titular) throw new ErroCertificado('A chave privada não corresponde a nenhum certificado do arquivo.');
  const cadeia = certs.map((c) => c.cert).filter((c) => c !== titular);

  const outros = lerOutrosNomes(titular);
  const cnpj = outros[OID_CNPJ] ? outros[OID_CNPJ].toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 14) : null;
  const cpf = outros[OID_CPF_PF] ? outros[OID_CPF_PF].replace(/\D/g, '').slice(8, 19) : null;
  const ku = titular.getExtension('keyUsage');
  const cn = titular.subject.getField('CN')?.value || '';
  const emissor = titular.issuer.getField('CN')?.value || '';
  const cadeiaTexto = [titular, ...cadeia].map((c) => c.issuer.attributes.map((a) => a.value).join(' ')).join(' ');

  return {
    titular: cn,
    emissor,
    cnpj,
    cpf,
    validoDe: titular.validity.notBefore.toISOString(),
    validoAte: titular.validity.notAfter.toISOString(),
    assinaturaDigital: !ku || !!ku.digitalSignature,
    icpBrasil: /ICP-Brasil/i.test(cadeiaTexto),
    chavePem: forge.pki.privateKeyToPem(chave),
    certPem: forge.pki.certificateToPem(titular),
    cadeiaPem: cadeia.map((c) => forge.pki.certificateToPem(c)),
  };
}

// Checagens que antecipam E1203/E0715 (validade), E1209/E0716 (CNPJ no
// certificado), E0718 (assinar com o certificado do emitente) e E1208 (ICP-Brasil).
export function verificarParaEmitente(info, documentoEmitente, agora = new Date()) {
  const problemas = [];
  if (new Date(info.validoAte) < agora) problemas.push('O certificado está vencido. Renove com sua autoridade certificadora.');
  if (new Date(info.validoDe) > agora) problemas.push('O certificado ainda não está válido.');
  if (!info.cnpj) problemas.push('Este não é um e-CNPJ (não encontramos o CNPJ no certificado). Para o MEI, use o certificado A1 do CNPJ.');
  else if (documentoEmitente && info.cnpj !== documentoEmitente) problemas.push('O CNPJ do certificado é diferente do CNPJ do seu perfil. A nota precisa ser assinada pelo próprio emitente.');
  if (!info.assinaturaDigital) problemas.push('O certificado não permite assinatura digital.');
  if (!info.icpBrasil) problemas.push('O certificado não parece ser ICP-Brasil. A Receita só aceita certificados ICP-Brasil.');
  return problemas;
}
