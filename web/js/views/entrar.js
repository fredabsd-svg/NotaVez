import { h, campo, aviso, icone, ICONES } from '../ui.js';
import { definirConta, sincronizarTodos } from '../store.js';
import { api, ErroApi } from '../api.js';
import { carregarConta, ir } from '../app.js';

// Mensagens dos retornos do gov.br e do certificado (#/entrar?erro=...).
const ERROS = {
  'govbr': 'Não foi possível confirmar sua entrada pelo gov.br. Tente de novo.',
  'govbr-cancelado': 'A entrada pelo gov.br foi cancelada.',
  'govbr-expirado': 'A entrada pelo gov.br expirou ou foi aberta em outro navegador. Comece de novo por aqui.',
  'govbr-indisponivel': 'A entrada pelo gov.br ainda não está disponível neste serviço.',
  'certificado-expirado': 'A entrada com certificado expirou ou foi aberta em outro navegador. Comece de novo por aqui.',
  'certificado-indisponivel': 'A entrada com certificado digital ainda não está disponível neste serviço.',
};
const MOTIVOS_CERTIFICADO = {
  cadeia_desconhecida: 'O certificado não foi emitido por uma autoridade da ICP-Brasil.',
  cadeia_vencida: 'O certificado está vencido (ou a autoridade que o emitiu).',
  politica: 'Este certificado não é um certificado ICP-Brasil de pessoa ou empresa.',
  sem_documento: 'Não encontramos CPF nem CNPJ no certificado.',
  sem_certificado: 'Nenhum certificado foi escolhido. Conecte o token/cartão (A3) ou instale o A1 no aparelho e tente de novo.',
  certificado_ilegivel: 'Não foi possível ler o certificado escolhido.',
  nao_titular: 'Escolha o certificado da pessoa ou da empresa (e-CPF ou e-CNPJ).',
};
export function mensagemErroEntrada(query) {
  if (query.erro === 'certificado') return MOTIVOS_CERTIFICADO[query.motivo] || 'Não foi possível entrar com o certificado digital.';
  return ERROS[query.erro] || null;
}

export async function tela(_, query) {
  let modo = query.modo === 'cadastro' ? 'cadastro' : 'entrar';
  const node = h('div');
  // Formas de entrar ligadas neste servidor (gov.br e certificado dependem de configuração).
  let metodos = { senha: true, govbr: false, certificado: false };
  try { metodos = await api('GET', '/api/conta/metodos'); } catch { /* sem internet: só e-mail e senha */ }
  const erroRetorno = mensagemErroEntrada(query);
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

    node.replaceChildren(...[
      h('div', { class: 'centro' },
        h('img', { class: 'marca marca-clara', src: '/icons/logo.svg', alt: 'Nota Sem Stress', width: 290, height: 44 }),
        h('img', { class: 'marca marca-escura', src: '/icons/logo-escuro.svg', alt: 'Nota Sem Stress', width: 290, height: 44 }),
        h('h2', {}, 'Nota fiscal de serviço em poucos toques'),
        h('p', { class: 'suave' }, 'Para MEI e empresas prestadoras de serviço (Simples, Presumido ou Real). Cadastre clientes, salve serviços e emita sua NFS-e pelo celular.')),
      erroRetorno ? h('p', { class: 'cartao cartao-erro', role: 'alert' }, erroRetorno) : null,
      metodos.govbr || metodos.certificado ? h('div', { class: 'entradas' },
        metodos.govbr ? h('a', { class: 'btn btn-govbr', href: '/api/conta/govbr/entrar' }, 'Entrar com gov.br') : null,
        metodos.certificado ? h('a', { class: 'btn', href: '/api/conta/certificado/iniciar' }, icone(ICONES.certificado), 'Entrar com certificado digital') : null,
        h('p', { class: 'suave' }, 'Sua senha gov.br é digitada só no site do gov.br. Com o certificado, o próprio navegador mostra os certificados instalados (A1) ou do token/cartão (A3).'),
        h('p', { class: 'divisor', role: 'separator' }, h('span', {}, 'ou use e-mail e senha'))) : null,
      h('div', { class: 'chips', role: 'tablist' },
        h('button', { class: 'chip', type: 'button', role: 'tab', 'aria-pressed': String(modo === 'entrar'), 'aria-selected': String(modo === 'entrar'), onclick: () => { modo = 'entrar'; montar(); } }, 'Já tenho conta'),
        h('button', { class: 'chip', type: 'button', role: 'tab', 'aria-pressed': String(modo === 'cadastro'), 'aria-selected': String(modo === 'cadastro'), onclick: () => { modo = 'cadastro'; montar(); } }, 'Criar conta')),
      form,
      h('a', { class: 'btn btn-texto', href: '/recuperar-conta.html' }, 'Esqueci minha senha'),
      h('div', { class: 'cartao' },
        h('p', { class: 'suave' }, 'Importante: o Nota Sem Stress nunca pede nem guarda sua senha gov.br. Entrar com gov.br ou com o certificado só abre a sua conta aqui: para emitir, a Receita exige o certificado digital A1 do seu CNPJ, que você envia depois no Perfil, com segurança.')),
      h('a', { class: 'btn btn-texto', href: '#/instalar' }, 'Como instalar no celular'),
    ].filter(Boolean));
  }
  montar();
  return { titulo: 'Entrar', node, semAbas: true };
}
