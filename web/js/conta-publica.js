import { excluirDadosDaConta } from './store.js';

async function requisitar(metodo, url, corpo, identidade) {
  const r = await fetch(url, { method: metodo, credentials: 'same-origin', headers: {
    Accept: 'application/json', ...(identidade ? { 'X-NotaVez-Usuario': identidade.usuarioId, 'X-NotaVez-Prestador': identidade.prestadorId || '' } : {}), ...(metodo !== 'GET' ? { 'Content-Type': 'application/json', 'X-NotaVez': '1' } : {}),
  }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  const dados = await r.json();
  if (!r.ok) throw new Error(dados.erro || 'Não foi possível concluir.');
  return dados;
}
function configurarForm(id, acao) {
  const form = document.getElementById(id);
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const resultado = document.getElementById('resultado');
    const botao = form.querySelector('button');
    botao.disabled = true;
    resultado.textContent = 'Aguarde…';
    try { await acao(form, resultado); }
    catch (err) { resultado.textContent = err instanceof TypeError ? 'Sem conexão. Tente novamente quando estiver online.' : err.message; }
    finally { botao.disabled = false; }
  });
}
configurarForm('excluir-conta', async (form, resultado) => {
  // Não usa sessão anterior: a identidade é sempre a do e-mail informado.
  const entrada = await requisitar('POST', '/api/conta/entrar', { email: form.elements.email.value, senha: form.elements.senha.value });
  const conta = await requisitar('GET', '/api/conta');
  if (conta.usuarioId !== entrada.usuarioId) throw new Error('A conta mudou em outra aba. Confirme novamente o e-mail da conta que deseja excluir.');
  await requisitar('DELETE', '/api/conta', { senha: form.elements.senha.value }, conta);
  form.elements.senha.value = '';
  form.hidden = true;
  try {
    await excluirDadosDaConta(conta.usuarioId);
    resultado.textContent = 'Conta e dados associados excluídos do banco ativo. Os dados locais desta conta foram removidos deste navegador. Limpe o armazenamento do site nos outros aparelhos para apagar cópias offline.';
  } catch {
    resultado.textContent = 'Conta excluída do banco ativo. Não foi possível limpar os dados locais: apague o armazenamento deste site nas configurações do navegador e nos outros aparelhos.';
  }
});
configurarForm('recuperar-conta', async (form, resultado) => {
  const r = await requisitar('POST', '/api/conta/recuperar', { email: form.elements.email.value });
  resultado.textContent = r.mensagem;
});
// Fragmento evita token nos logs HTTP/referrer. Apagar imediatamente da barra.
let token = new URLSearchParams(location.hash.slice(1)).get('token');
if (document.getElementById('redefinir-senha') && token) {
  history.replaceState(null, '', location.pathname + location.search);
  document.getElementById('recuperar-conta').hidden = true;
  document.getElementById('redefinir-senha').hidden = false;
}
configurarForm('redefinir-senha', async (form, resultado) => {
  if (form.elements.senha.value !== form.elements.confirmacao.value) throw new Error('As senhas precisam ser iguais.');
  await requisitar('POST', '/api/conta/redefinir', { token, senha: form.elements.senha.value });
  token = null;
  form.reset();
  form.hidden = true;
  resultado.textContent = 'Senha alterada. Entre novamente no aplicativo com a nova senha.';
});
if (document.getElementById('configuracao')) {
  requisitar('GET', '/api/conta/transparencia').then((dados) => {
    document.getElementById('responsavel').textContent = dados.responsavel || 'Não configurado';
    document.getElementById('contato').textContent = dados.contatoPrivacidade || 'Não configurado';
    if (dados.retencao) document.getElementById('retencao').textContent = dados.retencao;
    document.getElementById('configuracao').textContent = dados.configurada
      ? 'Informações operacionais fornecidas pelo responsável. Consulte os detalhes de dados e exclusão abaixo.'
      : 'Política incompleta: responsável, contato e retenção precisam ser definidos e revisados antes de publicação comercial.';
  }).catch(() => { document.getElementById('configuracao').textContent = 'Não foi possível carregar a identificação do responsável. Esta política ainda precisa de configuração e revisão.'; });
}
