import Stripe from "stripe";
import type { StripeEventLike } from "./core";

// Instância usada SÓ para verificar a assinatura do webhook (HMAC local; não faz chamadas de rede).
const verifier = new Stripe("sk_test_signature_verification_only");

/**
 * Verifica o cabeçalho Stripe-Signature contra o CORPO BRUTO (string exatamente como recebida)
 * e o segredo do endpoint (whsec_…). Tolerância padrão da Stripe: 300 s. Lança erro se inválido.
 */
export function verifyStripeEvent(rawBody: string, signature: string | null, secret: string): StripeEventLike {
  if (!signature || !secret) throw new Error("assinatura ausente");
  return verifier.webhooks.constructEvent(rawBody, signature, secret) as unknown as StripeEventLike;
}
