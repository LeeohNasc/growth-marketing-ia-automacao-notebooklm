import { NextResponse, type NextRequest } from "next/server";
import { parseSignedRequest } from "@reelsflow/connectors/server";
import { siteUrl } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Callback de exclusão de dados da Meta (obrigatório para o App Review).
 * Valida o signed_request (HMAC-SHA256 com o app secret), remove credenciais e
 * dados das contas do titular e retorna { url, confirmation_code }.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.META_APP_SECRET;
  const admin = createAdminClient();
  if (!secret || !admin) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const form = await request.formData().catch(() => null);
  const payload = parseSignedRequest(String(form?.get("signed_request") ?? ""), secret);
  if (!payload) return NextResponse.json({ error: "invalid_signed_request" }, { status: 400 });
  const { data: code, error } = await admin.rpc("meta_data_deletion", { p_meta_user_id: payload.user_id });
  if (error || !code) return NextResponse.json({ error: "failed" }, { status: 500 });
  return NextResponse.json({ url: siteUrl(`/data-deletion/${code}`), confirmation_code: code });
}
