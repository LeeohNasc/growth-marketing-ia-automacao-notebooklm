import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Estado da assinatura do workspace (somente leitura; RLS: membros do workspace). Não altera nada. */
export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get("workspace") ?? "";
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { data } = await supabase
    .from("subscriptions")
    .select("plan, status, provider_status, current_period_end, cancel_at_period_end")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
}
