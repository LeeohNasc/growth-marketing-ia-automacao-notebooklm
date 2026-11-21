import { NextResponse, type NextRequest } from "next/server";
import { BillingError, startCheckout } from "@/lib/billing/core";
import { isInterval, isPaidPlan } from "@/lib/billing/catalog";
import { billingConfig, sameOrigin, stripeGateway, supabaseBillingDb } from "@/lib/billing/server";
import { siteUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * POST (formulário): {workspace, plan, interval}. Valida sessão e permissão de cobrança no SERVIDOR,
 * resolve o price_id na configuração do servidor e redireciona ao Stripe Checkout hospedado.
 */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return new NextResponse("Origem não permitida.", { status: 403 });
  const form = await request.formData();
  const workspaceId = String(form.get("workspace") ?? "");
  const plan = form.get("plan");
  const interval = form.get("interval") ?? "month";
  const back = (path: string) => NextResponse.redirect(siteUrl(path), 303);

  if (!isPaidPlan(plan) || !isInterval(interval)) return back("/#planos");
  const start = `/billing/start?plan=${plan}&interval=${interval}`;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return back(`/login?next=${encodeURIComponent(start)}`);

  // O usuário precisa enxergar o workspace (RLS); a permissão de cobrança é conferida no banco.
  const { data: ws } = await supabase.from("workspaces").select("id, slug").eq("id", workspaceId).maybeSingle();
  if (!ws) return back(`${start}&error=workspace`);

  const cfg = billingConfig();
  if (!cfg.configured) return back(`/w/${ws.slug}/billing?billing_error=unavailable`);

  try {
    const out = await startCheckout(
      { stripe: stripeGateway(), db: supabaseBillingDb(), prices: cfg.prices },
      { userId: user.id, workspaceId: ws.id, slug: ws.slug, plan, interval, siteUrl: siteUrl("/") },
    );
    if (out.kind === "manage") return back(`/w/${ws.slug}/billing?billing_notice=manage`);
    return NextResponse.redirect(out.url, 303);
  } catch (err) {
    const code =
      err instanceof BillingError
        ? err.code
        : (err as { code?: string }).code === "42501"
          ? "forbidden"
          : (err as { code?: string }).code === "55P03"
            ? "in_progress"
            : "provider";
    console.error("[billing] checkout", { workspace: ws.id, plan, code });
    return back(`/w/${ws.slug}/billing?billing_error=${code}`);
  }
}
