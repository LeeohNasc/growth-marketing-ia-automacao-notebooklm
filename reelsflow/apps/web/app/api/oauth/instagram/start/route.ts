import { NextResponse, type NextRequest } from "next/server";
import { buildInstagramAuthUrl } from "@reelsflow/connectors/server";
import { can } from "@reelsflow/domain";
import { instagramConfig } from "@/lib/instagram";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

/**
 * Inicia o Instagram Login (Instagram API with Instagram Login). Somente admin do workspace.
 * O state é aleatório, de uso único, amarrado ao usuário e ao workspace, e expira em 15 min.
 * O ReelsFlow nunca vê a senha: o login acontece no instagram.com.
 */
export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get("w") ?? "";
  const { workspace, role } = await requireWorkspace(slug);
  const back = (notice: string) => NextResponse.redirect(new URL(`/w/${workspace.slug}/accounts?ig=${notice}`, request.nextUrl.origin));
  if (!can(role, "editWorkspaceSettings")) return back("forbidden");
  const cfg = instagramConfig();
  if (!cfg) return back("not_configured");
  const supabase = await createClient();
  const { data: state, error } = await supabase.rpc("begin_oauth", { p_workspace: workspace.id, p_provider: "instagram" });
  if (error || !state) return back("error");
  return NextResponse.redirect(buildInstagramAuthUrl(cfg, state));
}
