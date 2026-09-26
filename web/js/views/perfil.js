import { h, anexar, campo, mostrarErros, aviso, mascaraDocumento, data, buscaComSugestoes } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { buscarMunicipio, kvGravar } from '../store.js';
import { sair, estado, atualizarSelo } from '../app.js';

function checklist(eleg) {
  return h('ul', { class: 'check' }, eleg.itens.map((i) => h('li', {},
    h('span', { class: i.ok ? 'ok' : 'nao', 'aria-hidden': 'true' }, i.ok ? '✓' : '✕'),
    h('span', {}, h('span', { class: 'sr' }, i.ok ? 'Concluído: ' : 'Pendente: '), h('strong', {}, i.titulo),
      i.comoResolver ? h('span', { class: 'suave', style: 'display:block' }, i.comoResolver) : null,
      i.aviso ? h('span', { class: 'suave', style: 'display:block' }, i.aviso) : null))));
}

export async function tela() {
  const dados = await api('GET', '/api/perfil');
  const p = dados.perfil || {};
  const node = h('div');

  // ----- Perfil fiscal -----
  const cnpj = campo({ rotulo: 'CNPJ da empresa', valor: mascaraDocumento(p.documento || ''), atributos: { inputmode: 'text', autocapitalize: 'characters', autocomplete: 'off' }, oninput: (e) => { e.target.value = mascaraDocumento(e.target.value); } });
  const nome = campo({ rotulo: 'Nome ou razão social', ajuda: 'Só para exibição no app (a nota usa o nome do cadastro do CNPJ).', valor: p.nome || '', atributos: { maxlength: 300 } });
  let municipioIbge = p.municipioIbge || '';
  const municipio = buscaComSugestoes({
    rotulo: 'Município do seu CNPJ', ajuda: 'O mesmo do endereço do CNPJ na Receita.',
    valorInicial: p.municipio ? `${p.municipio.nome} - ${p.municipio.uf}` : '', placeholder: 'Digite a cidade',
    buscar: buscarMunicipio, formatar: (m) => `${m.nome} - ${m.uf}`,
    aoEscolher: (m, c) => { municipioIbge = m.ibge; c.entrada.value = `${m.nome} - ${m.uf}`; },
  });
  municipio.entrada.addEventListener('input', () => { municipioIbge = ''; });
  const regime = campo({
    rotulo: 'Regime tributário', valor: p.opSimpNac || '2',
    opcoes: [['2', 'MEI'], ['3', 'ME/EPP — Simples Nacional'], ['1', 'Lucro Presumido ou Lucro Real']],
  });
  // ----- Simples Nacional (ME/EPP) -----
  const regApTribSN = campo({
    rotulo: 'Como sua empresa paga os tributos', valor: p.regApTribSN || '1',
    ajuda: 'O normal é tudo pelo DAS. "ISS fora": a receita passou o sublimite estadual/municipal. "Tudo fora": passou o limite do Simples. Na dúvida, pergunte ao contador.',
    opcoes: [
      ['1', 'Tudo pelo Simples (DAS)'],
      ['2', 'ISS fora do Simples (sublimite)'],
      ['3', 'Tudo fora do Simples (limite)'],
    ],
  });
  const fmtPct = (v) => (v ? Number(v).toFixed(2).replace('.', ',') : '');
  const pTotTribSN = campo({
    rotulo: 'Percentual aproximado de tributos (%)', valor: fmtPct(p.pTotTribSN),
    ajuda: 'Sua alíquota efetiva do Simples no mês (está no PGDAS-D). Vai na nota como total aproximado de tributos. Atualize todo mês.',
    atributos: { inputmode: 'decimal', placeholder: 'Ex.: 6,00' },
  });
  const aliqIssSN = campo({
    rotulo: 'Alíquota do ISS no Simples (%)', valor: fmtPct(p.aliqIssSN),
    ajuda: 'Usada só quando o cliente retém o ISS. Entre 1,8% e 5% (regras oficiais E0621 e E0595).',
    atributos: { inputmode: 'decimal', placeholder: 'Ex.: 2,00' },
  });
  const blocoSimples = h('fieldset', { class: 'cartao', style: 'margin:12px 0' },
    h('legend', { class: 'rotulo', style: 'margin:0' }, 'Simples Nacional'), regApTribSN, pTotTribSN, aliqIssSN);
  // ----- Lucro Presumido / Real -----
  const apuracao = campo({ rotulo: 'Forma de tributação do IRPJ', valor: p.apuracao || 'presumido', opcoes: [['presumido', 'Lucro Presumido'], ['real', 'Lucro Real']] });
  const cstPisCofins = campo({
    rotulo: 'Situação do PIS/COFINS nos seus serviços', valor: p.cstPisCofins || '01',
    opcoes: [['01', '01 — Tributável (alíquota básica)'], ['06', '06 — Alíquota zero'], ['08', '08 — Sem incidência'], ['09', '09 — Suspensão']],
  });
  const aliqPis = campo({ rotulo: 'Alíquota do PIS (%)', valor: fmtPct(p.aliqPis), atributos: { inputmode: 'decimal', placeholder: 'Ex.: 0,65' } });
  const aliqCofins = campo({ rotulo: 'Alíquota da COFINS (%)', valor: fmtPct(p.aliqCofins), atributos: { inputmode: 'decimal', placeholder: 'Ex.: 3,00' } });
  const padroes = h('button', {
    class: 'btn btn-pequeno btn-texto', type: 'button',
    onclick: () => {
      const real = apuracao.entrada.value === 'real';
      aliqPis.entrada.value = real ? '1,65' : '0,65';
      aliqCofins.entrada.value = real ? '7,60' : '3,00';
    },
  }, 'Usar alíquotas padrão do regime');
  const avisoPadrao = h('p', { class: 'suave' }, 'Padrão: Presumido (cumulativo) PIS 0,65% e COFINS 3%; Real (não cumulativo) PIS 1,65% e COFINS 7,6%. Há exceções por atividade: confirme com seu contador.');
  const pTotFed = campo({ rotulo: 'Tributos federais aproximados (%)', valor: fmtPct(p.pTotTribFed), ajuda: 'Lei 12.741/2012 (ex.: tabela do IBPT para o seu serviço).', atributos: { inputmode: 'decimal', placeholder: 'Ex.: 13,45' } });
  const pTotMun = campo({ rotulo: 'Tributos municipais aproximados (%)', valor: fmtPct(p.pTotTribMun), ajuda: 'Em geral, a alíquota do ISS.', atributos: { inputmode: 'decimal', placeholder: 'Ex.: 5,00' } });
  const aliqIss = campo({
    rotulo: 'Alíquota do ISS (%)', valor: fmtPct(p.aliqIss),
    ajuda: 'Opcional. Só vai na nota quando o município onde o ISS é devido não é conveniado ao Sistema Nacional (regra E0619).',
    atributos: { inputmode: 'decimal', placeholder: 'Ex.: 5,00' },
  });
  const mostrarAliqPisCofins = () => { aliqPis.hidden = aliqCofins.hidden = padroes.hidden = avisoPadrao.hidden = cstPisCofins.entrada.value !== '01'; };
  cstPisCofins.entrada.addEventListener('change', mostrarAliqPisCofins);
  mostrarAliqPisCofins();
  const blocoFederais = h('fieldset', { class: 'cartao', style: 'margin:12px 0' },
    h('legend', { class: 'rotulo', style: 'margin:0' }, 'Lucro Presumido ou Real'),
    apuracao, cstPisCofins, aliqPis, aliqCofins, avisoPadrao, padroes, pTotFed, pTotMun, aliqIss);

  const mostrarSimples = () => {
    blocoSimples.hidden = regime.entrada.value !== '3';
    blocoFederais.hidden = regime.entrada.value !== '1';
  };
  regime.entrada.addEventListener('change', mostrarSimples);
  mostrarSimples();
  const email = campo({ rotulo: 'E-mail de contato', ajuda: 'Opcional. Vai na nota.', tipo: 'email', valor: p.email || '', atributos: { inputmode: 'email', maxlength: 80 } });
  const fone = campo({ rotulo: 'Telefone', ajuda: 'Opcional. DDD + número.', tipo: 'tel', valor: p.fone || '', atributos: { inputmode: 'tel' } });
  const im = campo({ rotulo: 'Inscrição municipal', ajuda: 'Informe só se a prefeitura tiver você no cadastro complementar (CNC). Se não tiver, deixe em branco: a Receita recusa IM sem cadastro (E0120).', valor: p.inscricaoMunicipal || '', atributos: { maxlength: 15 } });
  const serie = campo({ rotulo: 'Série da DPS', ajuda: 'Deixe 1, a menos que use outro sistema de emissão (faixa 1–49999).', valor: p.serieDps || '1', atributos: { inputmode: 'numeric', maxlength: 5 } });
  const ambiente = campo({
    rotulo: 'Ambiente da Receita', valor: p.ambiente || 'producao_restrita',
    opcoes: [['producao_restrita', 'Testes (produção restrita) — sem validade jurídica'], ...(dados.producaoLiberada ? [['producao', 'Produção — notas reais']] : [])],
  });
  const erroPerfil = h('p', { class: 'erro-campo', role: 'alert', hidden: true });
  const salvarPerfil = h('button', { class: 'btn btn-primario', type: 'submit' }, 'Salvar perfil');
  const formPerfil = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      salvarPerfil.disabled = true;
      erroPerfil.hidden = true;
      try {
        await api('PUT', '/api/perfil', {
          documento: cnpj.entrada.value, nome: nome.entrada.value, municipioIbge, opSimpNac: regime.entrada.value,
          email: email.entrada.value, fone: fone.entrada.value, inscricaoMunicipal: im.entrada.value, serieDps: serie.entrada.value, ambiente: ambiente.entrada.value,
          regApTribSN: regApTribSN.entrada.value, pTotTribSN: pTotTribSN.entrada.value, aliqIssSN: aliqIssSN.entrada.value,
          apuracao: apuracao.entrada.value, cstPisCofins: cstPisCofins.entrada.value, aliqPis: aliqPis.entrada.value, aliqCofins: aliqCofins.entrada.value,
          pTotTribFed: pTotFed.entrada.value, pTotTribMun: pTotMun.entrada.value, aliqIss: aliqIss.entrada.value,
        });
        aviso('Perfil salvo.');
        estado.inicio = await api('GET', '/api/inicio');
        await kvGravar('inicio', estado.inicio);
        atualizarSelo();
        location.reload();
      } catch (err) {
        if (err instanceof ErroApi && err.dados?.campos) mostrarErros({ documento: cnpj, municipioIbge: municipio, opSimpNac: regime, regApTribSN, pTotTribSN, aliqIssSN, cstPisCofins, aliqPis, aliqCofins, pTotTribFed: pTotFed, pTotTribMun: pTotMun, aliqIss, email, serieDps: serie, ambiente }, err.dados.campos);
        else { erroPerfil.textContent = err.message; erroPerfil.hidden = false; }
      } finally { salvarPerfil.disabled = false; }
    },
  }, cnpj, nome, municipio, regime, blocoSimples, blocoFederais, email, fone, h('details', {}, h('summary', {}, 'Opções avançadas'), im, serie, ambiente), erroPerfil, salvarPerfil);

  // ----- Certificado -----
  const cert = dados.certificado;
  const arquivo = campo({ rotulo: 'Arquivo do certificado A1', ajuda: 'Formato .pfx ou .p12 (e-CNPJ).', tipo: 'file', atributos: { accept: '.pfx,.p12,application/x-pkcs12' } });
  const senha = campo({ rotulo: 'Senha do certificado', tipo: 'password', atributos: { autocomplete: 'off' } });
  const consentimento = h('input', { type: 'checkbox', id: 'consentimento' });
  const erroCert = h('div', { class: 'erro-campo', role: 'alert', hidden: true });
  const enviar = h('button', { class: 'btn btn-primario', type: 'submit' }, cert ? 'Trocar certificado' : 'Enviar certificado');
  const formCert = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      erroCert.hidden = true;
      const f = arquivo.entrada.files?.[0];
      if (!f) { arquivo.erro('Escolha o arquivo do certificado.'); return; }
      if (!consentimento.checked) { erroCert.textContent = 'Marque a autorização para continuar.'; erroCert.hidden = false; return; }
      enviar.disabled = true;
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        await api('POST', '/api/certificado', { pfxBase64: btoa(bin), senha: senha.entrada.value, consentimento: true });
        senha.entrada.value = '';
        aviso('Certificado verificado e guardado com segurança.');
        location.reload();
      } catch (err) {
        erroCert.replaceChildren(err.message, ...(err.dados?.problemas || []).map((x) => h('span', { style: 'display:block' }, `• ${x}`)));
        erroCert.hidden = false;
      } finally { enviar.disabled = false; }
    },
  }, arquivo, senha,
  h('label', { class: 'caixa', for: 'consentimento' }, consentimento,
    h('span', {}, 'Autorizo o NotaVez a guardar meu certificado de forma criptografada e a usá-lo somente para assinar e transmitir as notas que eu mandar emitir, além de consultar a situação delas. Posso remover a qualquer momento.')),
  erroCert, enviar);

  const statusCert = cert
    ? h('div', { class: 'cartao cartao-ok' }, h('strong', {}, 'Certificado ativo'), h('p', {}, cert.titular), h('p', { class: 'suave' }, `Válido até ${data(cert.validoAte)} · ${cert.emissor}`),
      h('button', {
        class: 'btn btn-texto btn-perigo', type: 'button',
        onclick: async () => {
          if (!confirm('Remover o certificado? Você não poderá emitir até enviar outro.')) return;
          await api('DELETE', '/api/certificado');
          location.reload();
        },
      }, 'Remover certificado'))
    : null;

  anexar(node,
    h('section', { class: 'cartao' }, h('h2', { style: 'font-size:19px;margin-top:0' }, dados.elegibilidade.podeEmitir ? 'Tudo pronto para emitir' : 'O que falta para emitir'), checklist(dados.elegibilidade)),
    h('h3', {}, 'Perfil fiscal'), formPerfil,
    h('h3', { id: 'certificado' }, 'Certificado digital'),
    h('details', { class: 'cartao' }, h('summary', {}, 'Por que preciso do certificado?'),
      h('p', {}, 'A Receita só aceita notas enviadas por aplicativos quando elas são assinadas com o certificado digital ICP-Brasil do próprio CNPJ (e-CNPJ). Para ME/EPP, o certificado também é usado para consultar se o seu município está no Sistema Nacional. O login gov.br serve para o Emissor Nacional no site, mas não autoriza outros aplicativos a emitir por você.'),
      h('p', {}, 'Aceitamos o modelo A1 (arquivo). O modelo A3 (cartão ou token) não pode ser usado por um servidor.'),
      h('p', {}, 'Sem certificado, você pode continuar preparando rascunhos e emitir pelo Emissor Nacional.')),
    statusCert,
    !dados.perfil ? h('p', { class: 'suave' }, 'Salve o perfil primeiro.') : cert ? h('details', {}, h('summary', {}, 'Trocar certificado'), formCert) : formCert,
    h('h3', {}, 'Conta'),
    h('a', { class: 'btn', href: '#/instalar' }, 'Instalar na tela inicial'),
    h('button', { class: 'btn btn-texto', type: 'button', onclick: sair }, 'Sair da conta'),
  );
  return { titulo: 'Perfil', aba: 'perfil', node };
}
