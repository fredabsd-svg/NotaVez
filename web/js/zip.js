// ZIP montado no próprio aparelho, sem biblioteca: CRC-32, cabeçalhos locais e diretório central
// (PKWARE APPNOTE 6.3). XML e texto vão comprimidos com o "deflate-raw" nativo do navegador, quando
// existe; PDF (já comprimido) e navegadores sem CompressionStream vão guardados sem compressão.
// Nomes em UTF-8 (bit 11), datas no horário local. Limites do formato clássico: 65.535 arquivos e 4 GB.

const TABELA = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = TABELA[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const fluxo = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(fluxo).arrayBuffer());
  } catch { return null; }
}

function dataDos(d) {
  const ano = Math.max(1980, d.getFullYear());
  return {
    hora: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    data: ((ano - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const utf8 = new TextEncoder();

export function criarZip() {
  const partes = [];
  const central = [];
  const nomes = new Set();
  let deslocamento = 0;
  let arquivos = 0;

  // Mesmo nome duas vezes vira "arquivo (2).xml" em vez de sobrescrever.
  function nomeLivre(nome) {
    let n = String(nome).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!nomes.has(n)) { nomes.add(n); return n; }
    const m = /^(.*?)(\.[^./]+)?$/.exec(n);
    for (let i = 2; ; i++) {
      const outro = `${m[1]} (${i})${m[2] || ''}`;
      if (!nomes.has(outro)) { nomes.add(outro); return outro; }
    }
  }

  return {
    get quantidade() { return arquivos; },
    // dados: Uint8Array, ArrayBuffer ou texto. comprimir = false para PDF, imagens e outros já comprimidos.
    async adicionar(nome, dados, { comprimir = true, data = new Date() } = {}) {
      const bruto = typeof dados === 'string' ? utf8.encode(dados) : dados instanceof Uint8Array ? dados : new Uint8Array(dados);
      const crc = crc32(bruto);
      let corpo = bruto;
      let metodo = 0;
      if (comprimir && bruto.length > 64) {
        const d = await deflateRaw(bruto);
        if (d && d.length < bruto.length) { corpo = d; metodo = 8; }
      }
      // Daqui para baixo é síncrono: adições simultâneas não se misturam.
      const nomeBytes = utf8.encode(nomeLivre(nome));
      const { hora, data: dia } = dataDos(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);
      local.setUint16(8, metodo, true);
      local.setUint16(10, hora, true);
      local.setUint16(12, dia, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, corpo.length, true);
      local.setUint32(22, bruto.length, true);
      local.setUint16(26, nomeBytes.length, true);
      local.setUint16(28, 0, true);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, metodo, true);
      c.setUint16(12, hora, true);
      c.setUint16(14, dia, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, corpo.length, true);
      c.setUint32(24, bruto.length, true);
      c.setUint16(28, nomeBytes.length, true);
      c.setUint32(42, deslocamento, true);
      partes.push(new Uint8Array(local.buffer), nomeBytes, corpo);
      central.push(new Uint8Array(c.buffer), nomeBytes);
      deslocamento += 30 + nomeBytes.length + corpo.length;
      arquivos += 1;
    },
    gerar() {
      const tamanhoCentral = central.reduce((s, b) => s + b.length, 0);
      const fim = new DataView(new ArrayBuffer(22));
      fim.setUint32(0, 0x06054b50, true);
      fim.setUint16(8, arquivos, true);
      fim.setUint16(10, arquivos, true);
      fim.setUint32(12, tamanhoCentral, true);
      fim.setUint32(16, deslocamento, true);
      return new Blob([...partes, ...central, new Uint8Array(fim.buffer)], { type: 'application/zip' });
    },
  };
}
