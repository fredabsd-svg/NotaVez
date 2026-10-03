import { h, campo, aviso } from '../ui.js';
import { definirConta, sincronizarTodos } from '../store.js';
import { api, ErroApi } from '../api.js';
import { carregarConta, ir } from '../app.js';

export async function tela(_, query) {
  let modo = query.modo === 'cadastro' ? 'cadastro' : 'entrar';
  const node = h('div');
  function montar() {
    const email = campo({ rotulo: 'E-mail', tipo: 'email', atributos: { autocomplete: 'email', inputmode: 'email', required: true } });
    const senha = campo({
      rotulo: 'Senha', tipo: 'password',
      ajuda: modo === 'cadastro' ? 'Mínimo de 8 caracteres. É a senha do Nota Sem Stress — não use sua senha gov.br.' : null,
      atributos: { autocomplete: modo === 'cadastro' ? 'new-password' : 'current-password', required: true, minlength: modo === 'cadastro' ? 8 : undefined },
    });
    const erro = h('p', { class: 'erro-campo', role: 'alert', hidden: true });
    const botao = h('button', { class: 'btn btn-primario', type: 'submit' }, modo === 'cadastro' ? 'Criar conta' : 'Entrar');
    const form = h('form', {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        erro.hidden = true;
        botao.disabled = true;
        try {
          await definirConta(null);
          const entrada = await api('POST', `/api/conta/${modo === 'cadastro' ? 'cadastrar' : 'entrar'}`, { email: email.entrada.value, senha: senha.entrada.value });
          await carregarConta({ permitirOffline: false, substituirTitular: true, usuarioEsperado: entrada.usuarioId });
          sincronizarTodos().catch(() => {});
          if (modo === 'cadastro') aviso('Conta criada. Agora preencha seu perfil fiscal.');
          ir(modo === 'cadastro' ? '/perfil' : '/', { substituir: true });
        } catch (err) {
          erro.textContent = err instanceof ErroApi ? err.message : 'Não foi possível entrar.';
          erro.hidden = false;
        } finally { botao.disabled = false; }
      },
    }, email, senha, erro, botao);

    node.replaceChildren(
      h('div', { class: 'centro' },
        h('img', { class: 'marca marca-clara', src: '/icons/logo.svg', alt: 'Nota Sem Stress', width: 290, height: 44 }),
        h('img', { class: 'marca marca-escura', src: '/icons/logo-escuro.svg', alt: 'Nota Sem Stress', width: 290, height: 44 }),
        h('h2', {}, 'Nota fiscal de serviço em poucos toques'),
        h('p', { class: 'suave' }, 'Para MEI e empresas prestadoras de serviço (Simples, Presumido ou Real). Cadastre clientes, salve serviços e emita sua NFS-e pelo celular.')),
      h('div', { class: 'chips', role: 'tablist' },
        h('button', { class: 'chip', type: 'button', role: 'tab', 'aria-pressed': String(modo === 'entrar'), 'aria-selected': String(modo === 'entrar'), onclick: () => { modo = 'entrar'; montar(); } }, 'Já tenho conta'),
        h('button', { class: 'chip', type: 'button', role: 'tab', 'aria-pressed': String(modo === 'cadastro'), 'aria-selected': String(modo === 'cadastro'), onclick: () => { modo = 'cadastro'; montar(); } }, 'Criar conta')),
      form,
      h('a', { class: 'btn btn-texto', href: '/recuperar-conta.html' }, 'Esqueci minha senha'),
      h('div', { class: 'cartao' },
        h('p', { class: 'suave' }, 'Importante: o Nota Sem Stress nunca pede nem guarda sua senha gov.br. Para emitir, a Receita exige o certificado digital A1 do seu CNPJ, que você envia depois, com segurança.')),
      h('a', { class: 'btn btn-texto', href: '#/instalar' }, 'Como instalar no celular'),
    );
  }
  montar();
  return { titulo: 'Entrar', node, semAbas: true };
}
