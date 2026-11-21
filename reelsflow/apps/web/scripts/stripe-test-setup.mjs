#!/usr/bin/env node
/**
 * Prepara o SANDBOX da Stripe para o ReelsFlow (idempotente). Uso:
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-test-setup.mjs
 * - Recusa chave/conta de produção (confere `livemode` na própria API).
 * - Cria (ou reaproveita, por lookup_key) os preços mensais em BRL: Pro 99,90 · Business 299,90 · Premium 799,90.
 * - Cria uma configuração do portal do cliente (cancelar ao fim do período, trocar de plano, cartão, faturas).
 * - Imprime as variáveis para o .env.local (IDs de preço não são segredos; a chave NÃO é impressa).
 */
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY ?? "";
if (!/^(sk|rk)_test_/.test(key)) {
  console.error("Use uma chave de TESTE (sk_test_… ou rk_test_…) em STRIPE_SECRET_KEY.");
  process.exit(1);
}
const stripe = new Stripe(key);
const balance = await stripe.balance.retrieve();
if (balance.livemode) {
  console.error("A chave aponta para o modo de PRODUÇÃO. Abortado.");
  process.exit(1);
}

const PLANS = [
  { plan: "pro", name: "ReelsFlow Pro", amount: 9990 },
  { plan: "business", name: "ReelsFlow Business", amount: 29990 },
  { plan: "premium", name: "ReelsFlow Premium", amount: 79990 },
];
const out = {};
const productPrices = [];
for (const p of PLANS) {
  const lookup = `reelsflow_${p.plan}_monthly`;
  const found = (await stripe.prices.list({ lookup_keys: [lookup], active: true, limit: 1 })).data[0];
  let price = found;
  const ok = (x) => x && x.currency === "brl" && x.unit_amount === p.amount && x.recurring?.interval === "month" && x.recurring?.interval_count === 1;
  if (!ok(price)) {
    price = await stripe.prices.create(
      {
        currency: "brl",
        unit_amount: p.amount,
        recurring: { interval: "month", interval_count: 1 },
        lookup_key: lookup,
        transfer_lookup_key: true,
        product_data: { name: p.name, metadata: { reelsflow_plan: p.plan } },
        metadata: { reelsflow_plan: p.plan, reelsflow_interval: "month" },
      },
      { idempotencyKey: `rf-setup-${lookup}-${p.amount}` },
    );
  }
  out[`STRIPE_PRICE_${p.plan.toUpperCase()}_MONTHLY`] = price.id;
  productPrices.push({ product: typeof price.product === "string" ? price.product : price.product.id, prices: [price.id] });
  console.error(`${p.name}: ${price.id} (${found && ok(found) ? "reaproveitado" : "criado"})`);
}

const portal = await stripe.billingPortal.configurations.create({
  business_profile: { headline: "ReelsFlow — gerencie sua assinatura (modo de teste)" },
  features: {
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: "at_period_end" },
    subscription_update: { enabled: true, default_allowed_updates: ["price"], proration_behavior: "create_prorations", products: productPrices },
  },
  metadata: { reelsflow: "test-setup" },
});
out.STRIPE_PORTAL_CONFIGURATION = portal.id;

console.log("\n# Cole no apps/web/.env.local (modo de teste):");
for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
