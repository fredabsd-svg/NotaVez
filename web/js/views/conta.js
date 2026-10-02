import { h, campo } from '../ui.js';
import { api } from '../api.js';

export async function tela() {
  const conta = await api('GET', '/api/conta');
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
  const node = h('div', {}, h('p', {}, `Conta: ${conta.email}`),
    h('h2', {}, 'Excluir conta'),
    h('p', {}, 'Antes de excluir, baixe os documentos de que precisa. A conta, sessões, perfil, clientes, serviços, rascunhos, notas, registros associados e certificado A1 serão apagados do banco ativo do serviço.'),
    h('p', {}, 'Notas em envio ou com resultado incerto precisam ser verificadas primeiro. Excluir aqui não cancela documentos já emitidos nem apaga registros mantidos pelos sistemas fiscais oficiais.'),
    h('p', {}, 'Os dados locais desta conta serão removidos deste navegador quando possível. Outros aparelhos precisam se conectar para reconhecer a sessão revogada; limpe o armazenamento deles para apagar cópias locais.'),
    h('a', { href: '/privacidade.html' }, 'Consultar privacidade e retenção'), formulario,
    h('a', { href: '/recuperar-conta.html' }, 'Esqueci minha senha'));
  return { titulo: 'Conta', aba: 'perfil', node };
}
