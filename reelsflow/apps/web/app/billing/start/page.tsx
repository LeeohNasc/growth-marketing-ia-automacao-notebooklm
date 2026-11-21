import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/logo";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PLAN_CATALOG, formatBRL, isInterval, isPaidPlan, planLabel } from "@/lib/billing/catalog";
import { billingConfig } from "@/lib/billing/server";
import { listMyWorkspaces } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Assinar plano", robots: { index: false } };
export const dynamic = "force-dynamic";

const PAID_ACTIVE = ["active", "trialing", "past_due", "unpaid"];

/**
 * Escolha do workspace para assinar um plano pago (vindo do CTA da landing).
 * Deslogado → login/cadastro preservando a escolha. Sem workspace → cria e volta aqui.
 */
export default async function BillingStartPage({ searchParams }: { searchParams: Promise<{ plan?: string; interval?: string; workspace?: string; error?: string }> }) {
  const sp = await searchParams;
  if (sp.plan === "starter") redirect("/signup");
  const interval = sp.interval ?? "month";
  if (!isPaidPlan(sp.plan) || !isInterval(interval)) redirect("/#planos");
  const plan = sp.plan;
  const self = `/billing/start?plan=${plan}&interval=${interval}`;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
  if (!user) redirect(`/login?next=${encodeURIComponent(self)}`);

  const def = PLAN_CATALOG[plan];
  const price = def.prices[interval];
  const all = await listMyWorkspaces(user.id);
  const manageable = all.filter((w) => w.role === "owner" || w.role === "admin");
  const { data: subs } = manageable.length
    ? await supabase.from("subscriptions").select("workspace_id, plan, provider_status").in("workspace_id", manageable.map((w) => w.id))
    : { data: [] };
  const subOf = (id: string) => subs?.find((s) => s.workspace_id === id);
  const configured = billingConfig().configured;
  const preselected = sp.workspace ?? (manageable.length === 1 ? manageable[0]!.id : undefined);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-4 py-4 sm:px-6">
        <Logo href="/" />
        <Link href="/w" className="text-sm text-muted-foreground hover:text-foreground">
          Ir para o painel
        </Link>
      </header>
      <main className="flex flex-1 justify-center px-4 pb-16 pt-6">
        <div className="grid w-full max-w-lg gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                Assinar o {def.name}
                <Badge variant="outline">Modo de teste</Badge>
              </CardTitle>
              <CardDescription>
                {price != null ? `${formatBRL(price)} por mês` : "Indisponível neste intervalo"} · {def.limits.socialAccounts} conta(s) social(is) ·{" "}
                {def.limits.seats} {def.limits.seats === 1 ? "usuário" : "membros"} · marcas: recurso planejado (ainda não disponível)
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Alert>Ambiente de teste (sandbox da Stripe): nenhum valor é cobrado. Use um cartão de teste da Stripe.</Alert>
              {!configured && <Alert variant="destructive">A cobrança não está configurada neste ambiente.</Alert>}
              {sp.error === "workspace" && <Alert variant="destructive">Escolha um workspace em que você é proprietário ou administrador.</Alert>}

              {manageable.length === 0 ? (
                <div className="grid gap-3">
                  <p className="text-sm text-muted-foreground">
                    Você ainda não administra nenhum workspace. Crie um para assinar o {def.name}; você volta para esta tela em seguida.
                  </p>
                  <Button asChild>
                    <Link href={`/onboarding?next=${encodeURIComponent(self)}`}>Criar workspace</Link>
                  </Button>
                </div>
              ) : (
                <form action="/api/billing/checkout" method="post" className="grid gap-4">
                  <input type="hidden" name="plan" value={plan} />
                  <input type="hidden" name="interval" value={interval} />
                  <fieldset className="grid gap-2">
                    <legend className="mb-1 text-sm font-medium">Confirme o workspace que receberá o plano</legend>
                    {manageable.map((w) => {
                      const s = subOf(w.id);
                      const hasPaid = Boolean(s?.provider_status && PAID_ACTIVE.includes(s.provider_status));
                      return (
                        <label key={w.id} className="flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/10">
                          <span className="flex items-center gap-2">
                            <input type="radio" name="workspace" value={w.id} defaultChecked={w.id === preselected} required />
                            {w.name}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {planLabel(s?.plan)}
                            {hasPaid ? " · assinatura ativa (será aberto o gerenciamento)" : ""}
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                  <Button type="submit" disabled={!configured || price == null}>
                    Ir para o pagamento
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    O plano só é liberado depois que a Stripe confirmar o pagamento ao nosso servidor. Workspaces em que você é editor ou leitor não aparecem aqui.
                  </p>
                </form>
              )}
              {all.length > manageable.length && manageable.length > 0 && (
                <p className="text-xs text-muted-foreground">Para assinar outro workspace, peça ao proprietário ou administrador dele.</p>
              )}
              <Link href={`/onboarding?next=${encodeURIComponent(self)}`} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
                Criar um novo workspace para este plano
              </Link>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
