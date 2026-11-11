// Consulta do CNPJ na base pública da Receita (via servidor) para preencher
// cadastros sozinho. O resultado é sugestão: o usuário confere antes de salvar.
import { h, data } from './ui.js';
import { api, ErroApi } from './api.js';

export const cnpjCompleto = (v) => {
  const s = String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return /^[0-9A-Z]{12}\d{2}$/.test(s) ? s : null;
};

export const consultarCnpj = async (cnpj) => (await api('GET', `/api/cnpj/${encodeURIComponent(cnpj)}`)).cnpj;

const linha = (rotulo, valor) => (valor ? h('div', {}, h('dt', {}, rotulo), h('dd', {}, valor)) : null);
const PORTES = { ME: 'Microempresa', EPP: 'Empresa de pequeno porte', DEMAIS: 'Demais' };

export function cartaoCnpj(d) {
  const e = d.endereco || {};
  const endereco = [e.logradouro, e.numero, e.complemento, e.bairro, d.municipio ? `${d.municipio.nome} - ${d.municipio.uf}` : null].filter(Boolean).join(', ');
  const simples = d.mei?.optante ? `MEI desde ${data(d.mei.desde)}` : d.simples?.optante ? `Optante desde ${data(d.simples.desde)}` : d.simples?.optante === false ? 'Não optante' : 'Não informado';
  return h('section', { class: `cartao consulta-cnpj ${d.ativa === false ? 'cartao-alerta' : 'cartao-ok'}`, 'aria-live': 'polite' },
    h('strong', {}, 'Dados encontrados na Receita'),
    d.ativa === false ? h('p', {}, h('strong', {}, `Situação cadastral: ${d.situacaoCadastral}. `), 'A Receita pode recusar notas deste CNPJ.') : null,
    h('dl', { class: 'dados' },
      linha('Razão social', d.razaoSocial), linha('Nome fantasia', d.nomeFantasia),
      linha('Situação', d.situacaoCadastral), linha('Enquadramento sugerido', d.enquadramento?.descricao),
      linha('Simples Nacional', simples), linha('Porte', PORTES[d.porte]),
      linha('Atividade principal', d.cnae ? `${d.cnae.codigo} — ${d.cnae.descricao}` : null), linha('Endereço', endereco)),
    h('p', { class: 'suave' }, `Fonte: base pública do CNPJ (${d.fonte}). Confira o enquadramento: a base aberta pode levar semanas para refletir mudanças.`));
}

// Observa o campo de CNPJ: com os 14 caracteres, consulta e chama aoEncontrar(dados).
// `inicial` evita consultar de novo o CNPJ que já está salvo.
export function consultaAutomatica(entrada, { aoEncontrar, aoFalhar = () => {}, inicial = null }) {
  const status = h('div', { role: 'status' });
  // Botão sempre à vista: busca de novo quando quiser (ou se a busca automática falhou).
  const botao = h('button', { class: 'btn btn-pequeno', type: 'button', onclick: () => buscar(true) }, 'Buscar dados do CNPJ');
  const caixa = h('div', { class: 'consulta-cnpj' }, botao, status);
  let ultimo = cnpjCompleto(inicial);
  let espera;
  async function buscar(forcar = false) {
    const cnpj = cnpjCompleto(entrada.value);
    if (!cnpj) {
      if (forcar) status.replaceChildren(h('p', { class: 'erro-campo' }, 'Digite o CNPJ completo (14 caracteres) para buscar.'));
      return;
    }
    if (!forcar && cnpj === ultimo) return;
    ultimo = cnpj;
    status.replaceChildren(h('p', { class: 'suave' }, 'Buscando os dados deste CNPJ na Receita…'));
    botao.disabled = true;
    try {
      const d = await consultarCnpj(cnpj);
      if (cnpjCompleto(entrada.value) !== cnpj) return;
      aoEncontrar(d, cnpj);
      status.replaceChildren(cartaoCnpj(d));
    } catch (e) {
      ultimo = null; // permite tentar de novo o mesmo CNPJ
      if (cnpjCompleto(entrada.value) !== cnpj) return;
      aoFalhar(e, cnpj); // tira o que a consulta anterior (de outro CNPJ) tinha preenchido
      status.replaceChildren(h('p', { class: 'cartao cartao-alerta', role: 'alert' },
        e instanceof ErroApi && e.status === 0 ? 'Sem internet: preencha os dados manualmente ou toque em "Buscar dados do CNPJ" quando a conexão voltar.' : e.message));
    } finally { botao.disabled = false; }
  }
  const agendar = (ms) => { clearTimeout(espera); espera = setTimeout(buscar, ms); };
  entrada.addEventListener('input', () => agendar(350));
  // Colar, preenchimento automático do navegador e sair do campo também disparam a busca.
  entrada.addEventListener('paste', () => agendar(50));
  entrada.addEventListener('change', () => agendar(0));
  caixa.buscar = () => buscar(true);
  return caixa;
}
