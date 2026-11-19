// Normalização da entrada do usuário (o que vier do app nunca é confiável).
import { lerDocumento, somenteDigitos } from './documentos.js';
import { invalido } from './erros.js';

const texto = (v, max) => (v === undefined || v === null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, max));

export function valorDecimal(v) {
  if (v === undefined || v === null || v === '') return '';
  let s = String(v).trim().replace(/[R$\s]/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n.toFixed(2) : '';
}

export function endereco(e) {
  if (!e || typeof e !== 'object') return null;
  const r = {
    cep: somenteDigitos(e.cep).slice(0, 8),
    municipioIbge: somenteDigitos(e.municipioIbge).slice(0, 7),
    logradouro: texto(e.logradouro, 255),
    numero: texto(e.numero, 60),
    complemento: texto(e.complemento, 156),
    bairro: texto(e.bairro, 60),
  };
  return Object.values(r).some(Boolean) ? r : null;
}

// Dados da obra (grupo serv/obra da DPS): endereço no Brasil, CIB ou CNO/CEI, e a inscrição imobiliária (opcional).
export const TIPOS_OBRA = ['endereco', 'cib', 'cno'];
export function obra(o) {
  if (!o || typeof o !== 'object' || !TIPOS_OBRA.includes(o.tipo)) return null;
  return {
    tipo: o.tipo,
    inscImobFisc: texto(o.inscImobFisc, 30) || null,
    cib: o.tipo === 'cib' ? String(o.cib ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8) : null,
    cno: o.tipo === 'cno' ? somenteDigitos(o.cno).slice(0, 12) : null,
    endereco: o.tipo === 'endereco' ? endereco(o.endereco) || {} : null,
  };
}

// NFS-e que esta nota substitui (grupo subst da DPS). A chave é conferida no servidor antes de emitir.
export const MOTIVOS_SUBSTITUICAO = {
  '01': 'Desenquadramento do Simples Nacional', '02': 'Enquadramento no Simples Nacional', '03': 'Inclusão retroativa de imunidade/isenção',
  '04': 'Exclusão retroativa de imunidade/isenção', '05': 'Rejeição da NFS-e pelo tomador ou intermediário', '99': 'Outros',
};
export function substituicao(x) {
  if (!x || typeof x !== 'object' || !/^\d{50}$/.test(String(x.chave || ''))) return null;
  return {
    notaId: /^[0-9a-f-]{36}$/i.test(String(x.notaId || '')) ? String(x.notaId) : null,
    chave: String(x.chave),
    nNfse: texto(x.nNfse, 15) || null,
    cMotivo: MOTIVOS_SUBSTITUICAO[x.cMotivo] ? x.cMotivo : '99',
    xMotivo: texto(x.xMotivo, 255) || null,
  };
}

export function cliente(b) {
  const doc = lerDocumento(b.documento);
  const erros = {};
  if (!doc) erros.documento = 'CPF ou CNPJ inválido. Confira os números.';
  const nome = texto(b.nome, 300);
  if (!nome) erros.nome = 'Informe o nome ou razão social.';
  const email = texto(b.email, 80).toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) erros.email = 'E-mail inválido.';
  const fone = somenteDigitos(b.fone).slice(0, 20);
  if (fone && fone.length < 6) erros.fone = 'Telefone incompleto (use DDD + número).';
  const end = endereco(b.endereco);
  if (doc?.tipo === 'CNPJ' && !(end && end.cep.length === 8 && end.municipioIbge.length === 7 && end.logradouro && end.numero && end.bairro)) {
    erros.endereco = 'Para CNPJ, o endereço completo é obrigatório na nota (regra E0235).';
  } else if (end && !(end.cep.length === 8 && end.municipioIbge.length === 7 && end.logradouro && end.numero && end.bairro)) {
    erros.endereco = 'Complete o endereço (CEP, cidade, rua, número e bairro) ou deixe em branco.';
  }
  if (Object.keys(erros).length) throw invalido('Confira os dados do cliente.', erros);
  return { tipo: doc.tipo, documento: doc.numero, nome, email: email || null, fone: fone || null, endereco: end, inscricaoMunicipal: texto(b.inscricaoMunicipal, 15) || null };
}

// Percentual informado pelo usuário ("2,5" → "2.50"); null se vazio/inválido.
function percentualTexto(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).trim().replace('%', '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n < 100 ? n.toFixed(2) : null;
}

const REVISAVEIS = ['competencia', 'valor', 'descricao', 'tributacao'];

export function rascunho(b = {}) {
  const t = b.tomador && typeof b.tomador === 'object' ? b.tomador : null;
  return {
    clienteId: b.clienteId ? String(b.clienteId).slice(0, 64) : null,
    tomador: t ? {
      tipo: ['CPF', 'CNPJ', 'NENHUM'].includes(t.tipo) ? t.tipo : 'NENHUM',
      documento: t.tipo === 'CNPJ' ? String(t.documento || '').toUpperCase().replace(/[^0-9A-Z]/g, '') : somenteDigitos(t.documento),
      nome: texto(t.nome, 300),
      email: texto(t.email, 80) || null,
      fone: somenteDigitos(t.fone) || null,
      endereco: endereco(t.endereco),
      inscricaoMunicipal: texto(t.inscricaoMunicipal, 15) || null,
    } : null,
    servicoId: b.servicoId ? String(b.servicoId).slice(0, 64) : null,
    cTribNac: somenteDigitos(b.cTribNac).slice(0, 6),
    cTribMun: somenteDigitos(b.cTribMun).slice(0, 3) || null,
    cNBS: somenteDigitos(b.cNBS).slice(0, 9) || null,
    descricao: String(b.descricao ?? '').replace(/\r\n/g, '\n').trim().slice(0, 2000),
    competencia: /^\d{4}-\d{2}-\d{2}$/.test(b.competencia || '') ? b.competencia : '',
    valor: valorDecimal(b.valor),
    localPrestacaoIbge: somenteDigitos(b.localPrestacaoIbge).slice(0, 7) || null,
    obra: obra(b.obra),
    substituicao: substituicao(b.substituicao),
    // Tributação (ME/EPP). Vazio = usa o valor do perfil.
    issRetido: b.issRetido === true,
    pAliq: percentualTexto(b.pAliq),
    pTotTribSN: percentualTexto(b.pTotTribSN),
    // Lucro Presumido/Real: retenções federais (valores em R$) e classificação IBS/CBS.
    retencoesFederais: b.retencoesFederais && typeof b.retencoesFederais === 'object' ? {
      pis: b.retencoesFederais.pis === true,
      cofins: b.retencoesFederais.cofins === true,
      csll: b.retencoesFederais.csll === true,
      valorContribuicoes: valorDecimal(b.retencoesFederais.valorContribuicoes) || null,
      irrf: valorDecimal(b.retencoesFederais.irrf) || null,
      cp: valorDecimal(b.retencoesFederais.cp) || null,
    } : null,
    cIndOp: /^\d{6}$/.test(b.cIndOp || '') ? b.cIndOp : null,
    cClassTrib: /^\d{6}$/.test(b.cClassTrib || '') ? b.cClassTrib : null,
    indFinal: b.indFinal === '0' || b.indFinal === '1' ? b.indFinal : null,
    revisar: Array.isArray(b.revisar) ? b.revisar.filter((x) => REVISAVEIS.includes(x)) : [],
  };
}
