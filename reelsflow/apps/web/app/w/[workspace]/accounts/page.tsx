import type { Metadata } from "next";
import { CONNECTOR_AVAILABILITY } from "@reelsflow/connectors";
import { can, SOCIAL_PLATFORM_LABELS, type SocialPlatform } from "@reelsflow/domain";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { instagramConfig } from "@/lib/instagram";
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

const IG_NOTICES: Record<string, { text: string; ok?: boolean }> = {
  connected: { text: "Conta do Instagram conectada. Ela já pode ser escolhida como destino nas campanhas.", ok: true },
  not_configured: { text: "O Instagram Login não está configurado neste ambiente (INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET e TOKEN_ENCRYPTION_KEY)." },
  denied: { text: "A autorização foi cancelada ou recusada no Instagram." },
  invalid_state: { text: "A sessão de conexão expirou ou já foi usada. Tente novamente." },
  account_mismatch: { text: "O Instagram devolveu dados de outra conta. Nada foi salvo; tente novamente." },
  missing_scopes: { text: "Conta conectada, mas sem a permissão de publicar conteúdo. Reconecte e mantenha todas as permissões marcadas." },
  plan_limit: { text: "O plano deste workspace não permite mais contas do Instagram." },
  error: { text: "Não foi possível concluir a conexão com o Instagram. Verifique se a conta é profissional (Empresa ou Criador de conteúdo) e tente de novo." },
  forbidden: { text: "Somente administradores podem conectar contas." },
};

export default async function AccountsPage({ params, searchParams }: { params: Promise<{ workspace: string }>; searchParams: Promise<{ meta?: string; ig?: string; connected?: string }> }) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const { workspace, role } = await requireWorkspace(slug);
  const supabase = await createClient();
  const [{ data: accounts }, { data: caps }] = await Promise.all([
    supabase.from("social_accounts").select("*").eq("workspace_id", workspace.id).order("created_at"),
    supabase.from("social_account_capabilities").select("social_account_id, capability, granted").eq("workspace_id", workspace.id),
  ]);
  const metaEnabled = metaConfig() !== null;
  const igEnabled = instagramConfig() !== null;
  const notice = sp.meta ? NOTICES[sp.meta] : undefined;
  const igNotice = sp.ig ? IG_NOTICES[sp.ig] : undefined;
  const canManage = can(role, "editWorkspaceSettings");
  const simulated = process.env.ENABLE_SIMULATED_ACCOUNTS !== "false";

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Contas Conectadas</h1>
        <p className="text-sm text-muted-foreground">Conexões apenas por OAuth oficial. O ReelsFlow nunca pede a senha das suas redes.</p>
      </div>

      {notice && <Alert variant="destructive">{notice.text}</Alert>}
      {igNotice && <Alert variant={igNotice.ok ? "success" : "destructive"}>{igNotice.text}</Alert>}
      {sp.connected && <Alert variant="success">{sp.connected} conta(s) conectada(s).</Alert>}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2">
            Instagram
            <Badge variant={igEnabled ? "secondary" : "outline"}>{igEnabled ? "Configurado" : "Não configurado"}</Badge>
          </CardTitle>
          <CardDescription>
            Conexão pelo login oficial do Instagram (contas profissionais: Empresa ou Criador de conteúdo; não precisa de Página do
            Facebook). Cada conexão autoriza uma conta: repita para conectar outras. Enquanto o app não tiver aprovação da Meta, só contas
            adicionadas ao app no painel de desenvolvedores conseguem se conectar.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {igEnabled && canManage ? (
            <Button asChild>
              <a href={`/api/oauth/instagram/start?w=${slug}`}>Conectar conta do Instagram</a>
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              {igEnabled ? "Somente administradores podem conectar contas." : "Configure o Instagram Login no servidor para habilitar a conexão."}
            </p>
          )}
        </CardContent>
      </Card>

      {metaEnabled && (
        <Card>
          <CardHeader>
            <CardTitle>Páginas do Facebook</CardTitle>
            <CardDescription>Conexão pelo Facebook Login, somente para Páginas do Facebook.</CardDescription>
          </CardHeader>
          <CardContent>
            {canManage ? (
              <Button asChild variant="outline">
                <a href={`/api/oauth/meta/start?w=${slug}`}>Conectar Página do Facebook</a>
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">Somente administradores podem conectar contas.</p>
            )}
          </CardContent>
        </Card>
      )}

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
                  igEnabled={igEnabled}
                  acc={{
                    id: a.id,
                    display_name: a.display_name,
                    username: ((a.settings as { username?: string }) ?? {}).username ?? null,
                    avatar_url: a.avatar_url,
                    token_expires_at: a.token_expires_at,
                    provider: a.provider,
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
