import { NextResponse } from "next/server";
import { handleStripeEvent } from "@/lib/billing/core";
import { billingConfig, stripeGateway, supabaseBillingDb } from "@/lib/billing/server";
import { verifyStripeEvent } from "@/lib/billing/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook da Stripe. A assinatura é verificada sobre o CORPO BRUTO com o segredo do endpoint.
 * Respostas: 200 (tratado ou ignorado), 400 (assinatura inválida), 409/500 (a Stripe reenvia).
 * Logs: só identificadores (evento, tipo, resultado) — nunca chaves, e-mails ou dados de cartão.
 */
export async function POST(request: Request) {
  const cfg = billingConfig();
  if (!cfg.configured || !cfg.webhookSecret) return new NextResponse("Cobrança não configurada.", { status: 503 });
  const raw = await request.text();
  let event;
  try {
    event = verifyStripeEvent(raw, request.headers.get("stripe-signature"), cfg.webhookSecret);
  } catch {
    return new NextResponse("Assinatura inválida.", { status: 400 });
  }
  const out = await handleStripeEvent({ stripe: stripeGateway(), db: supabaseBillingDb(), prices: cfg.prices }, event);
  console.info("[billing] webhook", { event: event.id, type: event.type, http: out.http, result: out.result });
  return NextResponse.json({ received: true, result: out.result }, { status: out.http });
}
