import { h, campo, aviso, icone, ICONES } from '../ui.js';
import { api, ErroApi } from '../api.js';

const NOMES_METODO = { govbr: 'gov.br', certificado: 'certificado digital' };
const MENSAGENS = {
  'vinculado=govbr': ['ok', 'Pronto: agora você também entra com o gov.br.'],
  'vinculado=certificado': ['ok', 'Pronto: agora você também entra com o certificado digital.'],
  'erro=govbr-outra-conta': ['erro', 'Este CPF já entra em outra conta do Nota Sem Stress. Entre nela (ou exclua-a) antes de vincular aqui.'],
  'erro=certificado-outra-conta': ['erro', 'Este CPF/CNPJ já entra em outra conta do Nota Sem Stress. Entre nela (ou exclua-a) antes de vincular aqui.'],
  'erro=govbr': ['erro', 'Não foi possível confirmar o gov.br. Nada foi vinculado.'],
  'erro=govbr-cancelado': ['erro', 'A vinculação com o gov.br foi cancelada.'],
};

export async function tela(_, query = {}) {
  const [conta, metodos, { identidades }] = await Promise.all([
    api('GET', '/api/conta'),
    api('GET', '/api/conta/metodos').catch(() => ({ govbr: false, certificado: false })),
    api('GET', '/api/conta/identidades'),
  ]);
  const chave = Object.entries(query).map(([k, v]) => `${k}=${v}`).find((k) => MENSAGENS[k]);
  const retorno = chave ? h('p', { class: `cartao ${MENSAGENS[chave][0] === 'ok' ? 'cartao-ok' : 'cartao-erro'}`, role: 'status' }, MENSAGENS[chave][1]) : null;

  // Confirmação de identidade: senha (se a conta tem) ou uma entrada recente por gov.br/certificado.
  const senha = conta.temSenha ? campo({ rotulo: 'Confirme sua senha para excluir a conta ou remover uma forma de entrar', tipo: 'password', atributos: { autocomplete: 'current-password', required: true } }) : null;
  const reentrar = h('div', { class: 'entradas', hidden: true },
    h('p', {}, 'Por segurança, entre de novo e repita a operação em até 10 minutos:'),
    metodos.govbr ? h('a', { class: 'btn btn-govbr', href: '/api/conta/govbr/entrar' }, 'Entrar de novo com gov.br') : null,
    metodos.certificado ? h('a', { class: 'btn', href: '/api/conta/certificado/iniciar' }, 'Entrar de novo com certificado') : null);
  const tratarErro = (err, alvo) => {
    alvo.textContent = err.message;
    alvo.hidden = false;
    if (err instanceof ErroApi && err.dados?.codigo === 'REAUTENTICAR') reentrar.hidden = false;
  };

  // ---------- Formas de entrar ----------
  const lista = h('ul', { class: 'lista' });
  const erroLista = h('p', { class: 'erro-campo', role: 'alert', hidden: true });
  function desenhar(ids) {
    lista.replaceChildren(...[
      conta.temSenha ? h('li', { class: 'cartao' }, h('strong', {}, 'E-mail e senha'), h('p', { class: 'suave' }, conta.email)) : null,
      ...ids.map((i) => h('li', { class: 'cartao' },
        h('strong', {}, `${i.tipoDocumento} ${i.documento}`),
        h('p', { class: 'suave' }, `Entra por: ${i.metodos.map((m) => NOMES_METODO[m] || m).join(' e ') || '—'}`),
        h('button', { class: 'btn btn-texto', type: 'button', onclick: async () => {
          if (!confirm(`Remover a entrada pelo ${i.tipoDocumento} ${i.documento}?`)) return;
          erroLista.hidden = true;
          try {
            desenhar((await api('DELETE', `/api/conta/identidades/${i.id}`, { senha: senha?.entrada.value })).identidades);
            aviso('Forma de entrar removida.');
          } catch (err) { tratarErro(err, erroLista); }
        } }, 'Remover'))),
    ].filter(Boolean));
  }
  desenhar(identidades);

  // ---------- Excluir conta ----------
  const concordo = h('input', { type: 'checkbox', id: 'exclusao-confirmada', required: true });
  const erro = h('p', { role: 'alert', class: 'erro-campo', hidden: true });
  const botao = h('button', { type: 'submit', class: 'btn btn-perigo' }, 'Excluir minha conta e dados');
  const formulario = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    if (!concordo.checked || (senha && !senha.entrada.value)) return;
    botao.disabled = true;
    erro.hidden = true;
    try {
      await api('DELETE', '/api/conta', { senha: senha?.entrada.value });
      if (senha) senha.entrada.value = '';
      window.dispatchEvent(new CustomEvent('notavez:conta-excluida', { detail: conta }));
    } catch (err) { tratarErro(err, erro); }
    finally { botao.disabled = false; }
  } }, h('label', { class: 'caixa', for: 'exclusao-confirmada' }, concordo, h('span', {}, 'Entendo que a exclusão remove minha conta e os dados guardados neste serviço.')), erro, botao);

  const identificacao = conta.email || (identidades[0] ? `${identidades[0].tipoDocumento} ${identidades[0].documento}` : 'sem e-mail');
  const node = h('div', {}, retorno,
    h('p', {}, `Conta: ${identificacao}`),
    h('h2', {}, 'Formas de entrar'),
    h('p', { class: 'suave' }, 'O mesmo CPF entra pelo gov.br ou pelo e-CPF; o CNPJ, pelo e-CNPJ. Entrar assim não autoriza emitir: a emissão continua usando o certificado A1 enviado no Perfil.'),
    lista, erroLista,
    metodos.govbr || metodos.certificado ? h('div', { class: 'entradas' },
      metodos.govbr ? h('a', { class: 'btn btn-govbr', href: '/api/conta/govbr/entrar?vincular=1' }, 'Vincular conta gov.br') : null,
      metodos.certificado ? h('a', { class: 'btn', href: '/api/conta/certificado/iniciar?vincular=1' }, icone(ICONES.certificado), 'Vincular certificado digital') : null) : null,
    h('h2', {}, 'Proteção dos seus dados'),
    h('p', {}, 'Seus dados ficam num banco separado, só da sua conta, cifrados com uma chave exclusiva dela. Nenhuma outra conta usa o mesmo arquivo nem a mesma chave. Ao excluir a conta, essa chave é destruída.'),
    h('h2', {}, 'Excluir conta'),
    h('p', {}, 'Antes de excluir, baixe os documentos de que precisa. A conta, sessões, formas de entrar, perfil, clientes, serviços, rascunhos, notas, registros associados e certificado A1 serão apagados, e a chave que cifra esses dados é destruída.'),
    h('p', {}, 'Notas em envio ou com resultado incerto precisam ser verificadas primeiro. Excluir aqui não cancela documentos já emitidos nem apaga registros mantidos pelos sistemas fiscais oficiais.'),
    h('p', {}, 'Os dados locais desta conta serão removidos deste navegador quando possível. Outros aparelhos precisam se conectar para reconhecer a sessão revogada; limpe o armazenamento deles para apagar cópias locais.'),
    h('a', { href: '/privacidade.html' }, 'Consultar privacidade e retenção'),
    senha, reentrar, formulario,
    conta.temSenha ? h('a', { href: '/recuperar-conta.html' }, 'Esqueci minha senha') : null);
  return { titulo: 'Conta', aba: 'perfil', node };
}
