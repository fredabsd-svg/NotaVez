// Pacote de regras: prestador MEI (opSimpNac = 2), competências até 31/12/2026.
// Cada verificação cita a regra oficial do ANEXO_I-SEFIN_ADN-DPS_NFSe-SNNFSe
// v1.01 (aba "RN DPS_NFS-e") que ela antecipa. O objetivo é barrar aqui o que
// a Sefin Nacional rejeitaria, com uma explicação em linguagem comum.
import { municipio, servicoNacional } from '../tabelas.js';
import { cnpjValido, cpfValido } from '../../util/documentos.js';

export const pacote = {
  id: 'MEI-2026',
  descricao: 'MEI — regras do leiaute DPS v1.01 (sem grupos IBS/CBS, obrigatórios para o Simples só a partir de 2027)',
  aplica: ({ opSimpNac, competencia }) => opSimpNac === '2' && competencia >= '2023-09-01' && competencia <= '2026-12-31',

  // Tributação fixa do MEI: sem alíquota (E0600), sem retenção (E0583),
  // sem tributos federais (E0676), sem pTotTribSN (E0710) → indTotTrib = 0.
  tributacao: () => ({ tribISSQN: '1', tpRetISSQN: '1', totTrib: { indTotTrib: '0' } }),
  regTrib: () => ({ opSimpNac: '2', regEspTrib: '0' }), // E0174: MEI → regEspTrib = 0; E0162: sem regApTribSN

  validar({ prestador, nota, hoje }) {
    const e = [];
    const add = (campo, mensagem, regra) => e.push({ campo, mensagem, regra });

    if (prestador.tipoDocumento !== 'CNPJ' || !cnpjValido(prestador.documento)) add('perfil.cnpj', 'O CNPJ do seu MEI está inválido no perfil.', 'E0080');
    if (!municipio(prestador.municipioIbge)) add('perfil.municipio', 'Informe no perfil o município do seu CNPJ.', 'E0041');

    // Competência (E0015: não pode ser futura; E1294: no máximo 6 anos).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nota.competencia || '')) add('competencia', 'Informe a data da competência (quando o serviço foi prestado).', 'XSD');
    else if (nota.competencia > hoje) add('competencia', 'A competência não pode ser uma data futura.', 'E0015');

    // Valor (TSDec15V2) — maior que zero.
    const v = Number(nota.valor);
    if (!Number.isFinite(v) || v <= 0) add('valor', 'Informe o valor do serviço.', 'XSD');
    else if (v >= 1e15) add('valor', 'Valor acima do limite do leiaute.', 'XSD');

    // Serviço (E0310) e grupos específicos ainda não suportados.
    const s = servicoNacional(nota.cTribNac);
    if (!s) add('servico', 'Escolha um código de serviço da lista nacional.', 'E0310');
    else {
      if (s.grupoExigido === 'obra') add('servico', 'Este serviço exige os dados da obra (CNO/CEI), ainda não disponíveis no NotaVez. Use o Emissor Nacional para ele.', 'Anexo I');
      if (s.grupoExigido === 'atvEvento') add('servico', 'Este serviço exige os dados do evento, ainda não disponíveis no NotaVez. Use o Emissor Nacional para ele.', 'Anexo I');
      if (!s.incidencia || s.incidencia === 'OUTRO') add('servico', 'Este serviço tem regra de local especial não suportada nesta versão.', 'Anexo I');
    }
    if (nota.cTribMun && !/^\d{3}$/.test(nota.cTribMun)) add('cTribMun', 'O código municipal deve ter 3 dígitos.', 'XSD');
    if (nota.cNBS && !/^\d{9}$/.test(nota.cNBS)) add('cNBS', 'O código NBS deve ter 9 dígitos.', 'E0316');

    const desc = (nota.descricao || '').trim();
    if (!desc) add('descricao', 'Descreva o serviço prestado.', 'XSD');
    else if (desc.length > 1000) add('descricao', `A descrição pode ter até 1.000 caracteres (tem ${desc.length}).`, 'Leiaute');

    // Local da prestação (E0302).
    if (nota.localPrestacaoIbge && !municipio(nota.localPrestacaoIbge)) add('localPrestacao', 'Município do local da prestação inválido.', 'E0302');

    // Tomador (cliente).
    const t = nota.tomador;
    if (t && t.tipo && t.tipo !== 'NENHUM') {
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
  },
};

const temAlgumCampo = (en) => ['cep', 'municipioIbge', 'logradouro', 'numero', 'bairro', 'complemento'].some((k) => (en?.[k] || '').trim?.());
export const enderecoCompleto = (en) => !!en && /^\d{8}$/.test(en.cep || '') && /^\d{7}$/.test(en.municipioIbge || '')
  && !!(en.logradouro || '').trim() && !!(en.numero || '').trim() && !!(en.bairro || '').trim();
