import { NextResponse, type NextRequest } from "next/server";
import { buildAuthUrl } from "@reelsflow/connectors/server";
import { can } from "@reelsflow/domain";
import { metaConfig, metaGraph } from "@/lib/meta";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

/** Inicia o Facebook Login. Somente admin do workspace; state de uso único gravado no banco. */
export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get("w") ?? "";
  const { workspace, role } = await requireWorkspace(slug);
  const back = (notice: string) => NextResponse.redirect(new URL(`/w/${workspace.slug}/accounts?meta=${notice}`, request.nextUrl.origin));
  if (!can(role, "editWorkspaceSettings")) return back("forbidden");
  const cfg = metaConfig();
  if (!cfg) return back("not_configured");
  const supabase = await createClient();
  const { data: state, error } = await supabase.rpc("begin_oauth", { p_workspace: workspace.id, p_provider: "meta" });
  if (error || !state) return back("error");
  return NextResponse.redirect(buildAuthUrl(metaGraph(), cfg, state, { rerequest: request.nextUrl.searchParams.get("rerequest") === "1" }));
}
