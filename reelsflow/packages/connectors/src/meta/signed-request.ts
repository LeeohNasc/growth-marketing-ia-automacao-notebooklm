import { createHmac, timingSafeEqual } from "node:crypto";

export type SignedRequestPayload = { algorithm: string; user_id: string; issued_at?: number; expires?: number };

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * Valida o `signed_request` do callback de exclusão de dados da Meta:
 * "<assinatura>.<payload>" em base64url; assinatura = HMAC-SHA256(payload codificado, app secret).
 * Retorna null se inválido.
 */
export function parseSignedRequest(signed: string, appSecret: string): SignedRequestPayload | null {
  if (!signed || !appSecret) return null;
  const dot = signed.indexOf(".");
  if (dot <= 0) return null;
  const encodedSig = signed.slice(0, dot);
  const encodedPayload = signed.slice(dot + 1);
  const sig = b64url(encodedSig);
  const expected = createHmac("sha256", appSecret).update(encodedPayload).digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(b64url(encodedPayload).toString("utf8")) as SignedRequestPayload;
    if (String(payload.algorithm).toUpperCase() !== "HMAC-SHA256" || !payload.user_id) return null;
    return payload;
  } catch {
    return null;
  }
}
