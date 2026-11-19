import type { Metadata } from "next";
import { CONNECTOR_AVAILABILITY } from "@reelsflow/connectors";
import { can, SOCIAL_PLATFORM_LABELS, type SocialPlatform } from "@reelsflow/domain";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { metaConfig } from "@/lib/meta";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { AccountRow, CreateSimulatedForm } from "./accounts-client";

export const metadata: Metadata = { title: "Contas Conectadas" };

const BLOCKED: SocialPlatform[] = ["tiktok", "youtube"];

const NOTICES: Record<string, { text: string; ok?: boolean }> = {
  not_configured: { text: "A integração com a Meta não está configurada neste ambiente (META_APP_ID, META_APP_SECRET e TOKEN_ENCRYPTION_KEY)." },
  denied: { text: "A autorização foi cancelada ou recusada na Meta." },
  invalid_state: { text: "A sessão de conexão expirou ou já foi usada. Tente novamente." },
  error: { text: "Não foi possível concluir a conexão com a Meta. Tente novamente em instantes." },
  forbidden: { text: "Somente administradores podem conectar contas." },
};

export default async function AccountsPage({ params, searchParams }: { params: Promise<{ workspace: string }>; searchParams: Promise<{ meta?: string; connected?: string }> }) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const { workspace, role } = await requireWorkspace(slug);
  const supabase = await createClient();
  const [{ data: accounts }, { data: caps }] = await Promise.all([
    supabase.from("social_accounts").select("*").eq("workspace_id", workspace.id).order("created_at"),
    supabase.from("social_account_capabilities").select("social_account_id, capability, granted").eq("workspace_id", workspace.id),
  ]);
  const metaEnabled = metaConfig() !== null;
  const notice = sp.meta ? NOTICES[sp.meta] : undefined;
  const canManage = can(role, "editWorkspaceSettings");
  const simulated = process.env.ENABLE_SIMULATED_ACCOUNTS !== "false";

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Contas Conectadas</h1>
        <p className="text-sm text-muted-foreground">Conexões apenas por OAuth oficial. O ReelsFlow nunca pede a senha das suas redes.</p>
      </div>

      {notice && <Alert variant="destructive">{notice.text}</Alert>}
      {sp.connected && <Alert variant="success">{sp.connected} conta(s) conectada(s).</Alert>}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2">
            Instagram e Facebook
            <Badge variant={metaEnabled ? "secondary" : "outline"}>{metaEnabled ? "Configurado" : "Não configurado"}</Badge>
          </CardTitle>
          <CardDescription>
            Conexão pelo Facebook Login: Páginas do Facebook e contas profissionais do Instagram vinculadas a elas. Enquanto o app não tiver
            aprovação da Meta (App Review), somente pessoas com papel no app conseguem conectar e publicar.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {metaEnabled && canManage ? (
            <Button asChild>
              <a href={`/api/oauth/meta/start?w=${slug}`}>Conectar Instagram ou Facebook</a>
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              {metaEnabled ? "Somente administradores podem conectar contas." : "Configure o app Meta no servidor para habilitar a conexão."}
            </p>
          )}
        </CardContent>
      </Card>

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
                  metaEnabled={metaEnabled}
                  acc={{
                    id: a.id,
                    display_name: a.display_name,
                    platform: a.platform,
                    status: a.status,
                    paused: a.paused,
                    min_spacing_minutes: a.min_spacing_minutes,
                    behavior: ((a.settings as { mock_behavior?: string }) ?? {}).mock_behavior ?? null,
                    capabilities: (caps ?? []).filter((c) => c.social_account_id === a.id).map((c) => ({ capability: c.capability, granted: c.granted })),
                  }}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        {BLOCKED.map((p) => (
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
