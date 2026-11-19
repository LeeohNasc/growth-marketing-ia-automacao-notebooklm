/** Mensagens para erros "plan limit: X" do banco. */
export const PLAN_LIMIT_MESSAGES: Record<string, string> = {
  seats: "O plano atual não permite mais membros. Ajuste o plano em Assinatura.",
  videos: "Limite de vídeos do plano atingido. Exclua vídeos ou ajuste o plano.",
  storage_bytes: "Limite de armazenamento do plano atingido.",
  accounts_per_platform: "O plano atual não permite mais contas nesta rede.",
};

export function planLimitMessage(message: string | undefined | null): string | null {
  const m = message?.match(/plan limit: (\w+)/);
  return m ? (PLAN_LIMIT_MESSAGES[m[1]!] ?? "Limite do plano atingido.") : null;
}
