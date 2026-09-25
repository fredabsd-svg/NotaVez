import { h, campo, mostrarErros, aviso, mascaraDocumento, icone, ICONES, buscaComSugestoes } from '../ui.js';
import { api, ErroApi } from '../api.js';
import { comCache, buscarMunicipio, municipioPorCodigo } from '../store.js';
import { aplicar } from '../rascunho.js';
import { ir } from '../app.js';

async function escolherParaNota(notaId, c) {
  await aplicar(notaId, { clienteId: c.id }, { cliente: { nome: c.nome, documentoExibicao: c.documentoExibicao, tipo: c.tipo } });
  ir(`/nota/${notaId}`, { substituir: true });
}

export async function lista(_, query) {
  const para = query.para;
  const { clientes } = await comCache('clientes', () => api('GET', '/api/clientes'));
  const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const ul = h('ul', { class: 'lista', 'aria-live': 'polite' });
  const contador = h('p', { class: 'suave', role: 'status' });

  const itemCliente = (c) => h('li', {}, h('button', {
    class: 'item', type: 'button',
    onclick: () => (para ? escolherParaNota(para, c) : ir(`/clientes/${c.id}`)),
  },
  h('div', { class: 'item-corpo' }, h('div', { class: 'item-titulo' }, c.nome), h('div', { class: 'item-sub' }, `${c.tipo} ${c.documentoExibicao}`)),
  para ? h('span', { class: 'selo selo-teste' }, 'Escolher') : null));

  function exibir(itens, filtrando) {
    contador.textContent = filtrando ? `${itens.length} encontrado(s)` : `${itens.length} cliente(s)`;
    ul.replaceChildren(...itens.map(itemCliente));
    if (!itens.length) ul.append(h('li', { class: 'suave' }, filtrando ? 'Nenhum cliente encontrado. Cadastre um novo abaixo.' : 'Nenhum cliente ainda.'));
  }

  // Nome: filtra no aparelho. CPF/CNPJ (3+ dígitos): o servidor compara o documento completo.
  let espera;
  function mostrar(q = '') {
    const t = semAcento(q).trim();
    clearTimeout(espera);
    if (!t) return exibir(clientes, false);
    const digitos = t.replace(/[^0-9a-z]/g, '');
    if (/\d{3}/.test(t.replace(/\D/g, '')) && navigator.onLine) {
      espera = setTimeout(async () => {
        try { exibir((await api('GET', `/api/clientes?q=${encodeURIComponent(q)}`)).clientes, true); } catch { /* mantém a lista */ }
      }, 300);
      return;
    }
    exibir(clientes.filter((c) => semAcento(c.nome).includes(t) || (digitos.length >= 3 && semAcento(c.documentoExibicao).replace(/[^0-9a-z]/g, '').includes(digitos))), true);
  }

  const busca = campo({
    rotulo: 'Pesquisar', ajuda: 'Nome, CPF ou CNPJ',
    atributos: { type: 'search', autocomplete: 'off', placeholder: 'Ex.: Maria ou 123.456' },
    oninput: (e) => mostrar(e.target.value),
  });
  mostrar();
  return {
    titulo: para ? 'Escolher cliente' : 'Clientes', aba: 'clientes', voltar: !!para,
    node: h('div', {},
      busca, contador, ul,
      h('div', { class: 'rodape-fixo' }, h('a', { class: 'btn btn-primario', href: `#/clientes/novo${para ? `?para=${para}` : ''}` }, icone(ICONES.mais), 'Novo cliente'))),
  };
}

export async function formulario({ id }, query) {
  const para = query.para;
  let c = { tipo: 'CPF', documento: '', nome: '', email: '', fone: '', endereco: null };
  if (id) c = (await api('GET', `/api/clientes/${id}`)).cliente;
  const end = c.endereco || {};
  const mun = end.municipioIbge ? await municipioPorCodigo(end.municipioIbge) : null;

  const doc = campo({
    rotulo: 'CPF ou CNPJ', valor: mascaraDocumento(c.documento),
    atributos: { inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters', required: true },
    oninput: (e) => { e.target.value = mascaraDocumento(e.target.value); atualizarEndereco(); },
  });
  const nome = campo({ rotulo: 'Nome ou razão social', valor: c.nome, atributos: { autocomplete: 'off', required: true, maxlength: 300 } });
  const email = campo({ rotulo: 'E-mail', ajuda: 'Opcional', tipo: 'email', valor: c.email || '', atributos: { inputmode: 'email', maxlength: 80 } });
  const fone = campo({ rotulo: 'Telefone', ajuda: 'Opcional. DDD + número', tipo: 'tel', valor: c.fone || '', atributos: { inputmode: 'tel', maxlength: 20 } });
  const cep = campo({ rotulo: 'CEP', valor: end.cep || '', atributos: { inputmode: 'numeric', maxlength: 9, autocomplete: 'postal-code' } });
  let municipioIbge = end.municipioIbge || '';
  const municipio = buscaComSugestoes({
    rotulo: 'Cidade', placeholder: 'Digite o nome da cidade', valorInicial: mun ? `${mun.nome} - ${mun.uf}` : '',
    buscar: buscarMunicipio, formatar: (m) => `${m.nome} - ${m.uf}`,
    aoEscolher: (m, cmp) => { municipioIbge = m.ibge; cmp.entrada.value = `${m.nome} - ${m.uf}`; },
  });
  municipio.entrada.addEventListener('input', () => { municipioIbge = ''; });
  const logradouro = campo({ rotulo: 'Rua / avenida', valor: end.logradouro || '', atributos: { autocomplete: 'address-line1', maxlength: 255 } });
  const numero = campo({ rotulo: 'Número', valor: end.numero || '', atributos: { maxlength: 60 } });
  const complemento = campo({ rotulo: 'Complemento', ajuda: 'Opcional', valor: end.complemento || '', atributos: { maxlength: 156 } });
  const bairro = campo({ rotulo: 'Bairro', valor: end.bairro || '', atributos: { maxlength: 60 } });

  const blocoEndereco = h('details', { open: !!c.endereco },
    h('summary', {}, 'Endereço'),
    h('p', { class: 'suave', id: 'endereco-ajuda' }, ''),
    h('div', { class: 'linha' }, cep, numero), municipio, logradouro, complemento, bairro);
  function atualizarEndereco() {
    const cnpj = doc.entrada.value.replace(/[^0-9A-Z]/gi, '').length > 11;
    blocoEndereco.querySelector('#endereco-ajuda').textContent = cnpj
      ? 'Obrigatório para CNPJ (a Receita exige o endereço do cliente empresa).'
      : 'Opcional para CPF, salvo quando o serviço exigir.';
    if (cnpj) blocoEndereco.open = true;
  }
  atualizarEndereco();

  const erroGeral = h('p', { class: 'erro-campo', role: 'alert', hidden: true });
  const salvar = h('button', { class: 'btn btn-primario', type: 'submit' }, para ? 'Salvar e usar na nota' : 'Salvar cliente');
  const form = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      salvar.disabled = true;
      erroGeral.hidden = true;
      const temEndereco = [cep, logradouro, numero, bairro].some((x) => x.entrada.value.trim()) || municipioIbge;
      const corpo = {
        documento: doc.entrada.value, nome: nome.entrada.value, email: email.entrada.value, fone: fone.entrada.value,
        endereco: temEndereco ? { cep: cep.entrada.value, municipioIbge, logradouro: logradouro.entrada.value, numero: numero.entrada.value, complemento: complemento.entrada.value, bairro: bairro.entrada.value } : null,
      };
      try {
        const r = await api(id ? 'PUT' : 'POST', id ? `/api/clientes/${id}` : '/api/clientes', corpo);
        aviso('Cliente salvo.');
        if (para) {
          await aplicar(para, { clienteId: r.cliente.id }, { cliente: { nome: r.cliente.nome, documentoExibicao: r.cliente.documentoExibicao, tipo: r.cliente.tipo } });
          ir(`/nota/${para}`, { substituir: true });
        } else history.back();
      } catch (err) {
        if (err instanceof ErroApi && err.dados?.campos) {
          const cmp = err.dados.campos;
          mostrarErros({ documento: doc, nome, email, fone }, cmp);
          if (cmp.endereco) { blocoEndereco.open = true; erroGeral.textContent = cmp.endereco; erroGeral.hidden = false; }
        } else if (err instanceof ErroApi && err.status === 409 && err.dados?.clienteId) {
          erroGeral.replaceChildren(err.message, ' ', h('a', { href: `#/clientes/${err.dados.clienteId}` }, 'Abrir cadastro'));
          erroGeral.hidden = false;
        } else {
          erroGeral.textContent = err.status === 0 ? 'Sem internet: o cadastro de clientes precisa de conexão.' : err.message;
          erroGeral.hidden = false;
        }
      } finally { salvar.disabled = false; }
    },
  }, doc, nome, email, fone, blocoEndereco, erroGeral, h('div', { class: 'rodape-fixo' }, salvar));

  const excluir = id ? h('button', {
    class: 'btn btn-texto btn-perigo', type: 'button',
    onclick: async () => {
      if (!confirm(`Excluir o cliente "${c.nome}"? As notas já emitidas não são afetadas.`)) return;
      await api('DELETE', `/api/clientes/${id}`);
      aviso('Cliente excluído.');
      history.back();
    },
  }, 'Excluir cliente') : null;

  return { titulo: id ? 'Editar cliente' : 'Novo cliente', aba: 'clientes', voltar: true, node: h('div', {}, form, excluir) };
}
