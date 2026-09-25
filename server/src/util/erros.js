// Erro de aplicação com mensagem em linguagem comum para o usuário final.
export class ErroApp extends Error {
  constructor(status, mensagem, extra = {}) {
    super(mensagem);
    this.status = status;
    this.extra = extra;
  }
}
export const naoEncontrado = (o = 'Registro') => new ErroApp(404, `${o} não encontrado.`);
export const invalido = (mensagem, campos) => new ErroApp(422, mensagem, campos ? { campos } : {});
