// Validação de CPF e CNPJ (inclui o CNPJ alfanumérico, aceito pelo leiaute
// oficial a partir do pacote de esquemas v1.01-20260727: padrão [0-9A-Z]{14}).

export const somenteDigitos = (s) => String(s ?? '').replace(/\D/g, '');
export const normalizarCnpj = (s) => String(s ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

export function cpfValido(valor) {
  const c = somenteDigitos(valor);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

export function cnpjValido(valor) {
  const c = normalizarCnpj(valor);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c) || /^(\w)\1{13}$/.test(c)) return false;
  // Valor de cada caractere = código ASCII - 48 (regra do CNPJ alfanumérico; igual ao dígito para 0-9).
  const v = (ch) => ch.charCodeAt(0) - 48;
  const dv = (n) => {
    const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let s = 0;
    for (let i = 0; i < n; i++) s += v(c[i]) * pesos[i];
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
}

// Identifica o tipo pelo tamanho e valida. Retorna { tipo, numero } ou null.
export function lerDocumento(valor) {
  const cnpj = normalizarCnpj(valor);
  if (cnpj.length === 14 && cnpjValido(cnpj)) return { tipo: 'CNPJ', numero: cnpj };
  const cpf = somenteDigitos(valor);
  if (cpf.length === 11 && cpfValido(cpf)) return { tipo: 'CPF', numero: cpf };
  return null;
}

export function formatarDocumento(tipo, n) {
  if (!n) return '';
  if (tipo === 'CPF') return n.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return n.replace(/^(\w{2})(\w{3})(\w{3})(\w{4})(\w{2})$/, '$1.$2.$3/$4-$5');
}

// Mostra só o necessário em listas (proteção de dados).
export function mascararDocumento(tipo, n) {
  if (!n) return '';
  if (tipo === 'CPF') return `***.${n.slice(3, 6)}.${n.slice(6, 9)}-**`;
  return formatarDocumento(tipo, n);
}
