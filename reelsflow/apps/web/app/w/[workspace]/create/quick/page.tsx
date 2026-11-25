import type { Metadata } from "next";
import { Temporal } from "temporal-polyfill";
import { can } from "@reelsflow/domain";
import { Alert } from "@/components/ui/alert";
import { maxUploadBytes } from "@/lib/limits";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { QuickPublish, type QuickAccount, type QuickVideo } from "./quick-publish";

export const metadata: Metadata = { title: "Publicação rápida" };

/** Vídeos prontos carregados para a busca local (os planos atuais vão até 200; a margem cobre bibliotecas maiores). */
const VIDEO_LIMIT = 1000;

export default async function QuickPublishPage({ params, searchParams }: { params: Promise<{ workspace: string }>; searchParams: Promise<{ media?: string }> }) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const { workspace, role } = await requireWorkspace(slug);
  const canEdit = can(role, "editContent");
  const supabase = await createClient();
  const tz = workspace.default_timezone;

  const [{ data: videos }, { data: accounts }, maxBytes] = await Promise.all([
    supabase
      .from("media_assets")
      .select("id, name, duration_ms, default_caption, default_hashtags, source_card_id, created_at")
      .eq("workspace_id", workspace.id)
      .eq("status", "ready")
      .eq("kind", "video")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(VIDEO_LIMIT + 1),
    supabase.from("social_accounts").select("id, display_name, platform, status, settings").eq("workspace_id", workspace.id).neq("status", "disconnected").order("created_at"),
    canEdit ? maxUploadBytes(workspace.id) : Promise.resolve(0),
  ]);

  // Sugestão de horário: próxima hora cheia com pelo menos 30 min de folga.
  const now = Temporal.Now.zonedDateTimeISO(tz);
  const next = now.add({ minutes: 30 }).round({ smallestUnit: "hour", roundingMode: "ceil" });
  const accs: QuickAccount[] = (accounts ?? []).map((a) => {
    const s = (a.settings ?? {}) as { default_caption?: string; default_hashtags?: string[]; username?: string };
    return { id: a.id, name: a.display_name, platform: a.platform, username: s.username ?? null, defaultCaption: s.default_caption ?? null, defaultHashtags: s.default_hashtags ?? [] };
  });
  // Conta padrão: a primeira conta real ativa (contas simuladas só se não houver outra).
  const defaultAccount = accs.find((a) => a.platform !== "mock" && (accounts ?? []).find((x) => x.id === a.id)?.status === "active")?.id ?? accs[0]?.id ?? "";
  const ws = (workspace.settings ?? {}) as { default_caption?: string; default_hashtags?: string[] };

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Publicação rápida</h1>
        <p className="text-sm text-muted-foreground">Escolha o vídeo, ajuste a legenda e o horário, revise e agende. Nada é publicado antes do horário.</p>
      </div>
      {!canEdit ? (
        <Alert>Seu papel neste workspace é somente leitura. Peça a um administrador acesso de editor para agendar.</Alert>
      ) : accs.length === 0 ? (
        <Alert variant="warning">Conecte uma conta em Configurações → Contas para agendar publicações.</Alert>
      ) : (
        <QuickPublish
          slug={slug}
          workspaceId={workspace.id}
          maxBytes={maxBytes}
          timezone={tz}
          truncated={(videos ?? []).length > VIDEO_LIMIT}
          videos={(videos ?? []).slice(0, VIDEO_LIMIT).map(
            (v): QuickVideo => ({ id: v.id, name: v.name, durationMs: v.duration_ms, caption: v.default_caption, hashtags: v.default_hashtags ?? [], fromCard: Boolean(v.source_card_id) }),
          )}
          accounts={accs}
          defaults={{
            media: (videos ?? []).some((v) => v.id === sp.media) ? sp.media! : "",
            account: defaultAccount,
            date: next.toPlainDate().toString(),
            time: next.toPlainTime().toString({ smallestUnit: "minute" }),
            today: now.toPlainDate().toString(),
          }}
          workspaceDefaults={{ caption: ws.default_caption ?? null, hashtags: ws.default_hashtags ?? [] }}
        />
      )}
    </div>
  );
}
