import type { BillingDb } from "./core";

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

/** Mapeamento comum das funções SQL (também usado pelos testes com `pg`). */
export function pgStyleBillingDb(rpc: Rpc): BillingDb {
  return {
    beginCheckout: async (a) =>
      (await rpc("billing_begin_checkout", { p_workspace: a.workspaceId, p_user: a.userId, p_plan: a.plan, p_interval: a.interval, p_price: a.priceId })) as never,
    setCustomer: async (ws, c) => void (await rpc("billing_set_customer", { p_workspace: ws, p_customer: c })),
    checkoutUpdate: async (id, status, session, url, expiresAt) =>
      void (await rpc("billing_checkout_update", { p_checkout: id, p_status: status, p_session: session ?? null, p_url: url ?? null, p_expires_at: expiresAt ?? null })),
    checkoutBySession: async (session, status) => void (await rpc("billing_checkout_by_session", { p_session: session, p_status: status })),
    eventBegin: async (e) =>
      (await rpc("billing_event_begin", { p_event: e.id, p_type: e.type, p_created: e.created, p_livemode: e.livemode, p_object: e.objectId })) as never,
    eventFinish: async (id, status, ws, note) =>
      void (await rpc("billing_event_finish", { p_event: id, p_status: status, p_workspace: ws ?? null, p_note: note ?? null })),
    applySubscription: async (a) =>
      (await rpc("billing_apply_subscription", {
        p_workspace: a.workspaceId,
        p_customer: a.customerId,
        p_subscription: a.subscriptionId,
        p_price: a.priceId,
        p_plan: a.plan,
        p_interval: a.interval,
        p_provider_status: a.providerStatus,
        p_period_end: a.periodEnd,
        p_cancel_at_period_end: a.cancelAtPeriodEnd,
        p_observed_at: a.observedAt,
      })) as string,
    workspaceForCustomer: async (c) => ((await rpc("billing_workspace_for_customer", { p_customer: c })) as string | null) ?? null,
  };
}

