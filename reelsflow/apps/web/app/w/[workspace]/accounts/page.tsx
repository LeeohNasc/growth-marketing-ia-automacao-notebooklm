import type { Metadata } from "next";
import { CONNECTOR_AVAILABILITY } from "@reelsflow/connectors";
import { can, SOCIAL_PLATFORM_LABELS, type SocialPlatform } from "@reelsflow/domain";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { AccountRow, CreateSimulatedForm } from "./accounts-client";

export const metadata: Metadata = { title: "Contas Conectadas" };

const REAL: SocialPlatform[] = ["instagram", "facebook", "tiktok", "youtube"];

export default async function AccountsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data: accounts } = await supabase.from("social_accounts").select("*").eq("workspace_id", workspace.id).order("created_at");
  const canManage = can(role, "editWorkspaceSettings");
  const simulated = process.env.ENABLE_SIMULATED_ACCOUNTS !== "false";

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Contas Conectadas</h1>
        <p className="text-sm text-muted-foreground">Conexões apenas por OAuth oficial. O ReelsFlow nunca pede a senha das suas redes.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Contas do workspace</CardTitle>
          <CardDescription>Pausar uma conta suspende as publicações dela sem alterar o calendário.</CardDescription>
        </CardHeader>
        <CardContent>
          {(accounts?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma conta conectada.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {accounts!.map((a) => (
                <AccountRow
                  key={a.id}
                  slug={slug}
                  canManage={canManage}
                  acc={{
                    id: a.id,
                    display_name: a.display_name,
                    platform: a.platform,
                    status: a.status,
                    paused: a.paused,
                    min_spacing_minutes: a.min_spacing_minutes,
                    behavior: ((a.settings as { mock_behavior?: string }) ?? {}).mock_behavior ?? null,
                  }}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        {REAL.map((p) => (
          <Card key={p}>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base">
                {SOCIAL_PLATFORM_LABELS[p]}
                <Badge variant="outline">Indisponível</Badge>
              </CardTitle>
              <CardDescription>{CONNECTOR_AVAILABILITY[p].reason}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>

      {simulated && canManage && (
        <Card className="border-warning/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Conta simulada <Badge variant="warning">Teste</Badge>
            </CardTitle>
            <CardDescription>
              Permite testar campanhas, fila e falhas sem redes reais. Nada é publicado fora do ReelsFlow; os links gerados
              não levam a conteúdo real.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreateSimulatedForm slug={slug} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
