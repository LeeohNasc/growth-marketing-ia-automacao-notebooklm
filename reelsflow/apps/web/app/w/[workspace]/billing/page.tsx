import type { Metadata } from "next";
import { formatBytes } from "@reelsflow/domain";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PAID_PLANS, PLAN_CATALOG, formatBRL, planLabel } from "@/lib/billing/catalog";
import { billingConfig } from "@/lib/billing/server";
import { CheckoutStatus } from "./checkout-status";

export const metadata: Metadata = { title: "Assinatura" };

const PLATFORM: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", youtube: "YouTube" };

type Usage = {
  limits: { seats: number; accounts_per_platform: number; social_accounts?: number; videos: number; storage_bytes: number };
  seats: number;
  accounts_total?: number;
  videos: number;
  storage_bytes: number;
  accounts_by_platform: Record<string, number>;
};

function Meter({ label, used, limit, format = (n: number) => n.toLocaleString("pt-BR") }: { label: string; used: number; limit: number; format?: (n: number) => string }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 1;
  const tone = ratio >= 1 ? "bg-destructive" : ratio >= 0.8 ? "bg-warning" : "bg-primary";
  return (
    <div className="grid gap-1.5">
      <div className="flex justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {format(used)} de {format(limit)}
          {ratio >= 1 && <span className="ml-1 font-medium text-destructive">· limite atingido</span>}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-primary/15" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

const PROVIDER_STATUS: Record<string, string> = {
  active: "Ativa",
  trialing: "Em teste",
  past_due: "Pagamento em atraso (acesso mantido em carência)",
  unpaid: "Não paga (plano suspenso)",
  canceled: "Cancelada",
  incomplete: "Pagamento pendente",
  incomplete_expired: "Pagamento não concluído",
  paused: "Pausada",
};
const ERRORS: Record<string, string> = {
  forbidden: "Somente o proprietário ou um administrador deste workspace pode gerenciar a assinatura.",
  in_progress: "Já existe um checkout em andamento para este workspace. Conclua-o ou aguarde alguns minutos.",
  price_misconfigured: "O preço deste plano não está configurado corretamente. Nada foi cobrado.",
  plan_unavailable: "Este plano ainda não está disponível para assinatura.",
  unavailable: "A cobrança não está configurada neste ambiente.",
  provider: "Não foi possível falar com a Stripe agora. Tente novamente.",
  no_subscription: "Este workspace não tem assinatura para gerenciar.",
  portal: "Não foi possível abrir o gerenciamento da assinatura (verifique o portal do cliente na Stripe).",
};
const PAID_ACTIVE = ["active", "trialing", "past_due", "unpaid"];
const LABELS = Object.fromEntries(Object.values(PLAN_CATALOG).map((p) => [p.key, p.name]));

export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ checkout?: string; billing_error?: string; billing_notice?: string }>;
}) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const { workspace, role } = await requireWorkspace(slug);
  const supabase = await createClient();
  const [{ data: sub }, { data: usage }] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("plan, status, provider_status, current_period_end, cancel_at_period_end, billing_interval")
      .eq("workspace_id", workspace.id)
      .maybeSingle(),
    supabase.rpc("workspace_usage", { p_workspace: workspace.id }),
  ]);
  const u = usage as Usage | null;
  const canManage = role === "owner" || role === "admin";
  const hasPaid = Boolean(sub?.provider_status && PAID_ACTIVE.includes(sub.provider_status));
  const configured = billingConfig().configured;

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Assinatura</h1>

      {sp.checkout === "success" && <CheckoutStatus workspaceId={workspace.id} initialPlan={sub?.plan ?? "starter"} labels={LABELS} />}
      {sp.checkout === "canceled" && <Alert>Pagamento cancelado. Nenhuma cobrança foi feita e o plano não mudou.</Alert>}
      {sp.billing_error && <Alert variant="destructive">{ERRORS[sp.billing_error] ?? "Não foi possível concluir a operação."}</Alert>}
      {sp.billing_notice === "manage" && <Alert>Este workspace já tem uma assinatura ativa. Use “Gerenciar assinatura” para trocar de plano ou cancelar.</Alert>}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Plano {planLabel(sub?.plan)}
            {configured && <Badge variant="outline">Cobrança em modo de teste</Badge>}
          </CardTitle>
          <CardDescription>
            {sub?.provider_status ? (
              <>
                Assinatura: {PROVIDER_STATUS[sub.provider_status] ?? sub.provider_status}
                {sub.current_period_end && hasPaid && (
                  <>
                    {" "}
                    · {sub.cancel_at_period_end ? "termina em" : "renova em"} {new Date(sub.current_period_end).toLocaleDateString("pt-BR")}
                  </>
                )}
              </>
            ) : (
              "Sem assinatura paga. Nada é cobrado neste workspace."
            )}
          </CardDescription>
        </CardHeader>
        {u && (
          <CardContent className="grid gap-5">
            {typeof u.limits.social_accounts === "number" && (
              <Meter label="Contas sociais (todas as redes)" used={u.accounts_total ?? 0} limit={u.limits.social_accounts} />
            )}
            <Meter label="Membros e convites" used={u.seats} limit={u.limits.seats} />
            <Meter label="Vídeos na biblioteca" used={u.videos} limit={u.limits.videos} />
            <Meter label="Armazenamento" used={u.storage_bytes} limit={u.limits.storage_bytes} format={formatBytes} />
            {Object.keys(PLATFORM).map((p) => (
              <Meter key={p} label={`Contas ${PLATFORM[p]}`} used={u.accounts_by_platform[p] ?? 0} limit={u.limits.accounts_per_platform} />
            ))}
            <p className="text-xs text-muted-foreground">
              Marcas: recurso planejado, ainda sem limite aplicado. Contas simuladas não contam no limite. Vídeos na lixeira contam no armazenamento até
              serem apagados. Limites de vídeos e armazenamento dos planos pagos são provisórios.
            </p>
          </CardContent>
        )}
      </Card>

      {canManage && configured && hasPaid && (
        <Card>
          <CardHeader>
            <CardTitle>Gerenciar assinatura</CardTitle>
            <CardDescription>Trocar de plano, atualizar o cartão ou cancelar, no portal seguro da Stripe.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action="/api/billing/portal" method="post">
              <input type="hidden" name="workspace" value={workspace.id} />
              <Button type="submit">Gerenciar assinatura</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {canManage && configured && !hasPaid && (
        <Card>
          <CardHeader>
            <CardTitle>Assinar um plano (teste)</CardTitle>
            <CardDescription>Sandbox da Stripe: use um cartão de teste. O plano é liberado só após a confirmação do pagamento ao servidor.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            {PAID_PLANS.map((key) => {
              const p = PLAN_CATALOG[key];
              return (
                <form key={key} action="/api/billing/checkout" method="post" className="grid gap-2 rounded-lg border p-3">
                  <input type="hidden" name="workspace" value={workspace.id} />
                  <input type="hidden" name="plan" value={key} />
                  <input type="hidden" name="interval" value="month" />
                  <span className="font-medium">{p.name}</span>
                  <span className="text-sm">{formatBRL(p.prices.month!)}/mês</span>
                  <span className="text-xs text-muted-foreground">
                    {p.limits.socialAccounts} conta(s) social(is) · {p.limits.seats} {p.limits.seats === 1 ? "usuário" : "membros"}
                  </span>
                  <Button type="submit" size="sm" variant={key === "business" ? "default" : "outline"}>
                    Assinar {p.name}
                  </Button>
                </form>
              );
            })}
          </CardContent>
        </Card>
      )}
      {!canManage && <p className="text-sm text-muted-foreground">Somente o proprietário ou um administrador pode alterar a assinatura deste workspace.</p>}
    </div>
  );
}
