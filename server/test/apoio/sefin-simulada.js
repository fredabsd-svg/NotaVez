// Simulador LOCAL da Sefin Nacional para testes automatizados. Reproduz o
// contrato usado pelo NotaVez (POST /nfse, GET /dps/{id}, GET /nfse/{chave})
// com TLS mútuo, valida assinatura e XSD, e aplica algumas regras oficiais.
// NÃO substitui os testes no ambiente oficial de produção restrita.
import https from 'node:https';
import forge from 'node-forge';
import { gzipSync, gunzipSync } from 'node:zlib';
import { conferirAssinatura } from '../../src/fiscal/assinatura.js';
import { validarXsd } from '../../src/fiscal/xsd.js';

function certServidor(caPem, caChavePem) {
  const { pki } = forge;
  const k = pki.rsa.generateKeyPair(2048);
  const c = pki.createCertificate();
  c.publicKey = k.publicKey;
  c.serialNumber = '10';
  c.validity.notBefore = new Date(Date.now() - 86400_000);
  c.validity.notAfter = new Date(Date.now() + 86400_000);
  c.setSubject([{ name: 'commonName', value: 'localhost' }]);
  c.setIssuer(pki.certificateFromPem(caPem).subject.attributes);
  c.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }]);
  c.sign(pki.privateKeyFromPem(caChavePem), forge.md.sha256.create());
  return { key: pki.privateKeyToPem(k.privateKey), cert: pki.certificateToPem(c) };
}

const tag = (xml, t) => xml.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];

export async function iniciarSefinSimulada({ caPem, caChavePem, certClientePem }) {
  const estado = {
    cenario: [],          // fila de comportamentos: 'ok' | 'rejeitar' | 'timeout_apos_processar' | 'timeout_sem_processar' | 'erro500'
    geradas: new Map(),   // idDps -> { chave, xml }
    recebidas: [],
    atrasoConsultaDps: 0,
  };
  let seq = 0;
  const { key, cert } = certServidor(caPem, caChavePem);

  function gerarNfse(idDps, dpsXml) {
    seq += 1;
    const chave = `${idDps.slice(3, 10)}2${idDps.slice(10, 25)}${String(seq).padStart(13, '0')}2609${String(seq).padStart(9, '0')}1`.slice(0, 50).padEnd(50, '0');
    const dps = dpsXml.replace(/^<\?xml[^>]*>/, '');
    const xml = `<?xml version="1.0" encoding="UTF-8"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${chave}">`
      + `<xLocEmi>Simulado</xLocEmi><xLocPrestacao>Simulado</xLocPrestacao><nNFSe>${seq}</nNFSe><xTribNac>Simulado</xTribNac><verAplic>SIMULADOR</verAplic>`
      + `<ambGer>2</ambGer><tpEmis>1</tpEmis><cStat>107</cStat><dhProc>2026-09-25T10:00:00-03:00</dhProc><nDFSe>${seq}</nDFSe>`
      + `<valores><vLiq>${tag(dpsXml, 'vServ')}</vLiq></valores>${dps}</infNFSe></NFSe>`;
    estado.geradas.set(idDps, { chave, xml });
    return { chave, xml };
  }

  function regras(xml) {
    const erros = [];
    if (/<pAliq>/.test(xml)) erros.push({ Codigo: 'E0600', Descricao: 'Não é permitido informar a alíquota para prestador de serviço optante do simples nacional do tipo MEI.' });
    const dCompet = tag(xml, 'dCompet');
    const dhEmi = tag(xml, 'dhEmi');
    if (dCompet && dhEmi && dCompet > dhEmi.slice(0, 10)) erros.push({ Codigo: 'E0015', Descricao: 'A data de competência informada na DPS não pode ser posterior à data de emissão (dhEmi) da DPS.' });
    if (/SIMULAR-REJEICAO/.test(xml)) erros.push({ Codigo: 'E0082', Descricao: 'CNPJ do emitente prestador não encontrado no cadastro CNPJ na data de competência.' });
    return erros;
  }

  const responder = (res, status, corpo) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(corpo === undefined ? '' : JSON.stringify(corpo));
  };

  const servidor = https.createServer({ key, cert, ca: caPem, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', async () => {
      const url = new URL(req.url, 'https://localhost');
      const caminho = url.pathname.replace(/^\/SefinNacional/, '');
      if (req.method === 'POST' && caminho === '/nfse') {
        const corpo = JSON.parse(Buffer.concat(partes).toString('utf8'));
        const xml = gunzipSync(Buffer.from(corpo.dpsXmlGZipB64, 'base64')).toString('utf8');
        estado.recebidas.push(xml);
        const idDps = xml.match(/Id="(DPS\d+[0-9A-Z]*)"/)?.[1];
        const cenario = estado.cenario.shift() || 'ok';
        const base = { tipoAmbiente: 2, versaoAplicativo: 'SIMULADOR', dataHoraProcessamento: new Date().toISOString(), idDPS: idDps };
        if (cenario === 'timeout_sem_processar') return; // nunca responde
        if (cenario === 'erro500') return responder(res, 500, { mensagem: 'erro interno' });
        if (!conferirAssinatura(xml, certClientePem)) return responder(res, 400, { ...base, erros: [{ Codigo: 'E0714', Descricao: 'Arquivo enviado com erro na assinatura.' }] });
        const xsd = await validarXsd(xml);
        if (!xsd.valido) return responder(res, 400, { ...base, erros: [{ Codigo: 'E1235', Descricao: 'Falha no esquema XML do DF-e.', Complemento: xsd.erros[0] }] });
        if (estado.geradas.has(idDps)) return responder(res, 400, { ...base, erros: [{ Codigo: 'E0014', Descricao: 'Conjunto de Série, Número, Código do Município Emissor e CNPJ/CPF informado nesta DPS já existe em uma NFS-e gerada a partir de uma DPS enviada anteriormente.' }] });
        const erros = cenario === 'rejeitar' ? [{ Codigo: 'E0082', Descricao: 'CNPJ do emitente prestador não encontrado no cadastro CNPJ na data de competência.' }] : regras(xml);
        if (erros.length) return responder(res, 400, { ...base, erros });
        const { chave, xml: nfse } = gerarNfse(idDps, xml);
        if (cenario === 'timeout_apos_processar') return; // processou, mas a resposta "se perdeu"
        return responder(res, 201, { ...base, chaveAcesso: chave, nfseXmlGZipB64: gzipSync(Buffer.from(nfse)).toString('base64'), alertas: [] });
      }
      const mDps = caminho.match(/^\/dps\/(.+)$/);
      if (req.method === 'GET' && mDps) {
        const g = estado.geradas.get(decodeURIComponent(mDps[1]));
        return g ? responder(res, 200, { tipoAmbiente: 2, idDps: mDps[1], chaveAcesso: g.chave }) : responder(res, 404, { erro: { codigo: 'E404', descricao: 'Não encontrado' } });
      }
      const mNfse = caminho.match(/^\/nfse\/(\d{50})$/);
      if (req.method === 'GET' && mNfse) {
        const g = [...estado.geradas.values()].find((x) => x.chave === mNfse[1]);
        return g ? responder(res, 200, { chaveAcesso: g.chave, nfseXmlGZipB64: gzipSync(Buffer.from(g.xml)).toString('base64') }) : responder(res, 404, {});
      }
      responder(res, 404, {});
    });
  });

  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;
  return {
    estado,
    baseUrl: `https://127.0.0.1:${porta}/SefinNacional`,
    ca: caPem,
    fechar: () => new Promise((r) => { servidor.closeAllConnections(); servidor.close(r); }),
  };
}
