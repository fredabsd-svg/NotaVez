// Conta › Backup e Restauração.
// Criar: o servidor gera e CONFERE o backup; o aparelho baixa em partes, confere o SHA-256 e só então diz "pronto".
// Restaurar: o arquivo sobe em partes, o servidor confere tudo (senha, integridade, versão) e mostra o que muda;
// só com a confirmação explícita ele guarda um backup de segurança do estado atual e troca os dados numa
// operação única, que se desfaz sozinha se algo falhar.
import { h, campo, aviso, icone, ICONES, plural, dataHora, baixarArquivo } from '../ui.js';
import { api, ErroApi, cabecalhosIdentidade } from '../api.js';
import { carregarConta } from '../app.js';

const SENHA_MINIMA = 10;
const tamanho = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);
const TIPOS = { manual: 'Backup', seguranca: 'Backup de segurança (antes de restaurar)', enviado: 'Arquivo enviado para restaurar' };
const ROTULOS = { prestadores: 'Empresas', notas: 'Notas emitidas e rascunhos', notas_tomadas: 'Notas tomadas', clientes: 'Clientes', servicos: 'Serviços', certificados: 'Certificados das empresas', certificados_procurador: 'Certificado do escritório', ia_conversas: 'Conversas do assistente' };

async function sha256Hex(texto) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const mensagemDe = (e) => (e instanceof ErroApi && e.status === 0 ? 'Sem internet: esta operação precisa de conexão.' : e.message);

// Barra de progresso com texto e cronômetro (operações longas no servidor mostram que seguem vivas).
function andamento() {
  const barra = h('progress', {});
  const texto = h('p', { class: 'bk-andamento-texto' });
  const tempo = h('span', { class: 'suave' });
  const node = h('div', { class: 'bk-andamento', role: 'status', 'aria-live': 'polite', hidden: true }, barra, h('p', {}, texto, ' ', tempo));
  let relogio = null; let inicio = 0;
  const parar = () => { clearInterval(relogio); relogio = null; tempo.textContent = ''; };
  return {
    node,
    etapa(msg, { feito, total } = {}) {
      node.hidden = false;
      texto.textContent = msg;
      if (total) { barra.max = total; barra.value = feito; parar(); } else {
        barra.removeAttribute('value');
        if (!relogio) { inicio = Date.now(); relogio = setInterval(() => { const s = Math.round((Date.now() - inicio) / 1000); tempo.textContent = `(${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})`; }, 1000); }
      }
    },
    fim() { parar(); node.hidden = true; },
  };
}

// Baixa o backup em partes, confere o SHA-256 do arquivo montado e só então entrega ao navegador.
async function baixarBackup(b, prog) {
  let texto = '';
  for (let i = 0; i < b.partes; i++) {
    prog?.etapa(`Baixando o arquivo: parte ${i + 1} de ${b.partes}…`, { feito: i, total: b.partes });
    const r = await fetch(`/api/backup/${encodeURIComponent(b.id)}/partes/${i}`, { credentials: 'same-origin', headers: cabecalhosIdentidade() });
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.erro || 'Não foi possível baixar o backup agora.');
    texto += await r.text();
  }
  prog?.etapa('Conferindo o arquivo baixado (SHA-256)…');
  const codigo = await sha256Hex(texto);
  if (codigo !== b.sha256 || texto.length !== b.bytes) throw new Error('O arquivo baixado veio diferente do backup guardado. Nada foi salvo; tente baixar de novo.');
  await api('POST', `/api/backup/${encodeURIComponent(b.id)}/baixado`, { sha256: codigo });
  baixarArquivo(b.nomeArquivo, texto, 'application/octet-stream');
  return codigo;
}

export async function tela() {
  const dados = await api('GET', '/api/backup');
  const PARTE = dados.limites?.parte || 1_900_000;
  const node = h('div', { class: 'bk' });

  // ---------------------------------------------------------- situação
  const situacao = h('section', { class: 'cartao bk-situacao' });
  function mostrarSituacao(ultimo) {
    const dias = ultimo ? Math.floor((Date.now() - Date.parse(ultimo.verificadoEm || ultimo.criadoEm)) / 86400_000) : null;
    situacao.className = `cartao bk-situacao${!ultimo || dias > 30 ? ' cartao-alerta' : ''}`;
    situacao.replaceChildren(...(ultimo ? [
      h('strong', {}, 'Último backup conferido: ', dataHora(ultimo.geradoEm || ultimo.criadoEm)),
      h('p', { class: 'suave' }, [tamanho(ultimo.bytes), `versão ${ultimo.versaoApp || '?'}`, ultimo.baixadoEm ? `baixado e conferido em ${dataHora(ultimo.baixadoEm)}` : 'ainda não baixado'].join(' · ')),
      dias > 30 ? h('p', {}, `Faz ${dias} dias: crie um backup novo.`) : null,
    ].filter(Boolean) : [h('strong', {}, 'Nenhum backup ainda.'), h('p', {}, 'Crie o primeiro e guarde o arquivo fora deste aparelho (e-mail, nuvem ou pen drive).')]));
  }
  mostrarSituacao(dados.ultimo);
  const emAndamento = dados.emAndamento ? h('p', { class: 'cartao cartao-alerta' }, dados.emAndamento === 'restaurar' ? 'Há uma restauração em andamento nesta conta.' : 'Há um backup em andamento nesta conta.') : null;

  // ---------------------------------------------------------- criar
  const cSenha = campo({ rotulo: 'Senha do backup', tipo: 'password', ajuda: `Pelo menos ${SENHA_MINIMA} caracteres. Sem ela ninguém abre o arquivo, nem o suporte: guarde num lugar seguro.`, atributos: { autocomplete: 'new-password', minlength: SENHA_MINIMA } });
  const cConfirma = campo({ rotulo: 'Repita a senha', tipo: 'password', atributos: { autocomplete: 'new-password' } });
  const botaoCriar = h('button', { class: 'btn btn-primario', type: 'submit' }, icone(ICONES.baixar), 'Criar backup agora');
  const progCriar = andamento();
  const resultadoCriar = h('div', { 'aria-live': 'polite' });
  const formCriar = h('form', { class: 'cartao bk-bloco', novalidate: true },
    h('h2', {}, 'Criar backup agora'),
    h('p', {}, 'Leva tudo desta conta: empresas e parâmetros fiscais, certificados digitais (das empresas e do escritório), clientes, serviços, notas emitidas e rascunhos, notas tomadas, os XML oficiais, a posição da busca na Receita, a configuração e as conversas do assistente e o histórico de auditoria.'),
    h('p', { class: 'suave' }, 'O arquivo sai cifrado (AES-256) com a senha que você escolher. O servidor confere o backup antes de entregá-lo, e o aparelho confere de novo o arquivo baixado.'),
    cSenha, cConfirma, botaoCriar, progCriar.node, resultadoCriar);
  formCriar.addEventListener('submit', async (e) => {
    e.preventDefault();
    cSenha.erro(''); cConfirma.erro('');
    const senha = cSenha.entrada.value;
    if ([...senha].length < SENHA_MINIMA) { cSenha.erro(`Use pelo menos ${SENHA_MINIMA} caracteres.`); cSenha.entrada.focus(); return; }
    if (senha !== cConfirma.entrada.value) { cConfirma.erro('As senhas não são iguais.'); cConfirma.entrada.focus(); return; }
    botaoCriar.disabled = true;
    resultadoCriar.replaceChildren();
    try {
      progCriar.etapa('Gerando e conferindo o backup no servidor…');
      const { backup } = await api('POST', '/api/backup', { senha });
      const codigo = await baixarBackup(backup, progCriar);
      progCriar.fim();
      cSenha.entrada.value = ''; cConfirma.entrada.value = '';
      resultadoCriar.replaceChildren(h('div', { class: 'cartao cartao-ok' },
        h('strong', {}, 'Backup criado, conferido e entregue ao navegador para salvar.'),
        h('p', {}, `${backup.nomeArquivo} · ${tamanho(backup.bytes)}`),
        h('p', { class: 'suave bk-codigo' }, `Código de conferência (SHA-256): ${codigo}`),
        h('p', { class: 'suave' }, 'Guarde o arquivo e a senha em lugares diferentes, fora deste aparelho.')));
      await recarregarHistorico();
    } catch (err) {
      progCriar.fim();
      resultadoCriar.replaceChildren(h('p', { class: 'cartao cartao-erro', role: 'alert' }, h('strong', {}, 'O backup não foi concluído. '), mensagemDe(err)));
    } finally { botaoCriar.disabled = false; }
  });

  // ---------------------------------------------------------- restaurar
  let arquivo = null;
  const entrada = h('input', { type: 'file', accept: '.nsbackup,application/json,application/octet-stream', id: 'bk-arquivo' });
  entrada.addEventListener('change', () => { arquivo = entrada.files[0] || null; previa.replaceChildren(); });
  const cSenhaR = campo({ rotulo: 'Senha do backup', tipo: 'password', atributos: { autocomplete: 'current-password' } });
  const botaoConferir = h('button', { class: 'btn btn-primario', type: 'submit' }, 'Conferir arquivo');
  const progR = andamento();
  const previa = h('div', { 'aria-live': 'polite' });
  const formR = h('form', { class: 'cartao bk-bloco', novalidate: true },
    h('h2', {}, 'Restaurar backup'),
    h('p', { class: 'cartao cartao-alerta' }, h('strong', {}, 'A restauração substitui todos os dados desta conta pelos do backup. '),
      'Antes de trocar, o app confere o arquivo inteiro e guarda um backup de segurança do estado atual. Se algo falhar no meio, nada muda.'),
    h('label', { for: 'bk-arquivo' }, 'Arquivo de backup (.nsbackup)'), entrada,
    cSenhaR, botaoConferir, progR.node, previa);
  formR.addEventListener('submit', async (e) => {
    e.preventDefault();
    cSenhaR.erro('');
    if (!arquivo) { aviso('Escolha o arquivo de backup.'); return; }
    if (!cSenhaR.entrada.value) { cSenhaR.erro('Informe a senha do backup.'); return; }
    if (arquivo.size > (dados.limites?.maxArquivo || Infinity)) { aviso('O arquivo passa do tamanho máximo de um backup.'); return; }
    botaoConferir.disabled = true;
    previa.replaceChildren();
    try {
      progR.etapa('Lendo o arquivo…');
      const texto = await arquivo.text();
      if (!texto.startsWith('{"tipo":"nota-sem-stress/backup"')) throw new Error('Este arquivo não é um backup do Nota Sem Stress.');
      progR.etapa('Calculando o código de conferência (SHA-256)…');
      const codigo = await sha256Hex(texto);
      const partes = Math.max(1, Math.ceil(texto.length / PARTE));
      const { backup } = await api('POST', '/api/backup/envios', { nome: arquivo.name, bytes: texto.length, sha256: codigo, partes });
      for (let i = 0; i < partes; i++) {
        progR.etapa(`Enviando o arquivo: parte ${i + 1} de ${partes}…`, { feito: i, total: partes });
        await api('PUT', `/api/backup/${encodeURIComponent(backup.id)}/partes/${i}`, { dados: texto.slice(i * PARTE, (i + 1) * PARTE) });
      }
      await conferirEMostrar(backup.id, cSenhaR.entrada.value);
    } catch (err) {
      progR.fim();
      previa.replaceChildren(h('p', { class: 'cartao cartao-erro', role: 'alert' }, h('strong', {}, 'O arquivo não pode ser restaurado. '), mensagemDe(err), ' Nada foi mudado nos seus dados.'));
    } finally { botaoConferir.disabled = false; }
  });

  // Conferência no servidor (senha, integridade, versão, conflitos) e o que vai mudar. Nada é alterado aqui.
  async function conferirEMostrar(id, senha) {
    progR.etapa('Conferindo o arquivo no servidor (senha, integridade e versão)…');
    const c = await api('POST', `/api/backup/${encodeURIComponent(id)}/conferir`, { senha });
    progR.fim();
    const linhas = ['prestadores', 'notas', 'notas_tomadas', 'clientes', 'servicos', 'certificados', 'certificados_procurador', 'ia_conversas']
      .map((k) => h('tr', {}, h('th', { scope: 'row' }, ROTULOS[k]), h('td', {}, String(c.conteudo.contagens[k] ?? 0)), h('td', {}, String(c.atual.contagens[k] ?? 0))));
    const perde = c.atual.foraDoBackup;
    const alertas = [
      perde?.notas ? h('li', {}, `${plural(perde.notas, 'nota que está no app agora não está', 'notas que estão no app agora não estão')} no backup${perde.emitidas ? ` (${perde.emitidas} emitida(s))` : ''}: elas saem do app, continuam na Receita, voltam na próxima busca na Receita e ficam no backup de segurança.`) : null,
      perde?.emAberto ? h('li', {}, `${plural(perde.emAberto, 'nota está', 'notas estão')} com envio em aberto agora: confira a situação delas antes, se possível.`) : null,
      perde?.empresas?.length ? h('li', {}, `Empresas que saem da conta (não estão no backup): ${perde.empresas.join(', ')}.`) : null,
      !c.mesmaConta && c.contaOrigem ? h('li', {}, `Este backup veio de outra conta${c.contaOrigem.email ? ` (${c.contaOrigem.email})` : ''}.`) : null,
      ...(c.avisos || []).slice(0, 5).map((a) => h('li', {}, a)),
    ].filter(Boolean);
    const confirma = h('input', { type: 'checkbox', id: 'bk-confirma' });
    const cPalavra = campo({ rotulo: 'Digite RESTAURAR para confirmar', atributos: { autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' } });
    const botao = h('button', { class: 'btn btn-perigo', type: 'button', disabled: true }, 'Restaurar agora');
    const habilitar = () => { botao.disabled = !(confirma.checked && cPalavra.entrada.value.trim().toUpperCase() === 'RESTAURAR' && c.podeRestaurar); };
    confirma.addEventListener('change', habilitar);
    cPalavra.entrada.addEventListener('input', habilitar);
    const resultado = h('div', { 'aria-live': 'polite' });
    botao.addEventListener('click', async () => {
      botao.disabled = true; confirma.disabled = true;
      try {
        progR.etapa('Criando o backup de segurança e restaurando… Não feche esta tela.');
        const r = await api('POST', `/api/backup/${encodeURIComponent(id)}/restaurar`, { senha, confirmacao: 'RESTAURAR' });
        progR.fim();
        cSenhaR.entrada.value = '';
        resultado.replaceChildren(h('div', { class: 'cartao cartao-ok' },
          h('strong', {}, 'Restauração concluída e conferida.'),
          h('p', {}, `${plural(r.contagens.prestadores, 'empresa', 'empresas')}, ${plural(r.contagens.notas, 'nota', 'notas')}, ${plural(r.contagens.notas_tomadas, 'nota tomada', 'notas tomadas')} e ${plural(r.contagens.clientes, 'cliente', 'clientes')}, idênticos ao backup.`),
          h('p', { class: 'suave' }, `O estado anterior ficou guardado no backup de segurança de ${dataHora(r.seguranca.geradoEm)} (mesma senha).`),
          h('div', { class: 'bk-acoes' },
            h('button', { class: 'btn', type: 'button', onclick: (ev) => baixarSeguranca(r.seguranca, ev.currentTarget) }, icone(ICONES.baixar), 'Baixar o backup de segurança'),
            h('a', { class: 'btn btn-primario', href: '#/empresas' }, 'Ir para as empresas'))));
        await carregarConta({ permitirOffline: false }).catch(() => {});
        await recarregarHistorico();
      } catch (err) {
        progR.fim();
        const seg = err instanceof ErroApi ? err.dados?.seguranca : null;
        resultado.replaceChildren(h('div', { class: 'cartao cartao-erro', role: 'alert' },
          h('strong', {}, 'A restauração não foi feita. '), mensagemDe(err),
          seg ? h('p', {}, 'O backup de segurança do estado atual foi criado e está no histórico abaixo.') : null));
        confirma.disabled = false; habilitar();
        await recarregarHistorico();
      }
    });
    previa.replaceChildren(h('section', { class: 'cartao bk-previa' },
      h('h3', {}, 'Arquivo conferido'),
      h('p', {}, `Backup de ${dataHora(c.conteudo.geradoEm)} · versão ${c.versaoApp || '?'} · formato ${c.formato} · integridade e senha conferidas.`),
      h('ul', { class: 'bk-empresas' }, c.conteudo.empresas.map((e) => h('li', {}, h('strong', {}, e.nome || 'Empresa'), ` ${e.documento} · ${plural(e.notas, 'nota', 'notas')} · ${plural(e.tomadas, 'tomada', 'tomadas')}${e.certificado ? ' · com certificado' : ''}`))),
      h('div', { class: 'ia-tabela' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', { scope: 'col' }, 'No backup'), h('th', { scope: 'col' }, 'Agora na conta'))), h('tbody', {}, linhas))),
      c.conflitos.total ? h('p', { class: 'cartao cartao-erro' }, h('strong', {}, 'Não dá para restaurar nesta conta: '), 'parte destes dados já existe em outra conta deste servidor (por exemplo, a conta de onde o backup saiu). Restaure na conta de origem.') : null,
      alertas.length ? h('div', { class: 'cartao cartao-alerta' }, h('strong', {}, 'Atenção'), h('ul', {}, alertas)) : null,
      h('label', { class: 'caixa', for: 'bk-confirma' }, confirma, h('span', {}, 'Entendo que os dados atuais desta conta serão substituídos pelos deste backup.')),
      cPalavra, botao, resultado));
    previa.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function baixarSeguranca(b, botao) {
    if (botao) botao.disabled = true;
    try { await baixarBackup(b); aviso('Backup de segurança conferido e entregue ao navegador.'); } catch (err) { aviso(mensagemDe(err), 7000); } finally { if (botao) botao.disabled = false; }
  }

  // ---------------------------------------------------------- histórico
  const historico = h('ul', { class: 'lista bk-historico' });
  function item(b) {
    const marcas = [
      b.verificadoEm ? h('span', { class: 'marcador marcador-ok' }, 'Conferido') : null,
      b.baixadoEm ? h('span', { class: 'marcador' }, `Baixado ${dataHora(b.baixadoEm)}`) : null,
      b.restauradoEm ? h('span', { class: 'marcador' }, `Restaurado ${dataHora(b.restauradoEm)}`) : null,
      b.situacao === 'removido' ? h('span', { class: 'marcador' }, 'Arquivo não guardado mais no servidor') : null,
    ].filter(Boolean);
    const acoes = b.disponivel ? h('div', { class: 'bk-acoes' },
      h('button', { class: 'btn btn-pequeno', type: 'button', onclick: (ev) => baixarSeguranca(b, ev.currentTarget) }, icone(ICONES.baixar), 'Baixar'),
      h('button', { class: 'btn btn-pequeno', type: 'button', 'aria-expanded': 'false', onclick: (ev) => {
        // Senha num campo mascarado, ali mesmo no item (nunca numa janela que mostra o que é digitado).
        const li = ev.currentTarget.closest('li');
        const aberto = li.querySelector('.bk-senha-item');
        if (aberto) { aberto.remove(); ev.currentTarget.setAttribute('aria-expanded', 'false'); return; }
        ev.currentTarget.setAttribute('aria-expanded', 'true');
        const cS = campo({ rotulo: 'Senha deste backup', tipo: 'password', atributos: { autocomplete: 'current-password' } });
        const ir = h('button', { class: 'btn btn-primario btn-pequeno', type: 'submit' }, 'Conferir para restaurar');
        const f = h('form', { class: 'bk-senha-item', novalidate: true }, cS, ir);
        f.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (!cS.entrada.value) { cS.erro('Informe a senha do backup.'); return; }
          ir.disabled = true;
          formR.scrollIntoView({ behavior: 'smooth', block: 'start' });
          try { await conferirEMostrar(b.id, cS.entrada.value); f.remove(); } catch (err) {
            progR.fim();
            previa.replaceChildren(h('p', { class: 'cartao cartao-erro', role: 'alert' }, mensagemDe(err), ' Nada foi mudado nos seus dados.'));
          } finally { ir.disabled = false; }
        });
        li.append(f);
        cS.entrada.focus();
      } }, 'Restaurar'),
      h('button', { class: 'btn btn-pequeno btn-texto', type: 'button', onclick: async () => {
        if (!window.confirm('Excluir este backup do servidor? O arquivo que você já baixou continua com você.')) return;
        try { await api('DELETE', `/api/backup/${encodeURIComponent(b.id)}`); await recarregarHistorico(); } catch (err) { aviso(mensagemDe(err)); }
      } }, 'Excluir')) : null;
    return h('li', { class: 'bk-item' },
      h('div', {}, h('strong', {}, TIPOS[b.tipo] || 'Backup'), ' · ', dataHora(b.geradoEm || b.criadoEm)),
      h('div', { class: 'suave' }, [tamanho(b.bytes), b.versaoApp ? `versão ${b.versaoApp}` : null,
        b.resumo ? `${plural(b.resumo.empresas, 'empresa', 'empresas')}, ${plural(b.resumo.notas, 'nota', 'notas')}` : null, `SHA-256 ${b.sha256.slice(0, 12)}…`].filter(Boolean).join(' · ')),
      marcas.length ? h('div', { class: 'marcadores' }, marcas) : null, acoes);
  }
  function mostrarHistorico(lista) {
    historico.replaceChildren(...(lista.length ? lista.map(item) : [h('li', { class: 'suave' }, 'Nenhum backup ainda.')]));
  }
  async function recarregarHistorico() {
    try { const d = await api('GET', '/api/backup'); mostrarHistorico(d.backups); mostrarSituacao(d.ultimo); } catch { /* sem conexão: mantém a lista */ }
  }
  mostrarHistorico(dados.backups);

  node.append(situacao, ...(emAndamento ? [emAndamento] : []), formCriar, formR,
    h('section', { class: 'bk-bloco' }, h('h2', {}, 'Histórico'),
      h('p', { class: 'suave' }, `O servidor guarda o arquivo dos ${dados.limites?.manterManuais || 5} backups mais recentes e dos ${dados.limites?.manterSeguranca || 3} últimos backups de segurança; os anteriores ficam só no histórico. Mantenha sempre uma cópia baixada.`),
      historico));
  return { titulo: 'Backup e Restauração', aba: 'conta', voltar: true, node };
}
