// Backup e restauração de uma conta, de ponta a ponta.
//
// Criar:     retrato consistente da conta → arquivo cifrado com a senha → o servidor ABRE o arquivo e confere tudo
//            (SHA-256, manifesto, tipos, referências) → guarda em partes → relê do banco e confere o SHA-256 →
//            só então responde "pronto". O aparelho baixa as partes e confere o SHA-256 de novo antes de salvar.
// Restaurar: arquivo inteiro conferido (tamanho, SHA-256, senha, tag GCM, conteúdo, versão, conflitos) ANTES de
//            mexer em qualquer coisa → backup de segurança do estado atual, verificado e guardado → numa ÚNICA
//            transação: apaga só esta conta, insere o backup, relê e compara com o backup → COMMIT. Qualquer
//            falha (inclusive queda no meio) desfaz tudo e os dados atuais ficam como estavam.
import { randomBytes } from 'node:crypto';
import { agora, novoId } from '../db/banco.js';
import { cifrar, decifrar } from '../security/cripto.js';
import { auditar } from '../security/auditoria.js';
import { ErroApp, invalido, naoEncontrado } from '../util/erros.js';
import { abrirArquivo, conferirSenha, criarArquivo, lerCabecalho, sha256, EXTENSAO, FORMATO, MAX_ARQUIVO, CORROMPIDO } from './formato.js';
import { ESQUEMA, aplicarPlano, conflitosComOutrasContas, estadoAtual, exportarConta, resumoDoPlano, validarConteudo, verificarRestauracao } from './dados.js';

export const PARTE = 1_900_000;                 // caracteres por parte (abaixo dos 4,5 MB por requisição da Vercel)
const TRAVA_MS = 15 * 60_000;                   // operação que cair no meio libera a conta sozinha depois disso
const ENVIO_EXPIRA_MS = 24 * 3600_000;
const MAX_HISTORICO = 60;

const versaoApp = () => process.env.npm_package_version || '0.1.0';
const nomeArquivo = (iso, tipo) => `nota-sem-stress_${tipo === 'seguranca' ? 'seguranca_' : ''}backup_${iso.slice(0, 16).replace('T', '_').replace(':', '-')}${EXTENSAO}`;
const conflito = (mensagem, codigo) => new ErroApp(409, mensagem, { codigo });

export function criarServicoBackup({ db, emissao }, { sondas = {}, manterManuais = Number(process.env.NOTAVEZ_BACKUPS_GUARDADOS || 5), manterSeguranca = 3, app = versaoApp() } = {}) {
  // ---------------------------------------------------------- trava por conta
  async function travar(usuarioId, operacao) {
    const token = randomBytes(16).toString('hex');
    const agoraMs = Date.now();
    await db.run(`INSERT INTO backup_operacoes (usuario_id, operacao, token, expira_em) VALUES (?,?,?,?)
      ON CONFLICT (usuario_id) DO UPDATE SET operacao = excluded.operacao, token = excluded.token, expira_em = excluded.expira_em
      WHERE backup_operacoes.expira_em < ?`, usuarioId, operacao, token, agoraMs + TRAVA_MS, agoraMs);
    const atual = await db.get('SELECT operacao, token FROM backup_operacoes WHERE usuario_id = ?', usuarioId);
    if (atual?.token !== token) {
      throw conflito(atual?.operacao === 'restaurar' ? 'Há uma restauração em andamento nesta conta. Aguarde terminar.' : 'Há um backup em andamento nesta conta. Aguarde terminar.', 'BACKUP_EM_ANDAMENTO');
    }
    return { usuarioId, token };
  }
  const liberar = async (t) => { await db.run('DELETE FROM backup_operacoes WHERE usuario_id = ? AND token = ?', t.usuarioId, t.token).catch(() => {}); };

  // ---------------------------------------------------------- armazenamento
  const publico = (b) => b && {
    id: b.id, tipo: b.tipo, situacao: b.situacao, disponivel: b.situacao === 'guardado', nomeArquivo: b.nome_arquivo, bytes: Number(b.bytes), sha256: b.sha256,
    partes: b.partes, formato: b.formato, esquema: b.esquema, versaoApp: b.versao_app, geradoEm: b.gerado_em, criadoEm: b.criado_em,
    verificadoEm: b.verificado_em, baixadoEm: b.baixado_em, restauradoEm: b.restaurado_em, origemId: b.origem_id,
    resumo: b.resumo ? JSON.parse(b.resumo) : null,
  };
  const linha = async (usuarioId, id) => {
    const b = await db.get('SELECT * FROM backups WHERE id = ? AND usuario_id = ?', String(id || ''), usuarioId);
    if (!b) throw naoEncontrado('Backup');
    return b;
  };

  // Junta as partes guardadas e confere tamanho e SHA-256 do arquivo inteiro.
  async function lerArquivoGuardado(b) {
    if (b.situacao === 'removido') throw new ErroApp(410, 'O arquivo deste backup não está mais guardado no servidor (só o registro no histórico).', { codigo: 'BACKUP_REMOVIDO' });
    const partes = await db.all('SELECT parte, dados_cifrados FROM backup_partes WHERE backup_id = ? ORDER BY parte', b.id);
    if (partes.length !== b.partes || partes.some((p, i) => p.parte !== i)) {
      throw new ErroApp(422, b.situacao === 'recebendo' ? 'O envio do arquivo ainda não terminou (faltam partes). Envie de novo.' : CORROMPIDO, { codigo: 'BACKUP_INCOMPLETO' });
    }
    const texto = partes.map((p) => decifrar(p.dados_cifrados)).join('');
    if (texto.length !== Number(b.bytes) || sha256(texto) !== b.sha256) throw new ErroApp(422, CORROMPIDO, { codigo: 'BACKUP_CORROMPIDO' });
    return texto;
  }

  // Mantém o arquivo dos backups mais recentes; os mais antigos ficam só no histórico.
  async function aplicarRetencao(usuarioId) {
    const lista = await db.all("SELECT id, tipo, situacao, criado_em FROM backups WHERE usuario_id = ? ORDER BY criado_em DESC, id DESC", usuarioId);
    const limite = { manual: manterManuais, seguranca: manterSeguranca };
    const vistos = { manual: 0, seguranca: 0 };
    const venceu = (iso) => Date.now() - Date.parse(iso) > ENVIO_EXPIRA_MS;
    for (const b of lista) {
      let remover = false;
      if (b.situacao === 'guardado' && limite[b.tipo] !== undefined) remover = ++vistos[b.tipo] > limite[b.tipo];
      if (b.tipo === 'enviado' && ['guardado', 'recebendo'].includes(b.situacao) && venceu(b.criado_em)) remover = true;
      if (b.situacao === 'gravando' && venceu(b.criado_em)) remover = true;
      if (remover) {
        await db.transacao(async () => {
          await db.run('DELETE FROM backup_partes WHERE backup_id = ?', b.id);
          await db.run("UPDATE backups SET situacao = 'removido' WHERE id = ?", b.id);
        });
      }
    }
    const excedentes = lista.slice(MAX_HISTORICO).map((b) => b.id);
    for (const id of excedentes) await db.run('DELETE FROM backups WHERE id = ? AND usuario_id = ?', id, usuarioId);
  }

  // Gera, confere e guarda um backup da conta. Só devolve depois de tudo verificado.
  async function gerarEGuardar(usuarioId, senha, tipo, origemId = null) {
    conferirSenha(senha);
    const conteudo = await exportarConta(db, usuarioId, { app });
    const json = JSON.stringify(conteudo);
    const arquivo = await criarArquivo(json, senha, { criadoEm: conteudo.geradoEm, app, esquema: ESQUEMA });
    // Verificação: abre o arquivo exatamente como numa restauração.
    const aberto = await abrirArquivo(arquivo.texto, senha);
    if (aberto.conteudo !== json) throw new ErroApp(500, 'A verificação do backup falhou: o conteúdo aberto não confere com o gerado. Nada foi guardado.', { codigo: 'BACKUP_VERIFICACAO' });
    const plano = validarConteudo(JSON.parse(aberto.conteudo));
    for (const [nome, m] of Object.entries(conteudo.manifesto)) {
      if (plano.tabelas[nome].length !== m.linhas) throw new ErroApp(500, `A verificação do backup falhou em ${nome}. Nada foi guardado.`, { codigo: 'BACKUP_VERIFICACAO' });
    }
    const resumo = resumoDoPlano(plano);
    const contagens = { empresas: resumo.empresas.length, notas: resumo.contagens.notas, tomadas: resumo.contagens.notas_tomadas, clientes: resumo.contagens.clientes, servicos: resumo.contagens.servicos };
    const id = novoId();
    const partes = Math.max(1, Math.ceil(arquivo.texto.length / PARTE));
    const quando = agora();
    await db.run(`INSERT INTO backups (id, usuario_id, tipo, situacao, nome_arquivo, bytes, sha256, partes, formato, esquema, versao_app, gerado_em, resumo, criado_em, origem_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, usuarioId, tipo, 'gravando', nomeArquivo(conteudo.geradoEm, tipo), arquivo.bytes, arquivo.sha256, partes,
    FORMATO, ESQUEMA, app, conteudo.geradoEm, JSON.stringify(contagens), quando, origemId);
    try {
      for (let i = 0; i < partes; i++) {
        await db.run('INSERT INTO backup_partes (backup_id, parte, dados_cifrados) VALUES (?,?,?)', id, i, cifrar(arquivo.texto.slice(i * PARTE, (i + 1) * PARTE)));
      }
      // Relê o que ficou gravado e confere o SHA-256 do arquivo inteiro.
      await lerArquivoGuardado({ ...(await linha(usuarioId, id)), situacao: 'gravando' });
      await db.run("UPDATE backups SET situacao = 'guardado', verificado_em = ? WHERE id = ?", agora(), id);
    } catch (e) {
      await db.run('DELETE FROM backups WHERE id = ?', id).catch(() => {});
      throw e;
    }
    await aplicarRetencao(usuarioId);
    return { backup: await linha(usuarioId, id), resumo, avisos: plano.avisos };
  }

  // Abre e valida um arquivo guardado (sem alterar os dados da conta). Um envio conferido passa a "guardado".
  async function abrirGuardado(usuarioId, id, senha) {
    const b = await linha(usuarioId, id);
    const texto = await lerArquivoGuardado(b);
    const { cabecalho, conteudo } = await abrirArquivo(texto, senha);
    let obj;
    try { obj = JSON.parse(conteudo); } catch { throw new ErroApp(422, CORROMPIDO, { codigo: 'BACKUP_CORROMPIDO' }); }
    const plano = validarConteudo(obj);
    if (b.situacao === 'recebendo') {
      const c = resumoDoPlano(plano).contagens;
      await db.run("UPDATE backups SET situacao = 'guardado', verificado_em = ?, formato = ?, esquema = ?, versao_app = ?, gerado_em = ?, resumo = ? WHERE id = ?",
        agora(), cabecalho.formato, plano.esquema, plano.app, plano.geradoEm,
        JSON.stringify({ empresas: c.prestadores, notas: c.notas, tomadas: c.notas_tomadas, clientes: c.clientes, servicos: c.servicos }), b.id);
    }
    return { b, cabecalho, plano };
  }

  return {
    async listar(usuarioId) {
      const lista = (await db.all('SELECT * FROM backups WHERE usuario_id = ? ORDER BY criado_em DESC, id DESC LIMIT ?', usuarioId, MAX_HISTORICO)).map(publico);
      const operacao = await db.get('SELECT operacao FROM backup_operacoes WHERE usuario_id = ? AND expira_em > ?', usuarioId, Date.now());
      const verificados = lista.filter((b) => ['manual', 'seguranca'].includes(b.tipo) && b.verificadoEm);
      return {
        backups: lista.filter((b) => b.situacao !== 'gravando' && !(b.tipo === 'enviado' && b.situacao === 'recebendo')),
        ultimo: verificados.find((b) => b.tipo === 'manual' && b.baixadoEm) || verificados[0] || null,
        emAndamento: operacao?.operacao || null,
        limites: { parte: PARTE, maxArquivo: MAX_ARQUIVO, senhaMinima: 10, manterManuais, manterSeguranca },
      };
    },

    async criar(usuarioId, senha, ip = null) {
      conferirSenha(senha);
      const trava = await travar(usuarioId, 'backup');
      try {
        const r = await gerarEGuardar(usuarioId, senha, 'manual');
        await auditar(db, { usuarioId, acao: 'backup.criado', entidade: 'backup', entidadeId: r.backup.id, detalhes: { bytes: Number(r.backup.bytes), sha256: r.backup.sha256 }, ip });
        return { backup: publico(r.backup), avisos: r.avisos };
      } catch (e) {
        await auditar(db, { usuarioId, acao: 'backup.falhou', detalhes: { codigo: e.extra?.codigo || null, mensagem: String(e.message).slice(0, 200) }, ip }).catch(() => {});
        throw e;
      } finally { await liberar(trava); }
    },

    async parte(usuarioId, id, n) {
      const b = await linha(usuarioId, id);
      if (b.situacao !== 'guardado') throw new ErroApp(410, 'O arquivo deste backup não está disponível para baixar.', { codigo: 'BACKUP_REMOVIDO' });
      const i = Number(n);
      if (!Number.isInteger(i) || i < 0 || i >= b.partes) throw naoEncontrado('Parte do backup');
      const p = await db.get('SELECT dados_cifrados FROM backup_partes WHERE backup_id = ? AND parte = ?', b.id, i);
      if (!p) throw new ErroApp(422, CORROMPIDO, { codigo: 'BACKUP_INCOMPLETO' });
      return decifrar(p.dados_cifrados);
    },

    // O aparelho baixou todas as partes e o SHA-256 do arquivo montado conferiu.
    async marcarBaixado(usuarioId, id, sha, ip = null) {
      const b = await linha(usuarioId, id);
      if (String(sha || '').toLowerCase() !== b.sha256) throw new ErroApp(422, 'O arquivo baixado não confere com o backup guardado (SHA-256 diferente). Baixe de novo.', { codigo: 'BACKUP_DOWNLOAD_DIVERGENTE' });
      await db.run('UPDATE backups SET baixado_em = ? WHERE id = ?', agora(), b.id);
      await auditar(db, { usuarioId, acao: 'backup.baixado', entidade: 'backup', entidadeId: b.id, ip });
      return publico(await linha(usuarioId, id));
    },

    // Restauração a partir de um arquivo do aparelho: o arquivo chega em partes e fica guardado (cifrado) até ser usado.
    async iniciarEnvio(usuarioId, { nome, bytes, sha256: sha, partes }) {
      const tamanho = Number(bytes);
      if (!Number.isInteger(tamanho) || tamanho <= 0) throw invalido('Arquivo vazio.');
      if (tamanho > MAX_ARQUIVO) throw new ErroApp(413, `O arquivo passa do tamanho máximo de um backup (${Math.round(MAX_ARQUIVO / 1024 / 1024)} MB).`, { codigo: 'BACKUP_GRANDE' });
      if (!/^[0-9a-f]{64}$/.test(String(sha || ''))) throw invalido('SHA-256 do arquivo inválido.');
      if (Number(partes) !== Math.ceil(tamanho / PARTE)) throw invalido('Número de partes inválido.');
      await aplicarRetencao(usuarioId);
      const id = novoId();
      const nomeLimpo = String(nome || `backup${EXTENSAO}`).replace(/[\\/\0-\x1f]/g, '_').slice(0, 120);
      await db.run(`INSERT INTO backups (id, usuario_id, tipo, situacao, nome_arquivo, bytes, sha256, partes, criado_em) VALUES (?,?,?,?,?,?,?,?,?)`,
        id, usuarioId, 'enviado', 'recebendo', nomeLimpo, tamanho, sha, Number(partes), agora());
      return publico(await linha(usuarioId, id));
    },

    async receberParte(usuarioId, id, n, dados) {
      const b = await linha(usuarioId, id);
      if (b.situacao !== 'recebendo') throw conflito('Este envio já foi concluído ou cancelado.', 'BACKUP_ENVIO_FECHADO');
      const i = Number(n);
      if (!Number.isInteger(i) || i < 0 || i >= b.partes) throw invalido('Parte inválida.');
      const esperado = i < b.partes - 1 ? PARTE : Number(b.bytes) - PARTE * (b.partes - 1);
      if (typeof dados !== 'string' || dados.length !== esperado) throw invalido('Parte do arquivo com tamanho inesperado. Envie de novo.');
      if (!/^[\x20-\x7e]*$/.test(dados)) throw new ErroApp(422, 'Este arquivo não é um backup do Nota Sem Stress.', { codigo: 'BACKUP_DESCONHECIDO' });
      if (i === 0) lerCabecalhoParcial(dados);
      await db.run(`INSERT INTO backup_partes (backup_id, parte, dados_cifrados) VALUES (?,?,?)
        ON CONFLICT (backup_id, parte) DO UPDATE SET dados_cifrados = excluded.dados_cifrados`, b.id, i, cifrar(dados));
      const recebidas = Number((await db.get('SELECT count(*) AS n FROM backup_partes WHERE backup_id = ?', b.id)).n);
      return { recebidas, partes: b.partes };
    },

    // Confere o arquivo com a senha e mostra o que ele traz e o que muda (nada é alterado).
    async conferir(usuarioId, id, senha) {
      const { cabecalho, plano } = await abrirGuardado(usuarioId, id, senha);
      const conflitos = await conflitosComOutrasContas(db, usuarioId, plano);
      const atual = await estadoAtual(db, usuarioId, plano);
      return {
        backup: publico(await linha(usuarioId, id)),
        compativel: true, formato: cabecalho.formato, esquema: plano.esquema, versaoApp: plano.app,
        mesmaConta: plano.conta?.id === usuarioId, contaOrigem: plano.conta ? { nome: plano.conta.nome, email: plano.conta.email } : null,
        conteudo: resumoDoPlano(plano), atual, conflitos, avisos: plano.avisos,
        podeRestaurar: conflitos.total === 0,
      };
    },

    async restaurar(usuarioId, id, senha, confirmacao, ip = null) {
      if (confirmacao !== 'RESTAURAR') throw invalido('Para restaurar, confirme digitando RESTAURAR.');
      const trava = await travar(usuarioId, 'restaurar');
      const inicio = Date.now();
      let seguranca = null;
      let concluida = false;
      try {
        // 1) Tudo conferido antes de qualquer alteração.
        const { b, plano } = await abrirGuardado(usuarioId, id, senha);
        const conflitos = await conflitosComOutrasContas(db, usuarioId, plano);
        if (conflitos.total) {
          throw conflito('Parte destes dados já existe em outra conta deste servidor (por exemplo, a conta de onde o backup saiu). Restaure na conta de origem. Nada foi alterado.', 'BACKUP_CONFLITO');
        }
        const emEnvio = await db.get(`SELECT count(*) AS n FROM notas n JOIN prestadores p ON p.id = n.prestador_id
          WHERE p.usuario_id = ? AND n.situacao = 'enviando' AND n.processamento_ate > ?`, usuarioId, agora());
        if (Number(emEnvio?.n)) throw conflito('Há nota sendo enviada à Receita agora. Aguarde o resultado e tente de novo. Nada foi alterado.', 'BACKUP_NOTA_EM_ENVIO');
        // 2) Backup de segurança do estado atual (mesma senha), verificado e guardado ANTES de mexer.
        try {
          seguranca = (await gerarEGuardar(usuarioId, senha, 'seguranca', b.id)).backup;
        } catch (e) {
          throw new ErroApp(e.status && e.status < 500 ? e.status : 500, `Não foi possível criar o backup de segurança do estado atual (${e.message}). A restauração foi cancelada e nada foi alterado.`, { codigo: 'BACKUP_SEGURANCA_FALHOU' });
        }
        await sondas.antesDaTransacao?.();
        // 3) Restauração atômica: apaga, insere, relê e confere; só então COMMIT.
        const empresasAntes = (await db.all('SELECT id FROM prestadores WHERE usuario_id = ?', usuarioId)).map((p) => p.id);
        const verificacao = await db.transacao(async () => {
          await aplicarPlano(db, usuarioId, plano, { sondas });
          await sondas.antesDaVerificacao?.(db);
          return await verificarRestauracao(db, usuarioId, plano, { app });
        });
        // COMMIT feito: daqui para baixo nada pode mudar o resultado informado (falhas aqui só ficam no log).
        concluida = true;
        const segundos = Math.round((Date.now() - inicio) / 1000);
        try {
          for (const p of new Set([...empresasAntes, ...plano.tabelas.prestadores.map((x) => x.id)])) emissao?.fecharClientesDoPrestador?.(p);
          await db.run('UPDATE backups SET restaurado_em = ? WHERE id = ?', agora(), b.id);
          await auditar(db, { usuarioId, acao: 'backup.restaurado', entidade: 'backup', entidadeId: b.id, detalhes: { seguranca: seguranca.id, contagens: verificacao.contagens, segundos }, ip });
          if (b.tipo === 'enviado') await aplicarRetencao(usuarioId);
        } catch (e) { console.error(`[backup] restauração concluída; falha secundária: ${e?.message || e}`); }
        return { ok: true, seguranca: publico(seguranca), contagens: verificacao.contagens, avisos: plano.avisos, segundos };
      } catch (e) {
        if (concluida) throw e; // não acontece: o bloco acima não lança

        await auditar(db, { usuarioId, acao: 'backup.restauracao_falhou', entidade: 'backup', entidadeId: String(id || ''),
          detalhes: { codigo: e.extra?.codigo || e.code || null, mensagem: String(e.message).slice(0, 300), seguranca: seguranca?.id || null }, ip }).catch(() => {});
        if (e instanceof ErroApp) throw Object.assign(e, { extra: { ...e.extra, seguranca: seguranca ? publico(seguranca) : null } });
        // Erro inesperado (banco, rede): a transação foi desfeita.
        throw new ErroApp(500, 'A restauração falhou e foi desfeita: seus dados continuam como estavam.', { codigo: 'BACKUP_RESTAURACAO_FALHOU', seguranca: seguranca ? publico(seguranca) : null });
      } finally { await liberar(trava); }
    },

    async excluir(usuarioId, id) {
      const b = await linha(usuarioId, id);
      await db.run('DELETE FROM backups WHERE id = ? AND usuario_id = ?', b.id, usuarioId);
      return { ok: true };
    },
  };
}

// A primeira parte de um envio já mostra se o arquivo é um backup nosso e de uma versão que dá para abrir.
function lerCabecalhoParcial(inicio) {
  if (!inicio.startsWith('{"tipo":"nota-sem-stress/backup"')) throw new ErroApp(422, 'Este arquivo não é um backup do Nota Sem Stress.', { codigo: 'BACKUP_DESCONHECIDO' });
  const formato = /"formato":(\d+)/.exec(inicio.slice(0, 400));
  if (formato && Number(formato[1]) > FORMATO) lerCabecalho(`{"tipo":"nota-sem-stress/backup","formato":${formato[1]}}`);
}
