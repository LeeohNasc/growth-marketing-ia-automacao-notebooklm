#!/usr/bin/env node
/**
 * SOMENTE DESENVOLVIMENTO/SANDBOX — alternativa ao `stripe listen` quando a Stripe não alcança o app local.
 * Lê os eventos REAIS da conta de teste (GET /v1/events) e os entrega no webhook local, assinados com
 * STRIPE_WEBHOOK_SECRET (o mesmo que o app usa). Recusa conta de produção.
 *   STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRET=whsec_… node scripts/stripe-event-relay.mjs http://127.0.0.1:3000/api/billing/webhook
 */
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY ?? "";
const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const target = process.argv[2];
if (!/^(sk|rk)_test_/.test(key) || !secret || !target) {
  console.error("Uso: STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRET=whsec_… node scripts/stripe-event-relay.mjs <url-do-webhook>");
  process.exit(1);
}
const stripe = new Stripe(key, process.env.STRIPE_HTTP_CLIENT === "fetch" ? { httpClient: Stripe.createFetchHttpClient() } : {});
if ((await stripe.balance.retrieve()).livemode) {
  console.error("Conta de PRODUÇÃO: abortado.");
  process.exit(1);
}
const since = Math.floor(Date.now() / 1000) - Number(process.env.RELAY_LOOKBACK_S ?? 0);
const seen = new Set();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
log(`relay ativo → ${target} (eventos desde ${new Date(since * 1000).toISOString()})`);

async function deliver(ev) {
  const payload = JSON.stringify(ev);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(target, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload }).catch((e) => ({ status: 0, text: async () => String(e) }));
    const body = await res.text();
    log(ev.id, ev.type, "→", res.status, body.slice(0, 140));
    if (res.status === 200) return;
    await new Promise((r) => setTimeout(r, 1500 * attempt)); // 409/500: reenvia como a Stripe faria
  }
}

for (;;) {
  const page = await stripe.events.list({ created: { gte: since }, limit: 100 });
  const fresh = page.data.filter((e) => !seen.has(e.id)).reverse(); // mais antigos primeiro
  for (const ev of fresh) {
    seen.add(ev.id);
    await deliver(ev);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
