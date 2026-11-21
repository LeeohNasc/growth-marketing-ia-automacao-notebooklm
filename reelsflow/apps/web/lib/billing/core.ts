/**
 * Núcleo da cobrança (Stripe Checkout + Billing). Sem dependência de Next.js nem do cliente
 * Supabase: recebe um "gateway" da Stripe e um "db" (funções billing_* do banco). Assim a MESMA
 * lógica roda em produção e nos testes (Postgres real + Stripe falsa).
 *
 * Regras:
 * - O navegador só escolhe {plano, intervalo}. O price_id vem da configuração do servidor e é
 *   conferido (moeda, valor, recorrência) antes do checkout E antes de ativar.
 * - O plano só muda pelo webhook autenticado, a partir do estado da assinatura RELIDO na Stripe
 *   (eventos podem chegar repetidos e fora de ordem). Visitar a URL de sucesso não muda nada.
 * - O vínculo workspace ↔ cliente Stripe é gravado no servidor no início do checkout (nunca e-mail).
 */
import { CURRENCY, PLAN_CATALOG, type BillingInterval, type PaidPlanKey } from "./catalog";

// ---------------------------------------------------------------------------
// Contratos
// ---------------------------------------------------------------------------
export type PriceLike = {
  id: string;
  active: boolean;
  currency: string;
  unit_amount: number | null;
  type: string;
  recurring: { interval: string; interval_count: number } | null;
};

export type SubscriptionLike = {
  id: string;
  status: string;
  customer: string | { id: string };
  metadata: Record<string, string> | null;
  cancel_at_period_end: boolean;
  items: { data: { price: PriceLike; current_period_end?: number | null }[] };
};

export type StripeEventLike = {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> & { id?: string } };
};

export interface StripeGateway {
  retrievePrice(id: string): Promise<PriceLike>;
  retrieveSubscription(id: string): Promise<SubscriptionLike>;
  cancelSubscription(id: string): Promise<void>;
  createCustomer(args: { workspaceId: string }, idempotencyKey: string): Promise<string>;
  createCheckoutSession(
    args: {
      customer: string;
      price: string;
      workspaceId: string;
      checkoutId: string;
      plan: PaidPlanKey;
      interval: BillingInterval;
      successUrl: string;
      cancelUrl: string;
      expiresAt: number;
    },
    idempotencyKey: string,
  ): Promise<{ id: string; url: string; expires_at: number }>;
  expireCheckoutSession(id: string): Promise<void>;
}

export type BeginResult =
  | { action: "manage"; customer_id: string | null }
  | { action: "reuse"; checkout_id: string; url: string }
  | { action: "replace"; checkout_id: string; session_id: string }
  | { action: "create"; checkout_id: string; customer_id: string | null };

export interface BillingDb {
  beginCheckout(a: { workspaceId: string; userId: string; plan: PaidPlanKey; interval: BillingInterval; priceId: string }): Promise<BeginResult>;
  setCustomer(workspaceId: string, customerId: string): Promise<void>;
  checkoutUpdate(checkoutId: string, status: string, session?: string, url?: string, expiresAt?: string): Promise<void>;
  checkoutBySession(sessionId: string, status: string): Promise<void>;
  eventBegin(e: { id: string; type: string; created: string; livemode: boolean; objectId: string | null }): Promise<"process" | "skip" | "busy">;
  eventFinish(id: string, status: "processed" | "ignored" | "failed", workspaceId?: string | null, note?: string | null): Promise<void>;
  applySubscription(a: {
    workspaceId: string;
    customerId: string;
    subscriptionId: string;
    priceId: string;
    plan: PaidPlanKey;
    interval: BillingInterval;
    providerStatus: string;
    periodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    observedAt: string;
  }): Promise<string>;
  workspaceForCustomer(customerId: string): Promise<string | null>;
}

/** price_id configurado no servidor para cada plano/intervalo (variáveis de ambiente). */
export type PriceConfig = Partial<Record<PaidPlanKey, Partial<Record<BillingInterval, string>>>>;

export class BillingError extends Error {
  constructor(
    public code: "plan_unavailable" | "price_misconfigured" | "forbidden" | "in_progress" | "not_found" | "provider",
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Preço: o price_id configurado precisa ser exatamente o do catálogo
// ---------------------------------------------------------------------------
export function priceMatches(price: PriceLike, plan: PaidPlanKey, interval: BillingInterval): string | null {
  const expected = PLAN_CATALOG[plan].prices[interval];
  if (expected == null) return "intervalo não vendido";
  if (!price.active) return "preço inativo";
  if (price.type !== "recurring" || !price.recurring) return "preço não recorrente";
  if (price.currency.toLowerCase() !== CURRENCY) return `moeda ${price.currency} (esperado ${CURRENCY})`;
  if (price.unit_amount !== expected) return `valor ${price.unit_amount} (esperado ${expected})`;
  if (price.recurring.interval !== interval || price.recurring.interval_count !== 1) {
    return `recorrência ${price.recurring.interval_count}×${price.recurring.interval} (esperado 1×${interval})`;
  }
  return null;
}

/** Plano/intervalo correspondente a um price_id, segundo a configuração do servidor. */
export function planForPrice(cfg: PriceConfig, priceId: string): { plan: PaidPlanKey; interval: BillingInterval } | null {
  for (const [plan, byInterval] of Object.entries(cfg) as [PaidPlanKey, Partial<Record<BillingInterval, string>>][]) {
    for (const [interval, id] of Object.entries(byInterval ?? {}) as [BillingInterval, string][]) {
      if (id && id === priceId) return { plan, interval };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------
export type CheckoutOutcome = { kind: "redirect"; url: string } | { kind: "manage" };

export async function startCheckout(
  deps: { stripe: StripeGateway; db: BillingDb; prices: PriceConfig; now?: () => number },
  a: { userId: string; workspaceId: string; slug: string; plan: PaidPlanKey; interval: BillingInterval; siteUrl: string },
): Promise<CheckoutOutcome> {
  const priceId = deps.prices[a.plan]?.[a.interval];
  if (!priceId) throw new BillingError("plan_unavailable", "Este plano ainda não está disponível para assinatura.");
  let price: PriceLike;
  try {
    price = await deps.stripe.retrievePrice(priceId);
  } catch {
    throw new BillingError("price_misconfigured", "Preço do plano não encontrado na Stripe.");
  }
  const mismatch = priceMatches(price, a.plan, a.interval);
  if (mismatch) throw new BillingError("price_misconfigured", `Preço configurado não confere: ${mismatch}.`);

  let begun = await deps.db.beginCheckout({ workspaceId: a.workspaceId, userId: a.userId, plan: a.plan, interval: a.interval, priceId });
  if (begun.action === "replace") {
    // Havia um checkout aberto para OUTRO plano: encerra-o na Stripe antes de abrir o novo.
    await deps.stripe.expireCheckoutSession(begun.session_id).catch(() => undefined);
    await deps.db.checkoutUpdate(begun.checkout_id, "expired");
    begun = await deps.db.beginCheckout({ workspaceId: a.workspaceId, userId: a.userId, plan: a.plan, interval: a.interval, priceId });
  }
  if (begun.action === "manage") return { kind: "manage" };
  if (begun.action === "reuse") return { kind: "redirect", url: begun.url };
  if (begun.action !== "create") throw new BillingError("in_progress", "Já existe um checkout em andamento para este workspace.");

  const checkoutId = begun.checkout_id;
  try {
    let customer = begun.customer_id;
    if (!customer) {
      customer = await deps.stripe.createCustomer({ workspaceId: a.workspaceId }, `rf-customer-${a.workspaceId}`);
      await deps.db.setCustomer(a.workspaceId, customer);
    }
    const base = new URL(`/w/${a.slug}/billing`, a.siteUrl);
    const nowS = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    const session = await deps.stripe.createCheckoutSession(
      {
        customer,
        price: priceId,
        workspaceId: a.workspaceId,
        checkoutId,
        plan: a.plan,
        interval: a.interval,
        successUrl: `${base.toString()}?checkout=success`,
        cancelUrl: `${base.toString()}?checkout=canceled`,
        expiresAt: nowS + 31 * 60, // mínimo da Stripe: 30 min
      },
      `rf-checkout-${checkoutId}`,
    );
    await deps.db.checkoutUpdate(checkoutId, "open", session.id, session.url, new Date(session.expires_at * 1000).toISOString());
    return { kind: "redirect", url: session.url };
  } catch (err) {
    await deps.db.checkoutUpdate(checkoutId, "failed").catch(() => undefined);
    if (err instanceof BillingError) throw err;
    throw new BillingError("provider", "Não foi possível abrir o checkout. Tente novamente.");
  }
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------
export type WebhookOutcome = { http: 200 | 409 | 500; result: string };

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);
const INVOICE_EVENTS = new Set(["invoice.paid", "invoice.payment_failed", "invoice.payment_succeeded"]);

const idOf = (v: unknown): string | null =>
  typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null;

/** Assinatura de uma fatura (API atual: parent.subscription_details.subscription; antiga: invoice.subscription). */
export function invoiceSubscriptionId(invoice: Record<string, unknown>): string | null {
  const parent = invoice.parent as { subscription_details?: { subscription?: unknown } | null } | null | undefined;
  return idOf(parent?.subscription_details?.subscription) ?? idOf(invoice.subscription);
}

type Handled = { status: "processed" | "ignored"; workspaceId?: string | null; note?: string };

export async function handleStripeEvent(
  deps: { stripe: StripeGateway; db: BillingDb; prices: PriceConfig; allowLivemode?: boolean; now?: () => number },
  event: StripeEventLike,
): Promise<WebhookOutcome> {
  const obj = event.data.object ?? {};
  const begin = await deps.db.eventBegin({
    id: event.id,
    type: event.type,
    created: new Date(event.created * 1000).toISOString(),
    livemode: event.livemode,
    objectId: typeof obj.id === "string" ? obj.id : null,
  });
  if (begin === "skip") return { http: 200, result: "duplicate" };
  if (begin === "busy") return { http: 409, result: "busy" }; // a Stripe reenvia depois

  try {
    let out: Handled;
    if (event.livemode && !deps.allowLivemode) {
      out = { status: "ignored", note: "evento de produção recusado (integração em modo de teste)" };
    } else {
      out = await dispatch(deps, event, obj);
    }
    await deps.db.eventFinish(event.id, out.status, out.workspaceId ?? null, out.note ?? null);
    return { http: 200, result: out.note ?? out.status };
  } catch (err) {
    // Falha temporária (Stripe/banco): registra e devolve 500 para a Stripe tentar de novo.
    await deps.db.eventFinish(event.id, "failed", null, (err as Error).message?.slice(0, 300) ?? "erro").catch(() => undefined);
    return { http: 500, result: "failed" };
  }
}

async function dispatch(
  deps: { stripe: StripeGateway; db: BillingDb; prices: PriceConfig; now?: () => number },
  event: StripeEventLike,
  obj: Record<string, unknown>,
): Promise<Handled> {
  const t = event.type;
  if (t === "checkout.session.completed" || t === "checkout.session.async_payment_succeeded" || t === "checkout.session.async_payment_failed") {
    if (typeof obj.id === "string") await deps.db.checkoutBySession(obj.id, t.endsWith("failed") ? "failed" : "completed");
    const sub = idOf(obj.subscription);
    if (!sub) return { status: "ignored", note: "checkout sem assinatura" };
    return syncSubscription(deps, sub);
  }
  if (t === "checkout.session.expired") {
    if (typeof obj.id === "string") await deps.db.checkoutBySession(obj.id, "expired");
    return { status: "processed", note: "checkout expirado/cancelado: nada liberado" };
  }
  if (SUBSCRIPTION_EVENTS.has(t)) {
    const sub = idOf(obj.id);
    return sub ? syncSubscription(deps, sub) : { status: "ignored", note: "evento sem assinatura" };
  }
  if (INVOICE_EVENTS.has(t)) {
    const sub = invoiceSubscriptionId(obj);
    return sub ? syncSubscription(deps, sub) : { status: "ignored", note: "fatura sem assinatura" };
  }
  return { status: "ignored", note: `tipo não tratado: ${t}` };
}

/** Relê a assinatura na Stripe e aplica ao workspace vinculado ao CLIENTE (não ao e-mail). */
async function syncSubscription(
  deps: { stripe: StripeGateway; db: BillingDb; prices: PriceConfig; now?: () => number },
  subscriptionId: string,
): Promise<Handled> {
  const observedAt = new Date(deps.now?.() ?? Date.now()).toISOString();
  const sub = await deps.stripe.retrieveSubscription(subscriptionId);
  const customer = idOf(sub.customer);
  if (!customer) return { status: "ignored", note: "assinatura sem cliente" };
  const workspaceId = await deps.db.workspaceForCustomer(customer);
  if (!workspaceId) return { status: "ignored", note: `cliente ${customer} não vinculado a workspace` };
  const metaWs = sub.metadata?.workspace_id;
  if (metaWs && metaWs !== workspaceId) {
    return { status: "ignored", workspaceId, note: "metadados da assinatura apontam outro workspace: recusado" };
  }
  if (sub.items.data.length !== 1) return { status: "ignored", workspaceId, note: "assinatura com itens inesperados" };
  const item = sub.items.data[0]!;
  const match = planForPrice(deps.prices, item.price.id);
  if (!match) return { status: "ignored", workspaceId, note: `preço ${item.price.id} fora do catálogo: nada liberado` };
  const mismatch = priceMatches(item.price, match.plan, match.interval);
  if (mismatch) return { status: "ignored", workspaceId, note: `preço contratado não confere (${mismatch}): nada liberado` };

  const result = await deps.db.applySubscription({
    workspaceId,
    customerId: customer,
    subscriptionId: sub.id,
    priceId: item.price.id,
    plan: match.plan,
    interval: match.interval,
    providerStatus: sub.status,
    periodEnd: item.current_period_end ? new Date(item.current_period_end * 1000).toISOString() : null,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    observedAt,
  });
  if (result === "duplicate") {
    // Segunda assinatura paga no mesmo workspace (ex.: duas abas antigas): mantém a vigente e cancela esta.
    await deps.stripe.cancelSubscription(sub.id);
    return { status: "processed", workspaceId, note: `assinatura duplicada ${sub.id} cancelada` };
  }
  return { status: "processed", workspaceId, note: `${result}: ${match.plan}/${sub.status}` };
}
