// Descrições dos códigos impressos no DANFSe (NT 008: "utilizar a descrição
// destas opções"). Textos do leiaute oficial (tiposSimples_v1.01.xsd).
export const tpEmit = { 1: 'Prestador', 2: 'Tomador', 3: 'Intermediário' };
export const cStat = { 100: 'NFS-e Gerada', 102: 'NFS-e de Decisão Judicial', 103: 'NFS-e Avulsa', 107: 'NFS-e MEI' };
export const finNFSe = { 0: 'NFS-e regular' };
export const ambGer = { 1: 'Prefeitura', 2: 'Sistema Nacional da NFS-e' };
export const tpAmb = { 1: 'Produção', 2: 'Homologação' };
export const opSimpNac = {
  1: 'Não Optante',
  2: 'Optante - Microempreendedor Individual (MEI)',
  3: 'Optante - Microempresa ou Empresa de Pequeno Porte (ME/EPP)',
};
export const regApTribSN = {
  1: 'Regime de apuração dos tributos federais e municipal pelo Simples Nacional',
  2: 'Regime de apuração dos tributos federais pelo SN e o ISSQN por fora do SN conforme respectiva legislação municipal do tributo',
  3: 'Regime de apuração dos tributos federais e municipal por fora do SN conforme respectivas legislações federal e municipal de cada tributo',
};
export const tribISSQN = { 1: 'Operação Tributável', 2: 'Imunidade', 3: 'Exportação de Serviço', 4: 'Não Incidência' };
export const regEspTrib = {
  0: 'Nenhum', 1: 'Ato Cooperado (Cooperativa)', 2: 'Estimativa', 3: 'Microempresa Municipal',
  4: 'Notário ou Registrador', 5: 'Profissional Autônomo', 6: 'Sociedade de Profissionais', 9: 'Outros',
};
export const tpImunidade = {
  0: 'Imunidade (tipo não informado na nota de origem)',
  1: 'Patrimônio, renda ou serviços, uns dos outros (CF88, Art 150, VI, a)',
  2: 'Templos de qualquer culto (CF88, Art 150, VI, b)',
  3: 'Patrimônio, renda ou serviços dos partidos políticos, entidades sindicais, instituições de educação e de assistência social (CF88, Art 150, VI, c)',
  4: 'Livros, jornais, periódicos e o papel destinado a sua impressão (CF88, Art 150, VI, d)',
  5: 'Fonogramas e videofonogramas musicais produzidos no Brasil (CF88, Art 150, VI, e)',
};
export const tpSusp = { 1: 'Exigibilidade Suspensa por Decisão Judicial', 2: 'Exigibilidade Suspensa por Processo Administrativo' };
export const tpBM = { 1: 'Isenção', 2: 'Redução da BC em %', 3: 'Redução da BC em R$', 4: 'Alíquota Diferenciada' };
export const tpRetISSQN = { 1: 'Não Retido', 2: 'Retido pelo Tomador', 3: 'Retido pelo Intermediário' };
export const tpRetPisCofins = {
  0: 'PIS/COFINS/CSLL Não Retidos', 1: 'PIS/COFINS Retidos', 2: 'PIS/COFINS Não Retidos',
  3: 'PIS/COFINS/CSLL Retidos', 4: 'PIS/COFINS Retidos, CSLL Não Retido', 5: 'PIS Retido, COFINS/CSLL Não Retido',
  6: 'COFINS Retido, PIS/CSLL Não Retido', 7: 'PIS Não Retido, COFINS/CSLL Retidos',
  8: 'PIS/COFINS Não Retidos, CSLL Retido', 9: 'COFINS Não Retido, PIS/CSLL Retidos',
};
export const naoNif = { 0: 'NIF não informado na nota de origem', 1: 'Dispensado do NIF', 2: 'Não exigência do NIF' };
