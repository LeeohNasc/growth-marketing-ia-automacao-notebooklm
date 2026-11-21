import "server-only";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import type { BillingDb, PriceConfig, StripeGateway } from "./core";
import { pgStyleBillingDb, type Rpc } from "./db";

/**
 * Configuração e adaptadores do servidor. Segredos SOMENTE no servidor (nunca NEXT_PUBLIC_).
 * Esta primeira versão recusa chaves de produção: só funciona com sk_test_/rk_test_.
 */
export function billingConfig() {
  const secret = process.env.STRIPE_SECRET_KEY ?? "";
  const prices: PriceConfig = {
    pro: { month: process.env.STRIPE_PRICE_PRO_MONTHLY || undefined },
    business: { month: process.env.STRIPE_PRICE_BUSINESS_MONTHLY || undefined },
    premium: { month: process.env.STRIPE_PRICE_PREMIUM_MONTHLY || undefined },
  };
  const testKey = /^(sk|rk)_test_/.test(secret);
  return {
    configured: testKey && createAdminClient() !== null,
    liveKeyRejected: secret !== "" && !testKey,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    prices,
  };
}

let client: Stripe | null = null;
export function stripeClient(): Stripe {
  const secret = process.env.STRIPE_SECRET_KEY ?? "";
  if (!/^(sk|rk)_test_/.test(secret)) throw new Error("Stripe não configurada em modo de teste.");
  client ??= new Stripe(secret, {
    appInfo: { name: "ReelsFlow" },
    maxNetworkRetries: 2,
    // Ambientes atrás de proxy HTTP: STRIPE_HTTP_CLIENT=fetch (padrão: cliente https do SDK).
    ...(process.env.STRIPE_HTTP_CLIENT === "fetch" ? { httpClient: Stripe.createFetchHttpClient() } : {}),
  });
  return client;
}

export function stripeGateway(stripe: Stripe = stripeClient()): StripeGateway {
  return {
    retrievePrice: async (id) => {
      const p = await stripe.prices.retrieve(id);
      return { id: p.id, active: p.active, currency: p.currency, unit_amount: p.unit_amount, type: p.type, recurring: p.recurring };
    },
    retrieveSubscription: async (id) => {
      const s = await stripe.subscriptions.retrieve(id);
      return {
        id: s.id,
        status: s.status,
        customer: typeof s.customer === "string" ? s.customer : s.customer.id,
        metadata: s.metadata,
        cancel_at_period_end: s.cancel_at_period_end,
        items: {
          data: s.items.data.map((it) => ({
            current_period_end: it.current_period_end,
            price: {
              id: it.price.id,
              active: it.price.active,
              currency: it.price.currency,
              unit_amount: it.price.unit_amount,
              type: it.price.type,
              recurring: it.price.recurring,
            },
          })),
        },
      };
    },
    cancelSubscription: async (id) => {
      await stripe.subscriptions.cancel(id);
    },
    createCustomer: async ({ workspaceId }, idempotencyKey) =>
      (await stripe.customers.create({ metadata: { workspace_id: workspaceId } }, { idempotencyKey })).id,
    createCheckoutSession: async (a, idempotencyKey) => {
      const s = await stripe.checkout.sessions.create(
        {
          mode: "subscription",
          customer: a.customer,
          client_reference_id: a.workspaceId,
          line_items: [{ price: a.price, quantity: 1 }],
          metadata: { workspace_id: a.workspaceId, checkout_id: a.checkoutId, plan: a.plan, interval: a.interval },
          subscription_data: { metadata: { workspace_id: a.workspaceId, checkout_id: a.checkoutId, plan: a.plan } },
          success_url: a.successUrl,
          cancel_url: a.cancelUrl,
          expires_at: a.expiresAt,
          locale: "pt-BR",
          // Cobrança SEMPRE em BRL: sem conversão automática de moeda pela localização do comprador
          // (Adaptive Pricing ligado na conta mostraria e cobraria em USD/outra moeda pelo câmbio).
          adaptive_pricing: { enabled: false },
        },
        { idempotencyKey },
      );
      if (!s.url) throw new Error("Checkout sem URL");
      return { id: s.id, url: s.url, expires_at: s.expires_at };
    },
    expireCheckoutSession: async (id) => {
      await stripe.checkout.sessions.expire(id);
    },
  };
}

/** Cria o portal de gerenciamento da assinatura (trocar cartão, cancelar). */
export async function createPortalUrl(customerId: string, returnUrl: string): Promise<string> {
  const configuration = process.env.STRIPE_PORTAL_CONFIGURATION || undefined;
  const s = await stripeClient().billingPortal.sessions.create({ customer: customerId, return_url: returnUrl, locale: "pt-BR", configuration });
  return s.url;
}

/** Banco via service role (funções billing_*; nenhuma é executável pelo navegador). */
export function supabaseBillingDb(): BillingDb {
  const admin = createAdminClient();
  if (!admin) throw new Error("SUPABASE_SERVICE_ROLE_KEY ausente.");
  const rpc: Rpc = async (fn, args) => {
    const { data, error } = await (admin.rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>)(fn, args);
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    return data;
  };
  return pgStyleBillingDb(rpc);
}

/** Rejeita POST de outra origem (CSRF) nas rotas de cobrança acionadas por formulário. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (!origin || !site) return false;
  try {
    return new URL(origin).origin === new URL(site).origin;
  } catch {
    return false;
  }
}
