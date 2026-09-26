// Validações comuns a todos os regimes (cliente, serviço, datas, valores) e
// utilitários de tributação. Cada verificação cita a regra oficial do
// ANEXO_I-SEFIN_ADN-DPS_NFSe v1.01 que ela antecipa.
import { municipio, servicoNacional } from '../tabelas.js';
import { cnpjValido, cpfValido } from '../../util/documentos.js';

const temAlgumCampo = (en) => ['cep', 'municipioIbge', 'logradouro', 'numero', 'bairro', 'complemento'].some((k) => (en?.[k] || '').trim?.());
export const enderecoCompleto = (en) => !!en && /^\d{8}$/.test(en.cep || '') && /^\d{7}$/.test(en.municipioIbge || '')
  && !!(en.logradouro || '').trim() && !!(en.numero || '').trim() && !!(en.bairro || '').trim();

export const tomadorIdentificado = (t) => !!t && !!t.tipo && t.tipo !== 'NENHUM';

// Município onde o ISS é devido, pela regra de incidência do serviço (Anexo I, MUN.INCID_INFO.SERV.).
export function municipioIncidencia(prestador, nota) {
  const s = servicoNacional(nota.cTribNac);
  if (!s) return null;
  if (s.incidencia === 'EP') return prestador.municipioIbge;
  if (s.incidencia === 'LP') return nota.localPrestacaoIbge || prestador.municipioIbge;
  if (s.incidencia === 'ET') return nota.tomador?.endereco?.municipioIbge || null;
  return null;
}

// Converte "2,5" / "2.5" em número; null se vazio ou inválido.
export function percentual(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function validarComum({ prestador, nota, hoje }) {
  const e = [];
  const add = (campo, mensagem, regra) => e.push({ campo, mensagem, regra });

  if (prestador.tipoDocumento !== 'CNPJ' || !cnpjValido(prestador.documento)) add('perfil.cnpj', 'O CNPJ do perfil está inválido.', 'E0080');
  if (!municipio(prestador.municipioIbge)) add('perfil.municipio', 'Informe no perfil o município do seu CNPJ.', 'E0084');

  // Competência (E0015: não pode ser futura).
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nota.competencia || '')) add('competencia', 'Informe a data da competência (quando o serviço foi prestado).', 'XSD');
  else if (nota.competencia > hoje) add('competencia', 'A competência não pode ser uma data futura.', 'E0015');

  const v = Number(nota.valor);
  if (!Number.isFinite(v) || v <= 0) add('valor', 'Informe o valor do serviço.', 'XSD');
  else if (v >= 1e15) add('valor', 'Valor acima do limite do leiaute.', 'XSD');

  // Serviço (E0310) e grupos específicos ainda não suportados.
  const s = servicoNacional(nota.cTribNac);
  if (!s) add('servico', 'Escolha um código de serviço da lista nacional.', 'E0310');
  else {
    if (s.grupoExigido === 'obra') add('servico', 'Este serviço exige os dados da obra (CNO/CEI), ainda não disponíveis no Nota Sem Stress. Use o Emissor Nacional para ele.', 'Anexo I');
    if (s.grupoExigido === 'atvEvento') add('servico', 'Este serviço exige os dados do evento, ainda não disponíveis no Nota Sem Stress. Use o Emissor Nacional para ele.', 'Anexo I');
    if (!s.incidencia || s.incidencia === 'OUTRO') add('servico', 'Este serviço tem regra de local especial não suportada nesta versão.', 'Anexo I');
  }
  if (nota.cTribMun && !/^\d{3}$/.test(nota.cTribMun)) add('cTribMun', 'O código municipal deve ter 3 dígitos.', 'XSD');
  if (nota.cNBS && !/^\d{9}$/.test(nota.cNBS)) add('cNBS', 'O código NBS deve ter 9 dígitos.', 'E0316');

  const desc = (nota.descricao || '').trim();
  if (!desc) add('descricao', 'Descreva o serviço prestado.', 'XSD');
  else if (desc.length > 1000) add('descricao', `A descrição pode ter até 1.000 caracteres (tem ${desc.length}).`, 'Leiaute');

  if (nota.localPrestacaoIbge && !municipio(nota.localPrestacaoIbge)) add('localPrestacao', 'Município do local da prestação inválido.', 'E0302');

  const t = nota.tomador;
  if (tomadorIdentificado(t)) {
    if (t.tipo === 'CNPJ' && !cnpjValido(t.documento)) add('tomador.documento', 'O CNPJ do cliente está inválido.', 'E0188');
    if (t.tipo === 'CPF' && !cpfValido(t.documento)) add('tomador.documento', 'O CPF do cliente está inválido.', 'E0206');
    if (!t.nome || !t.nome.trim()) add('tomador.nome', 'Informe o nome do cliente.', 'XSD');
    if (t.nome && t.nome.length > 300) add('tomador.nome', 'Nome do cliente muito longo (máx. 300).', 'XSD');
    if (t.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t.email)) add('tomador.email', 'O e-mail do cliente parece inválido.', 'E0247');
    if (t.email && t.email.length > 80) add('tomador.email', 'E-mail do cliente muito longo (máx. 80).', 'XSD');
    if (t.fone && !/^\d{6,20}$/.test(t.fone)) add('tomador.fone', 'Telefone do cliente: use DDD + número, só dígitos.', 'XSD');
    const precisaEndereco = t.tipo === 'CNPJ' || s?.incidencia === 'ET';
    if (precisaEndereco && !enderecoCompleto(t.endereco)) {
      add('tomador.endereco', t.tipo === 'CNPJ'
        ? 'Para cliente com CNPJ, o endereço completo é obrigatório.'
        : 'Para este serviço, o endereço do cliente é obrigatório.', t.tipo === 'CNPJ' ? 'E0235' : 'Anexo I');
    }
    if (t.endereco && temAlgumCampo(t.endereco)) {
      if (!enderecoCompleto(t.endereco)) add('tomador.endereco', 'Complete o endereço do cliente (CEP, município, rua, número e bairro) ou deixe todos em branco.', 'XSD');
      else if (!municipio(t.endereco.municipioIbge)) add('tomador.endereco', 'Município do endereço do cliente inválido.', 'E0238');
    }
    if (prestador.tipoDocumento === 'CNPJ' && t.tipo === 'CNPJ' && t.documento === prestador.documento) {
      add('tomador.documento', 'O cliente não pode ser o seu próprio CNPJ.', 'E0202');
    }
  } else if (s?.incidencia === 'ET') {
    add('tomador', 'Este serviço exige identificar o cliente com endereço.', 'Anexo I');
  }
  return e;
}

// Fora do MEI, o município emissor precisa ser conveniado e usar os emissores nacionais (E0037–E0039).
export function validarConvenioEmissor(e, parametros) {
  const ce = parametros?.convenioEmissor;
  if (ce?.situacao === 'inexistente') e.push({ campo: 'perfil.municipio', mensagem: 'O município do seu CNPJ não é conveniado ao Sistema Nacional da NFS-e: a nota deve ser emitida no sistema da prefeitura.', regra: 'E0037' });
  else if (ce?.situacao === 'ativo' && ce.aderenteEmissorNacional === false) e.push({ campo: 'perfil.municipio', mensagem: 'O município do seu CNPJ não liberou os emissores nacionais: a nota deve ser emitida no sistema da prefeitura.', regra: 'E0039' });
}

// Arredondamento bancário (half-even), adotado pela NT 007 para vPis/vCofins.
export function arredondarBancario(v) {
  const x = Math.round(Number(v) * 1e6) / 1e6 * 100;
  const piso = Math.floor(x);
  const dif = x - piso;
  const r = Math.abs(dif - 0.5) < 1e-6 ? (piso % 2 === 0 ? piso : piso + 1) : Math.round(x);
  return r / 100;
}
