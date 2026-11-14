// System prompt do assistente de IA. Duas partes:
//  - FIXA (igual para todos, vai em cache): papel, regras do produto, fluxo de emissão e o
//    conhecimento de contabilidade fiscal e de NFS-e;
//  - VARIÁVEL (montada a cada mensagem): data, modo de emissão e os parâmetros da conta e da
//    empresa aberta, lidos do próprio emissor.
import { hojeBrasilia } from '../fiscal/dps.js';
import { municipio, versoesTabelas } from '../fiscal/tabelas.js';
import { escolherPacote, pacotes } from '../fiscal/regras/index.js';
import { formatarDocumento } from '../util/documentos.js';
import { regimeDescricao, elegibilidadeDe, painelDe, certPublico, situacaoReceita } from '../routes/perfil.js';
import { config } from '../config.js';

export { SISTEMA_FIXO } from './conhecimento.js';

const pct = (v) => (v === null || v === undefined || v === '' ? 'não informado' : `${String(v).replace('.', ',')}%`);
const nomeMunicipio = (ibge) => { const m = municipio(ibge); return m ? `${m.nome}/${m.uf} (IBGE ${ibge})` : 'não informado'; };
const REG_AP = { 1: 'federais e ISS pelo Simples (DAS)', 2: 'federais pelo Simples, ISS fora', 3: 'federais e ISS fora do Simples' };
const CST = { '01': 'tributável com alíquota básica', '06': 'alíquota zero', '08': 'sem incidência', '09': 'suspensão' };

// Parâmetros fiscais da empresa em texto (o mesmo que a tela "Dados da empresa" mostra).
function parametrosEmpresa(p) {
  const l = [
    `- Id interno: ${p.id}`,
    `- Razão social: ${p.nome || '(não informada)'} — CNPJ ${formatarDocumento(p.tipoDocumento, p.documento)}`,
    `- Município do estabelecimento: ${nomeMunicipio(p.municipioIbge)}${p.inscricaoMunicipal ? ` — inscrição municipal ${p.inscricaoMunicipal}` : ''}`,
    `- Regime: ${regimeDescricao(p)} (opSimpNac ${p.opSimpNac || '?'})`,
  ];
  if (p.opSimpNac === '3') {
    l.push(`- Simples — regime de apuração (regApTribSN): ${p.regApTribSN ? `${p.regApTribSN} = ${REG_AP[p.regApTribSN]}` : 'não informado'}`);
    l.push(`- Simples — % aproximado de tributos padrão (pTotTribSN): ${pct(p.pTotTribSN)}; alíquota do ISS para retenção: ${pct(p.aliqIssSN)}`);
  }
  if (p.opSimpNac === '1') {
    l.push(`- Apuração: ${p.apuracao === 'real' ? 'Lucro Real' : 'Lucro Presumido'}; PIS/COFINS CST ${p.cstPisCofins || '?'} (${CST[p.cstPisCofins] || 'não informado'}), PIS ${pct(p.aliqPis)}, COFINS ${pct(p.aliqCofins)}`);
    l.push(`- % aproximados (Lei 12.741): federal ${pct(p.pTotTribFed)}, estadual ${pct(p.pTotTribEst)}, municipal ${pct(p.pTotTribMun)}; alíquota do ISS (município sem convênio): ${pct(p.aliqIss)}`);
  }
  l.push(`- Série da DPS: ${p.serieDps || '1'}; ambiente: ${p.ambiente === 'producao' ? 'PRODUÇÃO (notas reais)' : 'testes / produção restrita (notas sem validade jurídica)'}`);
  l.push(`- Assinatura: ${p.usaProcuracao ? 'por procuração eletrônica, com o certificado do escritório' : 'certificado A1 da própria empresa'}`);
  return l;
}

export async function montarContexto({ ctx, usuario, empresa, emissaoAutonoma, pendentes = [], ia = null }) {
  const { repo, emissao } = ctx;
  const hoje = hojeBrasilia();
  const l = ['# CONTEXTO DO EMISSOR (lido agora do aplicativo)'];
  const hora = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const diaSemana = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long' });
  l.push(`- Agora (Brasília): ${diaSemana}, ${hoje.split('-').reverse().join('/')} às ${hora} (${hoje})`);
  if (ia) l.push(`- Modelo em uso: ${ia.modelo}, do provedor ${ia.provedorNome} (escolhido nas configurações do assistente desta conta)`);
  try {
    const t = await ctx.auth?.titular?.(usuario.id);
    if (t) l.push(`- Usuário: ${t.nome || '(nome não informado)'}${t.email ? ` — e-mail ${t.email}` : ''}${t.documentoFormatado ? ` — acesso pelo ${t.tipoDocumento} ${t.documentoFormatado}` : ''}`);
  } catch { /* sem dados do titular: segue */ }
  l.push('- Recursos do chat: o usuário pode anexar Excel/CSV, PDF, Word, XML e texto (botão de clipe, arrastar e soltar ou colar) e ditar pelo microfone.');
  if (config.demo) l.push('- SERVIDOR DE DEMONSTRAÇÃO: a Receita é simulada; nenhuma nota é real.');
  l.push(`- Modo de emissão: ${emissaoAutonoma
    ? 'AUTÔNOMO — emitir_nota envia a nota direto à Receita. Emita só quando o usuário pediu e os dados estiverem completos e confirmados.'
    : 'COM CONFIRMAÇÃO — emitir_nota prepara a nota e o app mostra ao usuário o botão "Emitir agora"; a nota só sai quando ele tocar.'}`);
  l.push(`- Regras vigentes no app: ${pacotes.map((x) => x.id).join(', ')}; leiaute DPS v1.01; lista nacional de serviços: ${versoesTabelas?.anexoB || '?'}`);

  const empresas = await repo.listarPrestadores(usuario.id);
  l.push(`- Empresas na conta: ${empresas.length}${empresas.length > 1 ? ' (escritório: use listar_empresas para ver todas)' : ''}`);
  if (empresas.length > 1 && empresas.length <= 30) {
    for (const e of empresas) l.push(`  • ${e.nome || '(sem nome)'} — ${formatarDocumento(e.tipoDocumento, e.documento)} — ${regimeDescricao(e)} — id ${e.id}${e.id === empresa?.id ? ' (ABERTA)' : ''}`);
  }

  if (!empresa) {
    l.push('', '## Empresa aberta: nenhuma', 'Peça ao usuário que escolha uma empresa ou use empresaId nas ferramentas.');
  } else {
    l.push('', '## Empresa aberta no app', ...parametrosEmpresa(empresa));
    const cert = await repo.certificadoEmissao(empresa);
    const c = certPublico(cert);
    l.push(`- Certificado para emitir: ${c ? `${c.procurador ? 'do escritório (procurador)' : 'da empresa'}, titular ${c.titular || '?'}, válido até ${String(c.validoAte || '').slice(0, 10)}` : 'NENHUM'}`);
    try {
      const eleg = await elegibilidadeDe(emissao, empresa, cert);
      l.push(`- Pode emitir pelo app agora: ${eleg.podeEmitir ? 'sim' : 'NÃO'}`);
      for (const p of eleg.pendencias) l.push(`  • Falta: ${p.titulo} — ${p.comoResolver}`);
      for (const i of eleg.itens.filter((x) => x.aviso)) l.push(`  • Aviso: ${i.aviso}`);
    } catch { l.push('- Pode emitir: não foi possível conferir agora (use contexto_empresa).'); }
    const rec = await situacaoReceita(repo, empresa);
    if (rec.recusadaEm) l.push(`- A Receita recusou a última consulta em ${rec.recusadaEm.slice(0, 10)}: ${rec.recusaMotivo || ''}`);
    const { pacote } = escolherPacote({ opSimpNac: empresa.opSimpNac, competencia: hoje });
    if (pacote) l.push(`- Pacote de regras para hoje: ${pacote.id} — ${pacote.descricao}`);
    const pn = await painelDe(repo, empresa, hoje);
    const reais = (v) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    l.push(`- Emitido no mês ${pn.mes}: ${reais(pn.meses.at(-1)?.total || 0)} (${pn.meses.at(-1)?.qtd || 0} notas); no ano ${pn.ano.ano}: ${reais(pn.ano.total)} (${pn.ano.qtd} notas)`);
    if (pn.limiteAnual) l.push(`- Limite anual do MEI ${pn.limiteAnual.ano}: ${reais(pn.limiteAnual.valor)} — usado ${(Number(pn.ano.total) / Number(pn.limiteAnual.valor) * 100).toFixed(1).replace('.', ',')}% (só notas deste app)`);
    const porSit = await repo.contarNotasPorSituacao(empresa.id);
    l.push(`- Notas: ${Object.entries(porSit).map(([k, v]) => `${k} ${v}`).join(', ') || 'nenhuma'}`);
    const servicos = await repo.listarServicos(empresa.id);
    if (servicos.length) {
      l.push(`- Serviços salvos (${servicos.length}${servicos.length > 25 ? ', os 25 mais usados' : ''}):`);
      for (const s of servicos.slice(0, 25)) l.push(`  • "${s.apelido}" — código ${s.cTribNac} — ${String(s.descricao).slice(0, 90)}${s.valorPadrao ? ` — valor de costume R$ ${s.valorPadrao}` : ''} — id ${s.id}`);
    } else l.push('- Serviços salvos: nenhum');
    l.push(`- Clientes salvos: ${(await repo.listarClientes(empresa.id)).length} (use buscar_clientes)`);
  }
  if (pendentes.length) {
    l.push('', '## Notas aguardando o toque do usuário em "Emitir agora"');
    for (const x of pendentes) l.push(`- nota ${x.notaId} (empresa ${x.empresaId})`);
  }
  return l.join('\n');
}
