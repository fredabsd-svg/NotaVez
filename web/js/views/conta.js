import { h, campo, aviso } from '../ui.js';
import { api } from '../api.js';

function acessoGovbr(conta) {
  if (conta.govbr) {
    return h('section', { class: 'cartao cartao-ok' }, h('strong', {}, 'Conta gov.br vinculada'),
      h('p', {}, 'Você pode entrar com o botão "Entrar com gov.br".'),
      h('button', { class: 'btn btn-texto btn-perigo', type: 'button', onclick: async () => {
        if (!confirm('Desvincular o gov.br? Você continuará entrando com usuário e senha.')) return;
        try { await api('DELETE', '/api/conta/govbr'); aviso('gov.br desvinculado.'); location.reload(); } catch (e) { aviso(e.message, 7000); }
      } }, 'Desvincular gov.br'));
  }
  if (!conta.govbrDisponivel) return null;
  return h('section', { class: 'cartao' }, h('strong', {}, 'Entrar também com gov.br'),
    h('p', {}, 'Vincule sua conta gov.br para entrar sem senha. Se você ainda não tem usuário CPF/CNPJ, o CPF confirmado pelo gov.br passa a ser o seu usuário.'),
    h('button', { class: 'btn btn-govbr', type: 'button', onclick: async () => {
      try { location.href = (await api('POST', '/api/conta/govbr/vincular', {})).url; } catch (e) { aviso(e.message, 7000); }
    } }, 'Vincular minha conta ', h('strong', {}, 'gov.br')));
}

export async function tela(_, query = {}) {
  const conta = await api('GET', '/api/conta');
  if (query.govbr === 'vinculado') aviso('Conta gov.br vinculada.');
  const senha = campo({ rotulo: 'Confirme sua senha para excluir', tipo: 'password', atributos: { autocomplete: 'current-password', required: true } });
  const concordo = h('input', { type: 'checkbox', id: 'exclusao-confirmada', required: true });
  const erro = h('p', { role: 'alert', class: 'erro-campo', hidden: true });
  const botao = h('button', { type: 'submit', class: 'btn btn-perigo' }, 'Excluir minha conta e dados');
  const formulario = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    if (!concordo.checked || !senha.entrada.value) return;
    botao.disabled = true;
    erro.hidden = true;
    try {
      await api('DELETE', '/api/conta', { senha: senha.entrada.value });
      senha.entrada.value = '';
      window.dispatchEvent(new CustomEvent('notavez:conta-excluida', { detail: conta }));
    } catch (err) { erro.textContent = err.message; erro.hidden = false; }
    finally { botao.disabled = false; }
  } }, senha, h('label', { class: 'caixa', for: 'exclusao-confirmada' }, concordo, h('span', {}, 'Entendo que a exclusão remove minha conta e os dados guardados neste serviço.')), erro, botao);
  const linha = (rotulo, valor) => (valor ? h('div', {}, h('dt', {}, rotulo), h('dd', {}, valor)) : null);
  const node = h('div', {},
    h('dl', { class: 'dados cartao' },
      linha('Nome', conta.nome),
      linha('Usuário (CPF/CNPJ)', conta.documentoFormatado ? `${conta.documentoFormatado}${conta.documentoVerificado ? ' · confirmado pelo gov.br' : ''}` : null),
      linha('E-mail', conta.email || 'Não informado')),
    acessoGovbr(conta),
    h('h2', {}, 'Excluir conta'),
    h('p', {}, 'Antes de excluir, baixe os documentos de que precisa. A conta, sessões, perfil, clientes, serviços, rascunhos, notas, registros associados e certificado A1 serão apagados do banco ativo do serviço.'),
    h('p', {}, 'Notas em envio ou com resultado incerto precisam ser verificadas primeiro. Excluir aqui não cancela documentos já emitidos nem apaga registros mantidos pelos sistemas fiscais oficiais.'),
    h('p', {}, 'Os dados locais desta conta serão removidos deste navegador quando possível. Outros aparelhos precisam se conectar para reconhecer a sessão revogada; limpe o armazenamento deles para apagar cópias locais.'),
    h('a', { href: '/privacidade.html' }, 'Consultar privacidade e retenção'), formulario,
    h('a', { href: '/recuperar-conta.html' }, 'Esqueci minha senha'));
  return { titulo: 'Conta', aba: 'perfil', node };
}
