import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  handleStripeEvent,
  startCheckout,
  type PriceConfig,
  type PriceLike,
  type StripeEventLike,
  type StripeGateway,
  type SubscriptionLike,
} from "../../../apps/web/lib/billing/core";
import { pgStyleBillingDb, type Rpc } from "../../../apps/web/lib/billing/db";
import { verifyStripeEvent } from "../../../apps/web/lib/billing/verify";
import { DENIED, addMember, asUser, createUser, createWorkspaceAs, expectPgError, pool, uniqueEmail } from "./helpers";

/**
 * Cobrança: SQL real (funções billing_*, limites, RLS) + núcleo do app (checkout/webhook) com uma
 * Stripe FALSA em memória. Não fala com a Stripe de verdade (isso é o teste em sandbox).
 */
afterAll(async () => {
  await pool.end();
});

// --- banco como service_role (igual ao servidor) -----------------------------
const rpc: Rpc = async (fn, args) => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role service_role");
    const keys = Object.keys(args);
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
    const { rows } = await client.query(sql, keys.map((k) => args[k]));
    await client.query("commit");
    return rows[0]?.r ?? null;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};
const db = pgStyleBillingDb(rpc);

// --- Stripe falsa ------------------------------------------------------------
const PRICES: Record<string, PriceLike> = {
  price_pro: { id: "price_pro", active: true, currency: "brl", unit_amount: 9990, type: "recurring", recurring: { interval: "month", interval_count: 1 } },
  price_business: { id: "price_business", active: true, currency: "brl", unit_amount: 29990, type: "recurring", recurring: { interval: "month", interval_count: 1 } },
  price_premium: { id: "price_premium", active: true, currency: "brl", unit_amount: 79990, type: "recurring", recurring: { interval: "month", interval_count: 1 } },
  price_wrong_amount: { id: "price_wrong_amount", active: true, currency: "brl", unit_amount: 100, type: "recurring", recurring: { interval: "month", interval_count: 1 } },
  price_usd: { id: "price_usd", active: true, currency: "usd", unit_amount: 29990, type: "recurring", recurring: { interval: "month", interval_count: 1 } },
};
const CFG: PriceConfig = { pro: { month: "price_pro" }, business: { month: "price_business" }, premium: { month: "price_premium" } };

let globalSeq = 0; // IDs únicos entre instâncias (como na Stripe real)
class FakeStripe implements StripeGateway {
  customers = 0;
  sessions: { id: string; url: string; customer: string; price: string; key: string; workspaceId: string }[] = [];
  subs = new Map<string, SubscriptionLike>();
  canceled: string[] = [];
  private idem = new Map<string, unknown>();
  failNextRetrieve = false;

  async retrievePrice(id: string) {
    const p = PRICES[id];
    if (!p) throw new Error("no such price");
    return p;
  }
  async retrieveSubscription(id: string) {
    if (this.failNextRetrieve) {
      this.failNextRetrieve = false;
      throw new Error("Stripe indisponível (simulado)");
    }
    const s = this.subs.get(id);
    if (!s) throw new Error("no such subscription");
    return structuredClone(s);
  }
  async cancelSubscription(id: string) {
    this.canceled.push(id);
    const s = this.subs.get(id);
    if (s) s.status = "canceled";
  }
  async createCustomer(_a: { workspaceId: string }, key: string) {
    if (this.idem.has(key)) return this.idem.get(key) as string;
    this.customers += 1;
    const id = `cus_${++globalSeq}`;
    this.idem.set(key, id);
    return id;
  }
  async createCheckoutSession(a: Parameters<StripeGateway["createCheckoutSession"]>[0], key: string) {
    if (this.idem.has(key)) return this.idem.get(key) as { id: string; url: string; expires_at: number };
    const id = `cs_test_${++globalSeq}`;
    const s = { id, url: `https://checkout.stripe.test/${id}`, expires_at: a.expiresAt };
    this.sessions.push({ id, url: s.url, customer: a.customer, price: a.price, key, workspaceId: a.workspaceId });
    this.idem.set(key, s);
    return s;
  }
  async expireCheckoutSession() {}

  /** Simula o cliente concluindo o checkout: cria a assinatura com o status dado. */
  subscribe(session: { customer: string; price: string; workspaceId: string }, status = "active", over: Partial<SubscriptionLike> = {}) {
    const id = `sub_${++globalSeq}`;
    this.subs.set(id, {
      id,
      status,
      customer: session.customer,
      metadata: { workspace_id: session.workspaceId },
      cancel_at_period_end: false,
      items: { data: [{ price: PRICES[session.price]!, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
      ...over,
    });
    return id;
  }
}

let evSeq = 0;
const event = (type: string, object: Record<string, unknown>, id = `evt_${Date.now()}_${++evSeq}`): StripeEventLike => ({
  id,
  type,
  created: Math.floor(Date.now() / 1000),
  livemode: false,
  data: { object },
});

const sub = async (ws: string) =>
  (
    await pool.query(
      "select plan, status, provider_status, stripe_customer_id, stripe_subscription_id, cancel_at_period_end, current_period_end from public.subscriptions where workspace_id = $1",
      [ws],
    )
  ).rows[0];
const limits = async (ws: string) => (await pool.query("select app.workspace_limits($1) as l", [ws])).rows[0].l;
const SITE = "http://127.0.0.1:3100";

async function newWs(name: string) {
  const owner = await createUser({ email: uniqueEmail("bill") });
  const w = await createWorkspaceAs(owner, name);
  return { owner, ws: w.id, slug: w.slug };
}

/** Do clique ao checkout: startCheckout + cliente conclui o pagamento na Stripe falsa. */
async function buy(stripe: FakeStripe, a: { owner: string; ws: string; slug: string }, plan: "pro" | "business" | "premium", status = "active") {
  const out = await startCheckout({ stripe, db, prices: CFG }, { userId: a.owner, workspaceId: a.ws, slug: a.slug, plan, interval: "month", siteUrl: SITE });
  expect(out.kind).toBe("redirect");
  const session = stripe.sessions.find((s) => out.kind === "redirect" && s.url === out.url)!;
  const subId = stripe.subscribe(session, status);
  return { session, subId };
}
const deliver = (stripe: FakeStripe, e: StripeEventLike) => handleStripeEvent({ stripe, db, prices: CFG }, e);

// =============================================================================
describe("catálogo e limites no banco", () => {
  it("planos novos com limites propostos; Starter e legado preservados; sobrescrita manual vence", async () => {
    const d = async (p: string) => (await pool.query("select app.plan_defaults($1) as l", [p])).rows[0].l;
    expect(await d("pro")).toMatchObject({ seats: 1, social_accounts: 1 });
    expect(await d("business")).toMatchObject({ seats: 3, social_accounts: 4 });
    expect(await d("premium")).toMatchObject({ seats: 6, social_accounts: 12 });
    expect(await d("starter")).toEqual({ seats: 1, accounts_per_platform: 1, videos: 200, storage_bytes: 10737418240 });
    expect(await d("agency")).toMatchObject({ seats: 20, accounts_per_platform: 50 });
    const { ws } = await newWs("Override");
    await pool.query("update public.subscriptions set plan = 'business', limits = '{\"social_accounts\": 6}' where workspace_id = $1", [ws]);
    expect((await limits(ws)).social_accounts).toBe(6);
  });

  it("Business: até 4 contas no total (várias redes); a 5ª é bloqueada; simuladas não contam", async () => {
    const { owner, ws } = await newWs("Quatro contas");
    await pool.query("update public.subscriptions set plan = 'business' where workspace_id = $1", [ws]);
    const add = (platform: string, ext: string) =>
      pool.query("insert into public.social_accounts (workspace_id, platform, external_account_id, display_name) values ($1,$2,$3,'x')", [ws, platform, ext]);
    await add("instagram", "ig1");
    await add("instagram", "ig2");
    await add("facebook", "fb1");
    await add("youtube", "yt1");
    await expect(add("tiktok", "tt1")).rejects.toThrow("plan limit: social_accounts");
    await asUser(owner, (db) => db.query("select public.create_simulated_account($1, 'S')", [ws]), { commit: true });
    const usage = await asUser(owner, async (db) => (await db.query("select public.workspace_usage($1) as u", [ws])).rows[0].u);
    expect(usage).toMatchObject({ accounts_total: 4, limits: { social_accounts: 4 } });
  });

  it("5ª conta em tentativas SIMULTÂNEAS: só uma entra", async () => {
    const { ws } = await newWs("Concorrência");
    await pool.query("update public.subscriptions set plan = 'business' where workspace_id = $1", [ws]);
    for (const e of ["a", "b", "c"]) {
      await pool.query("insert into public.social_accounts (workspace_id, platform, external_account_id, display_name) values ($1,'instagram',$2,'x')", [ws, e]);
    }
    const tryAdd = async (ext: string) => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("insert into public.social_accounts (workspace_id, platform, external_account_id, display_name) values ($1,'facebook',$2,'x')", [ws, ext]);
        await new Promise((r) => setTimeout(r, 150)); // mantém a transação aberta
        await c.query("commit");
        return "ok";
      } catch (e) {
        await c.query("rollback");
        return (e as Error).message;
      } finally {
        c.release();
      }
    };
    const results = await Promise.all([tryAdd("x1"), tryAdd("x2"), tryAdd("x3")]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "plan limit: social_accounts")).toHaveLength(2);
    expect((await pool.query("select count(*)::int as n from public.social_accounts where workspace_id = $1", [ws])).rows[0].n).toBe(4);
  });

  it("Pro: 1 conta e 1 usuário (convite bloqueado); Premium: 6 assentos", async () => {
    const { owner, ws } = await newWs("Pro limites");
    await pool.query("update public.subscriptions set plan = 'pro' where workspace_id = $1", [ws]);
    await pool.query("insert into public.social_accounts (workspace_id, platform, external_account_id, display_name) values ($1,'instagram','p1','x')", [ws]);
    await expect(
      pool.query("insert into public.social_accounts (workspace_id, platform, external_account_id, display_name) values ($1,'facebook','p2','x')", [ws]),
    ).rejects.toThrow("plan limit");
    const err = await asUser(owner, (db) => db.query("select public.create_invitation($1, $2, 'editor')", [ws, uniqueEmail("pro-inv")])).catch((e) => e);
    expect(err.message).toBe("plan limit: seats");
    await pool.query("update public.subscriptions set plan = 'premium' where workspace_id = $1", [ws]);
    for (let i = 0; i < 5; i++) await asUser(owner, (db) => db.query("select public.create_invitation($1, $2, 'editor')", [ws, uniqueEmail(`pr${i}`)]), { commit: true });
    const err2 = await asUser(owner, (db) => db.query("select public.create_invitation($1, $2, 'editor')", [ws, uniqueEmail("pr6")])).catch((e) => e);
    expect(err2.message).toBe("plan limit: seats");
  });

  it("navegador não executa funções de cobrança nem lê identificadores da Stripe", async () => {
    const { owner, ws } = await newWs("Sem acesso");
    await expectPgError(
      asUser(owner, (d) => d.query("select public.billing_begin_checkout($1, $2, 'business', 'month', 'price_business')", [ws, owner])),
      DENIED,
    );
    await expectPgError(
      asUser(owner, (d) => d.query("select public.billing_apply_subscription($1,'c','s','p','business','month','active',null,false,now())", [ws])),
      DENIED,
    );
    await expectPgError(asUser(owner, (d) => d.query("select stripe_customer_id from public.subscriptions")), DENIED);
    await expectPgError(asUser(owner, (d) => d.query("update public.subscriptions set plan = 'business' where workspace_id = $1", [ws])), DENIED);
    await expectPgError(asUser(owner, (d) => d.query("select * from public.billing_events")), DENIED);
    const own = await asUser(owner, (d) => d.query("select plan, status, provider_status from public.subscriptions where workspace_id = $1", [ws]));
    expect(own.rows[0]).toEqual({ plan: "starter", status: "active", provider_status: null });
  });
});

// =============================================================================
describe("checkout", () => {
  it("só owner/admin iniciam; editor e usuário de outro workspace não", async () => {
    const stripe = new FakeStripe();
    const a = await newWs("Permissões");
    const editor = await createUser({ email: uniqueEmail("ed") });
    const admin = await createUser({ email: uniqueEmail("adm") });
    const outsider = (await newWs("Outro")).owner;
    await addMember(a.ws, editor, "editor");
    await addMember(a.ws, admin, "admin");
    const go = (userId: string) => startCheckout({ stripe, db, prices: CFG }, { userId, workspaceId: a.ws, slug: a.slug, plan: "business", interval: "month", siteUrl: SITE });
    await expect(go(editor)).rejects.toThrow("permission denied");
    await expect(go(outsider)).rejects.toThrow("permission denied");
    expect(stripe.customers).toBe(0);
    expect((await go(admin)).kind).toBe("redirect");
  });

  it("preço configurado errado (valor/moeda) não abre checkout; plano anual indisponível", async () => {
    const stripe = new FakeStripe();
    const a = await newWs("Preço");
    const go = (prices: PriceConfig, interval: "month" | "year" = "month") =>
      startCheckout({ stripe, db, prices }, { userId: a.owner, workspaceId: a.ws, slug: a.slug, plan: "business", interval, siteUrl: SITE });
    await expect(go({ business: { month: "price_wrong_amount" } })).rejects.toThrow(/valor 100/);
    await expect(go({ business: { month: "price_usd" } })).rejects.toThrow(/moeda usd/);
    await expect(go(CFG, "year")).rejects.toThrow(/não está disponível/);
    expect(stripe.sessions).toHaveLength(0);
  });

  it("clique repetido / reenvio: mesma sessão; concorrente: nunca duas sessões", async () => {
    const stripe = new FakeStripe();
    const a = await newWs("Duplo clique");
    const go = () => startCheckout({ stripe, db, prices: CFG }, { userId: a.owner, workspaceId: a.ws, slug: a.slug, plan: "business", interval: "month", siteUrl: SITE });
    const first = await go();
    const again = await go();
    expect(again).toEqual(first);
    const parallel = await Promise.allSettled([go(), go(), go()]);
    for (const r of parallel) {
      if (r.status === "fulfilled") expect(r.value).toEqual(first);
      else expect(String(r.reason)).toMatch(/em andamento|in progress/);
    }
    expect(stripe.sessions).toHaveLength(1);
    expect(stripe.customers).toBe(1);
    const s = stripe.sessions[0]!;
    expect(s.price).toBe("price_business");
    expect((await sub(a.ws)).stripe_customer_id).toBe(s.customer);
  });

  it("trocar de plano com checkout aberto encerra o anterior e abre o novo", async () => {
    const stripe = new FakeStripe();
    const a = await newWs("Troca");
    const go = (plan: "pro" | "premium") => startCheckout({ stripe, db, prices: CFG }, { userId: a.owner, workspaceId: a.ws, slug: a.slug, plan, interval: "month", siteUrl: SITE });
    await go("pro");
    await go("premium");
    expect(stripe.sessions.map((s) => s.price)).toEqual(["price_pro", "price_premium"]);
    const open = (await pool.query("select stripe_price_id from public.billing_checkout_sessions where workspace_id = $1 and status = 'open'", [a.ws])).rows;
    expect(open).toEqual([{ stripe_price_id: "price_premium" }]);
  });
});

// =============================================================================
describe("webhook: ativação somente pelo servidor", () => {
  const stripe = new FakeStripe();

  for (const [plan, accounts, seats] of [["pro", 1, 1], ["business", 4, 3], ["premium", 12, 6]] as const) {
    it(`${plan}: pago → plano ativo só no workspace da compra; os demais intactos`, async () => {
      const a = await newWs(`Compra ${plan}`);
      const b = await newWs(`Vizinho ${plan}`);
      const { session, subId } = await buy(stripe, a, plan);
      // Antes do webhook nada muda (visitar a URL de sucesso não altera o plano).
      expect((await sub(a.ws)).plan).toBe("starter");
      const r = await deliver(stripe, event("checkout.session.completed", { id: session.id, subscription: subId, payment_status: "paid" }));
      expect(r.http).toBe(200);
      expect(await sub(a.ws)).toMatchObject({ plan, status: "active", provider_status: "active", stripe_subscription_id: subId });
      expect(await limits(a.ws)).toMatchObject({ social_accounts: accounts, seats });
      expect((await sub(b.ws)).plan).toBe("starter");
      expect(await limits(b.ws)).toEqual({ seats: 1, accounts_per_platform: 1, videos: 200, storage_bytes: 10737418240 });
      const st = (await pool.query("select status from public.billing_checkout_sessions where stripe_session_id = $1", [session.id])).rows[0];
      expect(st.status).toBe("completed");
    });
  }

  it("pagamento pendente (incomplete) e checkout expirado/cancelado não liberam", async () => {
    const a = await newWs("Pendente");
    const { session, subId } = await buy(stripe, a, "business", "incomplete");
    await deliver(stripe, event("checkout.session.completed", { id: session.id, subscription: subId, payment_status: "unpaid" }));
    expect(await sub(a.ws)).toMatchObject({ plan: "starter", provider_status: "incomplete" });
    // expira sem pagar
    stripe.subs.get(subId)!.status = "incomplete_expired";
    await deliver(stripe, event("customer.subscription.updated", { id: subId }));
    expect((await sub(a.ws)).plan).toBe("starter");

    const c = await newWs("Cancelou");
    const out = await startCheckout({ stripe, db, prices: CFG }, { userId: c.owner, workspaceId: c.ws, slug: c.slug, plan: "pro", interval: "month", siteUrl: SITE });
    const s = stripe.sessions.find((x) => out.kind === "redirect" && x.url === out.url)!;
    await deliver(stripe, event("checkout.session.expired", { id: s.id }));
    expect((await sub(c.ws)).plan).toBe("starter");
    // depois de cancelar, pode tentar de novo (nova sessão)
    const retry = await startCheckout({ stripe, db, prices: CFG }, { userId: c.owner, workspaceId: c.ws, slug: c.slug, plan: "pro", interval: "month", siteUrl: SITE });
    expect(retry.kind === "redirect" && retry.url).not.toBe(s.url);
  });

  it("pagamento pendente que depois é confirmado libera (async_payment_succeeded)", async () => {
    const a = await newWs("Boleto");
    const { session, subId } = await buy(stripe, a, "pro", "incomplete");
    await deliver(stripe, event("checkout.session.completed", { id: session.id, subscription: subId, payment_status: "unpaid" }));
    expect((await sub(a.ws)).plan).toBe("starter");
    stripe.subs.get(subId)!.status = "active";
    await deliver(stripe, event("checkout.session.async_payment_succeeded", { id: session.id, subscription: subId }));
    expect((await sub(a.ws)).plan).toBe("pro");
  });

  it("evento repetido é ignorado; não duplica nem muda limites", async () => {
    const a = await newWs("Repetido");
    const { session, subId } = await buy(stripe, a, "business");
    const e = event("invoice.paid", { id: "in_1", parent: { type: "subscription_details", subscription_details: { subscription: subId } } });
    expect((await deliver(stripe, e)).result).toMatch(/applied/);
    const before = await sub(a.ws);
    expect((await deliver(stripe, e)).result).toBe("duplicate");
    expect((await deliver(stripe, e)).result).toBe("duplicate");
    expect(await sub(a.ws)).toEqual(before);
    const n = (await pool.query("select attempts, status from public.billing_events where event_id = $1", [e.id])).rows[0];
    expect(n).toEqual({ attempts: 1, status: "processed" });
    expect(session).toBeTruthy();
  });

  it("fora de ordem, renovação, falha, carência e cancelamento", async () => {
    const a = await newWs("Ciclo");
    const { subId } = await buy(stripe, a, "business");
    const s = stripe.subs.get(subId)!;
    // 1) "updated" chega ANTES do checkout.session.completed: o estado relido já é o atual
    await deliver(stripe, event("customer.subscription.updated", { id: subId }));
    expect((await sub(a.ws)).plan).toBe("business");
    // 2) renovação paga: novo fim de período
    s.items.data[0]!.current_period_end = Math.floor(Date.now() / 1000) + 60 * 86400;
    await deliver(stripe, event("invoice.paid", { id: "in_r", parent: { subscription_details: { subscription: subId } } }));
    const renewed = await sub(a.ws);
    expect(new Date(renewed.current_period_end).getTime()).toBeGreaterThan(Date.now() + 50 * 86400_000);
    // 3) falha de pagamento: past_due mantém o plano (carência), dados intactos
    await pool.query("insert into public.social_accounts (workspace_id, platform, external_account_id, display_name) values ($1,'instagram','keep','x')", [a.ws]);
    s.status = "past_due";
    await deliver(stripe, event("invoice.payment_failed", { id: "in_f", parent: { subscription_details: { subscription: subId } } }));
    expect(await sub(a.ws)).toMatchObject({ plan: "business", status: "past_due", provider_status: "past_due" });
    // 4) evento ANTIGO chega atrasado (fatura paga de antes): relê → continua past_due (não "ressuscita")
    await deliver(stripe, event("invoice.paid", { id: "in_old", parent: { subscription_details: { subscription: subId } } }));
    expect((await sub(a.ws)).status).toBe("past_due");
    // 5) cancelamento ao fim do período sinalizado
    s.status = "active";
    s.cancel_at_period_end = true;
    await deliver(stripe, event("customer.subscription.updated", { id: subId }));
    expect(await sub(a.ws)).toMatchObject({ plan: "business", cancel_at_period_end: true });
    // 6) cancelada: volta ao Starter; conteúdo e contas permanecem
    s.status = "canceled";
    await deliver(stripe, event("customer.subscription.deleted", { id: subId }));
    expect(await sub(a.ws)).toMatchObject({ plan: "starter", status: "active", provider_status: "canceled" });
    expect((await pool.query("select count(*)::int n from public.social_accounts where workspace_id = $1", [a.ws])).rows[0].n).toBe(1);
    // 7) um "updated" atrasado de quando estava ativa não reativa: o estado relido é canceled
    await deliver(stripe, event("customer.subscription.updated", { id: subId }));
    expect((await sub(a.ws)).plan).toBe("starter");
  });

  it("falha temporária: 500 para a Stripe reenviar; o reenvio conclui", async () => {
    const a = await newWs("Retry");
    const { subId } = await buy(stripe, a, "pro");
    const e = event("customer.subscription.created", { id: subId });
    stripe.failNextRetrieve = true;
    expect((await deliver(stripe, e)).http).toBe(500);
    expect((await sub(a.ws)).plan).toBe("starter");
    expect((await deliver(stripe, e)).http).toBe(200);
    expect((await sub(a.ws)).plan).toBe("pro");
    const row = (await pool.query("select attempts, status from public.billing_events where event_id = $1", [e.id])).rows[0];
    expect(row).toEqual({ attempts: 2, status: "processed" });
  });

  it("segunda assinatura paga no mesmo workspace é cancelada; a vigente permanece", async () => {
    const a = await newWs("Duas abas");
    const { subId } = await buy(stripe, a, "business");
    await deliver(stripe, event("customer.subscription.created", { id: subId }));
    // assinatura extra criada para o mesmo cliente (ex.: checkout antigo em outra aba)
    const customer = (await sub(a.ws)).stripe_customer_id;
    const extra = stripe.subscribe({ customer, price: "price_premium", workspaceId: a.ws }, "active");
    const r = await deliver(stripe, event("customer.subscription.created", { id: extra }));
    expect(r.result).toMatch(/duplicada/);
    expect(stripe.canceled).toContain(extra);
    expect(await sub(a.ws)).toMatchObject({ plan: "business", stripe_subscription_id: subId });
    // com assinatura vigente, novo checkout vira "gerenciar"
    const again = await startCheckout({ stripe, db, prices: CFG }, { userId: a.owner, workspaceId: a.ws, slug: a.slug, plan: "premium", interval: "month", siteUrl: SITE });
    expect(again).toEqual({ kind: "manage" });
  });

  it("preço fora do catálogo, cliente desconhecido ou metadados de outro workspace: nada liberado", async () => {
    const a = await newWs("Fraude");
    const b = await newWs("Alvo");
    const { session } = await buy(stripe, a, "pro");
    // preço trocado para um que não está na configuração
    const bad = stripe.subscribe({ customer: session.customer, price: "price_wrong_amount", workspaceId: a.ws });
    expect((await deliver(stripe, event("customer.subscription.created", { id: bad }))).result).toMatch(/fora do catálogo/);
    // metadados apontando o workspace B (o vínculo vale pelo CLIENTE gravado no servidor)
    const meta = stripe.subscribe({ customer: session.customer, price: "price_premium", workspaceId: b.ws });
    expect((await deliver(stripe, event("customer.subscription.created", { id: meta }))).result).toMatch(/outro workspace/);
    // cliente que nenhum workspace criou
    const orphan = stripe.subscribe({ customer: "cus_desconhecido", price: "price_premium", workspaceId: b.ws });
    expect((await deliver(stripe, event("customer.subscription.created", { id: orphan }))).result).toMatch(/não vinculado/);
    expect((await sub(a.ws)).plan).toBe("starter");
    expect((await sub(b.ws)).plan).toBe("starter");
  });

  it("evento de produção (livemode) é recusado nesta versão", async () => {
    const a = await newWs("Live");
    const { subId } = await buy(stripe, a, "pro");
    const e = { ...event("customer.subscription.created", { id: subId }), livemode: true };
    expect((await deliver(stripe, e)).result).toMatch(/produção recusado/);
    expect((await sub(a.ws)).plan).toBe("starter");
  });

  it("compra que não se concluiu não rebaixa workspace com plano manual/legado", async () => {
    const a = await newWs("Legado");
    await pool.query("update public.subscriptions set plan = 'agency' where workspace_id = $1", [a.ws]);
    const { subId } = await buy(stripe, a, "pro", "incomplete");
    await deliver(stripe, event("customer.subscription.created", { id: subId }));
    stripe.subs.get(subId)!.status = "incomplete_expired";
    await deliver(stripe, event("customer.subscription.updated", { id: subId }));
    expect((await sub(a.ws)).plan).toBe("agency");
  });
});

describe("assinatura do webhook (corpo bruto + segredo)", () => {
  const secret = "whsec_test_local";
  const signer = new Stripe("sk_test_local_only");
  const payload = JSON.stringify({ id: "evt_sig", object: "event", type: "invoice.paid", created: 1, livemode: false, data: { object: {} } });

  it("aceita a assinatura correta e recusa corpo alterado, segredo errado e cabeçalho ausente", () => {
    const header = signer.webhooks.generateTestHeaderString({ payload, secret });
    expect(verifyStripeEvent(payload, header, secret).id).toBe("evt_sig");
    expect(() => verifyStripeEvent(payload.replace("invoice.paid", "invoice.payment_failed"), header, secret)).toThrow();
    expect(() => verifyStripeEvent(payload, header, "whsec_outro")).toThrow();
    expect(() => verifyStripeEvent(payload, null, secret)).toThrow();
    // reformatar o JSON (corpo "parseado" e serializado de novo) invalida — exige o corpo BRUTO
    expect(() => verifyStripeEvent(JSON.stringify(JSON.parse(payload), null, 2), header, secret)).toThrow();
  });

  it("recusa assinatura antiga (fora da tolerância de 300 s)", () => {
    const old = signer.webhooks.generateTestHeaderString({ payload, secret, timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(() => verifyStripeEvent(payload, old, secret)).toThrow();
  });
});

beforeAll(() => undefined);
