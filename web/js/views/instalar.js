import { h, aviso } from '../ui.js';
import { pedirInstalacao, estado } from '../app.js';

export async function tela() {
  const pedido = pedirInstalacao();
  const instalado = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return {
    titulo: 'Instalar', voltar: true, semAbas: !estado.conta,
    node: h('div', {},
      instalado ? h('p', { class: 'cartao cartao-ok' }, 'O NotaVez já está instalado neste aparelho.') : null,
      pedido ? h('button', {
        class: 'btn btn-primario btn-grande', type: 'button',
        onclick: async () => { pedido.prompt(); const r = await pedido.userChoice; if (r.outcome === 'accepted') aviso('Pronto! Procure o ícone NotaVez.'); },
      }, 'Instalar agora') : null,
      h('section', { class: 'cartao', 'aria-labelledby': 'and' },
        h('h2', { id: 'and', style: 'margin-top:0' }, 'Android (Chrome)'),
        h('ol', { class: 'passos' },
          h('li', {}, 'Abra o NotaVez no ', h('strong', {}, 'Chrome'), '.'),
          h('li', {}, 'Toque no menu ', h('strong', {}, '⋮'), ' (três pontinhos, no alto à direita).'),
          h('li', {}, 'Toque em ', h('strong', {}, 'Instalar app'), ' ou ', h('strong', {}, 'Adicionar à tela inicial'), '.'),
          h('li', {}, 'Confirme em ', h('strong', {}, 'Instalar'), '. O ícone aparece junto dos seus apps.'))),
      h('section', { class: 'cartao', 'aria-labelledby': 'ios' },
        h('h2', { id: 'ios', style: 'margin-top:0' }, 'iPhone (Safari)'),
        h('ol', { class: 'passos' },
          h('li', {}, 'Abra o NotaVez no ', h('strong', {}, 'Safari'), '.'),
          h('li', {}, 'Toque no botão ', h('strong', {}, 'Compartilhar'), ' (quadrado com seta para cima, na barra de baixo).'),
          h('li', {}, 'Role e toque em ', h('strong', {}, 'Adicionar à Tela de Início'), '.'),
          h('li', {}, 'Toque em ', h('strong', {}, 'Adicionar'), ', no alto à direita.'))),
      h('p', { class: 'suave' }, 'Instalado, o NotaVez abre em tela cheia e permite preparar notas mesmo sem internet. A emissão sempre precisa de conexão.'),
      estado.conta ? null : h('a', { class: 'btn', href: '#/entrar' }, 'Voltar')),
  };
}
