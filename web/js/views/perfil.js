import { h, campo, mostrarErros, aviso, mascaraDocumento, data, buscaComSugestoes } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { buscarMunicipio, kvGravar } from '../store.js';
import { sair, estado, atualizarSelo } from '../app.js';

function checklist(eleg) {
  return h('ul', { class: 'check' }, eleg.itens.map((i) => h('li', {},
    h('span', { class: i.ok ? 'ok' : 'nao', 'aria-hidden': 'true' }, i.ok ? '✓' : '✕'),
    h('span', {}, h('span', { class: 'sr' }, i.ok ? 'Concluído: ' : 'Pendente: '), h('strong', {}, i.titulo),
      i.comoResolver ? h('span', { class: 'suave', style: 'display:block' }, i.comoResolver) : null))));
}

export async function tela() {
  const dados = await api('GET', '/api/perfil');
  const p = dados.perfil || {};
  const node = h('div');

  // ----- Perfil fiscal -----
  const cnpj = campo({ rotulo: 'CNPJ do MEI', valor: mascaraDocumento(p.documento || ''), atributos: { inputmode: 'text', autocapitalize: 'characters', autocomplete: 'off' }, oninput: (e) => { e.target.value = mascaraDocumento(e.target.value); } });
  const nome = campo({ rotulo: 'Nome ou razão social', ajuda: 'Só para exibição no app (a nota usa o nome do cadastro do CNPJ).', valor: p.nome || '', atributos: { maxlength: 300 } });
  let municipioIbge = p.municipioIbge || '';
  const municipio = buscaComSugestoes({
    rotulo: 'Município do seu CNPJ', ajuda: 'O mesmo do endereço do CNPJ na Receita.',
    valorInicial: p.municipio ? `${p.municipio.nome} - ${p.municipio.uf}` : '', placeholder: 'Digite a cidade',
    buscar: buscarMunicipio, formatar: (m) => `${m.nome} - ${m.uf}`,
    aoEscolher: (m, c) => { municipioIbge = m.ibge; c.entrada.value = `${m.nome} - ${m.uf}`; },
  });
  municipio.entrada.addEventListener('input', () => { municipioIbge = ''; });
  const regime = campo({ rotulo: 'Situação no Simples Nacional', valor: p.opSimpNac || '2', opcoes: [['2', 'MEI'], ['3', 'ME/EPP (em breve)'], ['1', 'Não optante (em breve)']] });
  const email = campo({ rotulo: 'E-mail de contato', ajuda: 'Opcional. Vai na nota.', tipo: 'email', valor: p.email || '', atributos: { inputmode: 'email', maxlength: 80 } });
  const fone = campo({ rotulo: 'Telefone', ajuda: 'Opcional. DDD + número.', tipo: 'tel', valor: p.fone || '', atributos: { inputmode: 'tel' } });
  const im = campo({ rotulo: 'Inscrição municipal', ajuda: 'Só se sua prefeitura tiver cadastro complementar.', valor: p.inscricaoMunicipal || '', atributos: { maxlength: 15 } });
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
        });
        aviso('Perfil salvo.');
        estado.inicio = await api('GET', '/api/inicio');
        await kvGravar('inicio', estado.inicio);
        atualizarSelo();
        location.reload();
      } catch (err) {
        if (err instanceof ErroApi && err.dados?.campos) mostrarErros({ documento: cnpj, municipioIbge: municipio, opSimpNac: regime, email, serieDps: serie, ambiente }, err.dados.campos);
        else { erroPerfil.textContent = err.message; erroPerfil.hidden = false; }
      } finally { salvarPerfil.disabled = false; }
    },
  }, cnpj, nome, municipio, regime, email, fone, h('details', {}, h('summary', {}, 'Opções avançadas'), im, serie, ambiente), erroPerfil, salvarPerfil);

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

  node.append(
    h('section', { class: 'cartao' }, h('h2', { style: 'font-size:19px;margin-top:0' }, dados.elegibilidade.podeEmitir ? 'Tudo pronto para emitir' : 'O que falta para emitir'), checklist(dados.elegibilidade)),
    h('h3', {}, 'Perfil fiscal'), formPerfil,
    h('h3', { id: 'certificado' }, 'Certificado digital'),
    h('details', { class: 'cartao' }, h('summary', {}, 'Por que preciso do certificado?'),
      h('p', {}, 'A Receita só aceita notas enviadas por aplicativos quando elas são assinadas com o certificado digital ICP-Brasil do próprio CNPJ (e-CNPJ). O login gov.br serve para o Emissor Nacional no site, mas não autoriza outros aplicativos a emitir por você.'),
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
