import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Assinatura" };

const PLAN_LABELS = { starter: "Starter", pro: "Pro", agency: "Agency" } as const;
const METRIC_LABELS: Record<string, string> = {
  storage_bytes: "Armazenamento",
  uploads: "Uploads",
  publications: "Publicações",
  connected_accounts: "Contas conectadas",
  ai_tokens: "Consumo de IA",
  processing_seconds: "Processamento de vídeo",
};

export default async function BillingPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const [{ data: sub }, { data: usage }] = await Promise.all([
    supabase.from("subscriptions").select("plan, status").eq("workspace_id", workspace.id).maybeSingle(),
    supabase.from("usage_records").select("metric, quantity, period_start").eq("workspace_id", workspace.id).order("period_start", { ascending: false }).limit(50),
  ]);

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
            Preços e limites definitivos ainda não foram definidos e nenhuma cobrança está integrada. Nada será cobrado.
          </CardDescription>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Uso medido</CardTitle>
          <CardDescription>Registrado automaticamente à medida que os recursos forem usados.</CardDescription>
        </CardHeader>
        <CardContent>
          {(usage?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum uso registrado até agora.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2 font-medium">Métrica</th>
                  <th className="py-2 font-medium">Período</th>
                  <th className="py-2 text-right font-medium">Quantidade</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {usage!.map((u) => (
                  <tr key={`${u.metric}-${u.period_start}`}>
                    <td className="py-2">{METRIC_LABELS[u.metric] ?? u.metric}</td>
                    <td className="py-2">{u.period_start}</td>
                    <td className="py-2 text-right tabular-nums">{u.quantity.toLocaleString("pt-BR")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
