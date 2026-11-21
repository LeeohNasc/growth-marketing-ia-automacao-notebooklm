/**
 * Catálogo de planos do ReelsFlow — fonte única para landing, painel e servidor.
 * Valores em centavos (BRL). O navegador só escolhe {plano, intervalo}; o price_id vem do servidor
 * (variáveis de ambiente) e é conferido contra estes valores antes de abrir o checkout e antes de ativar.
 * Os LIMITES aplicados ficam no banco (app.plan_defaults); aqui ficam só para exibição e devem bater.
 */
export type PlanKey = "starter" | "pro" | "business" | "premium";
export type PaidPlanKey = Exclude<PlanKey, "starter">;
export type BillingInterval = "month" | "year";

export type PlanDef = {
  key: PlanKey;
  name: string;
  /** centavos por intervalo; null = não vendido nesse intervalo (anual: a definir) */
  prices: Partial<Record<BillingInterval, number>>;
  limits: { socialAccounts: number | null; brands: number | null; seats: number };
};

export const CURRENCY = "brl";

export const PLAN_CATALOG: Record<PlanKey, PlanDef> = {
  starter: { key: "starter", name: "Starter", prices: {}, limits: { socialAccounts: null, brands: null, seats: 1 } },
  pro: { key: "pro", name: "Pro", prices: { month: 9990 }, limits: { socialAccounts: 1, brands: 1, seats: 1 } },
  business: { key: "business", name: "Business", prices: { month: 29990 }, limits: { socialAccounts: 4, brands: 1, seats: 3 } },
  premium: { key: "premium", name: "Premium", prices: { month: 79990 }, limits: { socialAccounts: 12, brands: 3, seats: 6 } },
};

export const PAID_PLANS: PaidPlanKey[] = ["pro", "business", "premium"];

export function isPaidPlan(v: unknown): v is PaidPlanKey {
  return typeof v === "string" && (PAID_PLANS as string[]).includes(v);
}
export function isInterval(v: unknown): v is BillingInterval {
  return v === "month" || v === "year";
}

/** Nome exibido para qualquer código de plano do banco (inclui o legado "agency"). */
export function planLabel(code: string | null | undefined): string {
  if (code === "agency") return "Agency (legado)";
  return (code && PLAN_CATALOG[code as PlanKey]?.name) || "—";
}

export const formatBRL = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
