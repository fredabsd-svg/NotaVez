// Entrada no estilo do Portal da NFS-e: usuário (CPF/CNPJ ou e-mail) e senha,
// primeiro acesso e "Entrar com gov.br" (quando o servidor tem credenciais do Login Único).
import { h, anexar, campo, aviso, mascaraDocumento } from '../ui.js';
import { definirConta, sincronizarTodos } from '../store.js';
import { api, ErroApi } from '../api.js';
import { carregarConta, ir } from '../app.js';

const MENSAGENS_GOVBR = {
  cancelado: 'O acesso com gov.br foi cancelado.',
  expirou: 'O acesso com gov.br expirou ou foi aberto em outro navegador. Tente de novo.',
  vincular: 'Já existe uma conta com este CPF ou e-mail. Entre com sua senha e depois vincule o gov.br em Conta.',
  'em-uso': 'Esta conta gov.br já está vinculada a outro acesso do Nota Sem Stress.',
  indisponivel: 'O acesso com gov.br ainda não está disponível neste servidor. Use usuário e senha.',
  erro: 'Não foi possível confirmar o acesso com o gov.br. Tente de novo em instantes.',
};

// Usuário: só números (CPF/CNPJ) ganham máscara; e-mail e CNPJ alfanumérico ficam como digitados.
const mascararUsuario = (v) => (/^[\d./-]*$/.test(v) ? mascaraDocumento(v) : v);

function botaoGovbr(texto) {
  return h('a', { class: 'btn btn-govbr', href: '/api/conta/govbr/entrar' }, texto, h('strong', {}, 'gov.br'));
}

export async function tela(_, query) {
  let modo = query.modo === 'cadastro' ? 'cadastro' : 'entrar';
  let govbr = false;
  try { govbr = navigator.onLine && (await api('GET', '/api/conta/govbr')).disponivel; } catch { /* sem gov.br */ }
  const node = h('div');

  // Marcado por padrão: o app abre já conectado nas próximas vezes (renova a cada uso).
  let seq = 0;
  function manterConectado() {
    const id = `manter-${++seq}`;
    const caixa = h('input', { type: 'checkbox', id, checked: true });
    const wrap = h('label', { class: 'caixa', for: id }, caixa,
      h('span', {}, 'Manter conectado neste aparelho', h('span', { class: 'ajuda' }, 'Você não precisará entrar de novo aqui. Desmarque em computador compartilhado.')));
    wrap.marcado = () => caixa.checked;
    return wrap;
  }

  async function concluirEntrada(entrada, destino) {
    await carregarConta({ permitirOffline: false, substituirTitular: true, usuarioEsperado: entrada.usuarioId });
    sincronizarTodos().catch(() => {});
    ir(destino, { substituir: true });
  }

  function formEntrar() {
    const usuario = campo({
      rotulo: 'CPF, CNPJ ou e-mail',
      atributos: { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, maxlength: 254 },
      oninput: (e) => { e.target.value = mascararUsuario(e.target.value); },
    });
    const senha = campo({ rotulo: 'Senha', tipo: 'password', atributos: { autocomplete: 'current-password', required: true } });
    const manter = manterConectado();
    const erro = h('p', { class: 'erro-campo', role: 'alert', hidden: true });
    const botao = h('button', { class: 'btn btn-primario', type: 'submit' }, 'Entrar');
    return h('section', { class: 'cartao acesso', 'aria-labelledby': 'acesso-senha' },
      h('h2', { id: 'acesso-senha' }, 'Acesso com usuário e senha'),
      h('form', {
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          erro.hidden = true;
          botao.disabled = true;
          try {
            await definirConta(null);
            const entrada = await api('POST', '/api/conta/entrar', { usuario: usuario.entrada.value, senha: senha.entrada.value, lembrar: manter.marcado() });
            await concluirEntrada(entrada, '/');
          } catch (err) {
            erro.textContent = err instanceof ErroApi ? err.message : 'Não foi possível entrar.';
            erro.hidden = false;
          } finally { botao.disabled = false; }
        },
      }, usuario, senha, manter, erro, botao),
      h('div', { class: 'acesso-links' },
        h('button', { class: 'link', type: 'button', onclick: () => { modo = 'cadastro'; montar(); } }, 'Fazer primeiro acesso'),
        h('a', { href: '/recuperar-conta.html' }, 'Esqueci a minha senha')));
  }

  function formCadastro() {
    const documento = campo({
      rotulo: 'CPF ou CNPJ', ajuda: 'Será o seu usuário para entrar, como no Portal da NFS-e.',
      atributos: { inputmode: 'text', autocapitalize: 'characters', autocomplete: 'username', required: true },
      oninput: (e) => { e.target.value = mascaraDocumento(e.target.value); },
    });
    const nome = campo({ rotulo: 'Nome', ajuda: 'Opcional. Seu nome ou o do escritório.', atributos: { autocomplete: 'name', maxlength: 200 } });
    const email = campo({ rotulo: 'E-mail', ajuda: 'Para recuperar a senha. Também serve como usuário.', tipo: 'email', atributos: { autocomplete: 'email', inputmode: 'email', required: true } });
    const senha = campo({ rotulo: 'Senha', ajuda: 'Mínimo de 8 caracteres. É a senha do Nota Sem Stress — não use sua senha gov.br.', tipo: 'password', atributos: { autocomplete: 'new-password', required: true, minlength: 8 } });
    const repetir = campo({ rotulo: 'Repita a senha', tipo: 'password', atributos: { autocomplete: 'new-password', required: true, minlength: 8 } });
    const manter = manterConectado();
    const erro = h('p', { class: 'erro-campo', role: 'alert', hidden: true });
    const botao = h('button', { class: 'btn btn-primario', type: 'submit' }, 'Criar acesso');
    return h('section', { class: 'cartao acesso', 'aria-labelledby': 'primeiro-acesso' },
      h('h2', { id: 'primeiro-acesso' }, 'Primeiro acesso'),
      h('form', {
        novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          erro.hidden = true;
          if (senha.entrada.value !== repetir.entrada.value) { repetir.erro('As senhas precisam ser iguais.'); return; }
          repetir.erro('');
          botao.disabled = true;
          try {
            await definirConta(null);
            const entrada = await api('POST', '/api/conta/cadastrar', { documento: documento.entrada.value, nome: nome.entrada.value, email: email.entrada.value, senha: senha.entrada.value, lembrar: manter.marcado() });
            aviso('Acesso criado. Agora cadastre a empresa pelo CNPJ.');
            await concluirEntrada(entrada, '/empresas/nova');
          } catch (err) {
            erro.textContent = err instanceof ErroApi ? err.message : 'Não foi possível criar o acesso.';
            erro.hidden = false;
          } finally { botao.disabled = false; }
        },
      }, documento, nome, email, senha, repetir, manter, erro, botao),
      h('div', { class: 'acesso-links' },
        h('button', { class: 'link', type: 'button', onclick: () => { modo = 'entrar'; montar(); } }, 'Já tenho acesso')));
  }

  function montar() {
    const msg = MENSAGENS_GOVBR[query.govbr];
    node.replaceChildren();
    anexar(node,
      h('div', { class: 'centro' },
        h('img', { class: 'marca marca-clara', src: '/icons/logo.svg', alt: 'Nota Sem Stress', width: 290, height: 44 }),
        h('img', { class: 'marca marca-escura', src: '/icons/logo-escuro.svg', alt: 'Nota Sem Stress', width: 290, height: 44 }),
        h('p', { class: 'suave' }, 'NFS-e de serviço em poucos toques, para MEI, Simples, Presumido e Real — e para quem cuida de várias empresas.')),
      msg ? h('p', { class: `cartao ${query.govbr === 'cancelado' ? 'cartao-alerta' : 'cartao-erro'}`, role: 'alert' }, msg) : null,
      modo === 'cadastro' ? formCadastro() : formEntrar(),
      govbr ? h('section', { class: 'cartao acesso', 'aria-labelledby': 'acesso-govbr' },
        h('h2', { id: 'acesso-govbr' }, 'Acesso via gov.br'),
        h('p', {}, modo === 'cadastro'
          ? 'Prefere não criar senha? Use sua conta gov.br: o CPF vem confirmado e você entra sem senha nova.'
          : 'Entre com a mesma conta gov.br que você usa nos serviços públicos digitais.'),
        botaoGovbr(modo === 'cadastro' ? 'Criar acesso com' : 'Entrar com'),
        h('p', { class: 'suave' }, 'O gov.br só identifica você. Para emitir notas, a Receita continua exigindo o certificado digital A1 da empresa.'))
        : null,
      h('div', { class: 'cartao' },
        h('p', { class: 'suave' }, 'O Nota Sem Stress nunca pede nem guarda a sua senha gov.br. O certificado A1 de cada empresa é enviado depois, com segurança.')),
      h('a', { class: 'btn btn-texto', href: '#/instalar' }, 'Como instalar no celular'),
    );
  }
  montar();
  return { titulo: modo === 'cadastro' ? 'Primeiro acesso' : 'Entrar', node, semAbas: true };
}
