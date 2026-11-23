import { NextResponse, type NextRequest } from "next/server";
import { billingConfig, createPortalUrl, sameOrigin } from "@/lib/billing/server";
import { siteUrl } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Gerenciar a assinatura existente (trocar plano/cartão, cancelar) no portal da Stripe. Owner/admin. */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return new NextResponse("Origem não permitida.", { status: 403 });
  const workspaceId = String((await request.formData()).get("workspace") ?? "");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(siteUrl("/login"), 303);
  const { data: m } = await supabase
    .from("workspace_members")
    .select("role, workspaces!inner(slug)")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  const slug = (m?.workspaces as { slug?: string } | null)?.slug;
  if (!m || !slug) return new NextResponse("Não encontrado.", { status: 404 });
  const billingPage = `/w/${slug}/billing`;
  if (m.role !== "owner" && m.role !== "admin") return NextResponse.redirect(siteUrl(`${billingPage}?billing_error=forbidden`), 303);
  const admin = createAdminClient();
  if (!billingConfig().configured || !admin) return NextResponse.redirect(siteUrl(`${billingPage}?billing_error=unavailable`), 303);
  const { data: s } = await admin.from("subscriptions").select("stripe_customer_id").eq("workspace_id", workspaceId).maybeSingle();
  const customer = (s as { stripe_customer_id?: string | null } | null)?.stripe_customer_id;
  if (!customer) return NextResponse.redirect(siteUrl(`${billingPage}?billing_error=no_subscription`), 303);
  try {
    return NextResponse.redirect(await createPortalUrl(customer, siteUrl(billingPage)), 303);
  } catch {
    console.error("[billing] portal", { workspace: workspaceId });
    return NextResponse.redirect(siteUrl(`${billingPage}?billing_error=portal`), 303);
  }
}
