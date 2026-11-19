import type { Metadata } from "next";
import { formatBytes } from "@reelsflow/domain";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Assinatura" };

const PLAN_LABELS: Record<string, string> = { starter: "Starter", pro: "Pro", agency: "Agency" };
const PLATFORM: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", youtube: "YouTube" };

type Usage = {
  limits: { seats: number; accounts_per_platform: number; videos: number; storage_bytes: number };
  seats: number;
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

export default async function BillingPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const [{ data: sub }, { data: usage }] = await Promise.all([
    supabase.from("subscriptions").select("plan, status").eq("workspace_id", workspace.id).maybeSingle(),
    supabase.rpc("workspace_usage", { p_workspace: workspace.id }),
  ]);
  const u = usage as Usage | null;

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Assinatura</h1>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Plano {sub ? PLAN_LABELS[sub.plan] : "—"}
            <Badge variant="outline">Provisório</Badge>
          </CardTitle>
          <CardDescription>
            Os limites abaixo são provisórios e a cobrança não está integrada: nada é cobrado. Preços e limites definitivos ainda serão decididos.
          </CardDescription>
        </CardHeader>
        {u && (
          <CardContent className="grid gap-5">
            <Meter label="Membros e convites" used={u.seats} limit={u.limits.seats} />
            <Meter label="Vídeos na biblioteca" used={u.videos} limit={u.limits.videos} />
            <Meter label="Armazenamento" used={u.storage_bytes} limit={u.limits.storage_bytes} format={formatBytes} />
            {Object.keys(PLATFORM).map((p) => (
              <Meter key={p} label={`Contas ${PLATFORM[p]}`} used={u.accounts_by_platform[p] ?? 0} limit={u.limits.accounts_per_platform} />
            ))}
            <p className="text-xs text-muted-foreground">Contas simuladas não contam no limite. Arquivos de vídeos na lixeira contam no armazenamento até serem apagados.</p>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
