/** Traduz códigos do Supabase Auth em mensagens claras, sem revelar se um e-mail existe. */
export function authErrorMessage(code: string | undefined, fallback = "Não foi possível concluir. Tente novamente."): string {
  switch (code) {
    case "invalid_credentials":
      return "E-mail ou senha incorretos.";
    case "email_not_confirmed":
      return "Confirme seu e-mail antes de entrar. Verifique sua caixa de entrada.";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "Muitas tentativas. Aguarde alguns minutos e tente novamente.";
    case "weak_password":
      return "Senha fraca. Use uma senha mais longa, com letras e números.";
    case "same_password":
      return "A nova senha deve ser diferente da atual.";
    case "signup_disabled":
      return "Cadastros estão temporariamente desativados.";
    default:
      return fallback;
  }
}
