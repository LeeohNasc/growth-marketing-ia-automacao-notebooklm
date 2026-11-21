import type { Metadata } from "next";
import { Temporal } from "temporal-polyfill";
import { signPaths } from "@/lib/media";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { CampaignWizard } from "./wizard";

export const metadata: Metadata = { title: "Nova campanha" };

export default async function NewCampaignPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const [{ data: templates }, { data: accounts }, { data: videos }, { data: collections }, { data: items }] = await Promise.all([
    supabase.from("publication_templates").select("*").eq("workspace_id", workspace.id).order("name"),
    supabase.from("social_accounts").select("id, display_name, platform, status, paused, settings, provider").eq("workspace_id", workspace.id).order("display_name"),
    supabase
      .from("media_assets")
      .select("id, name, duration_ms, compatibility, thumbnail_path, created_at")
      .eq("workspace_id", workspace.id)
      .eq("status", "ready")
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(1000),
    supabase.from("collections").select("id, name").eq("workspace_id", workspace.id).order("name"),
    supabase.from("collection_items").select("collection_id").eq("workspace_id", workspace.id),
  ]);
  const thumbs = await signPaths((videos ?? []).map((v) => v.thumbnail_path).filter((p): p is string => Boolean(p)), 3600);
  const counts = new Map<string, number>();
  for (const i of items ?? []) counts.set(i.collection_id, (counts.get(i.collection_id) ?? 0) + 1);
  const today = Temporal.Now.plainDateISO(workspace.default_timezone).toString();

  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Nova campanha</h1>
        <p className="text-sm text-muted-foreground">Vídeos → contas e modelo → calendário gerado automaticamente → revisar → ativar.</p>
      </div>
      <CampaignWizard
        slug={slug}
        templates={templates ?? []}
        accounts={(accounts ?? []).map(({ settings, ...a }) => ({ ...a, username: (settings as { username?: string } | null)?.username ?? null }))}
        videos={(videos ?? []).map((v) => ({ ...v, thumbUrl: v.thumbnail_path ? (thumbs.get(v.thumbnail_path) ?? null) : null }))}
        collections={(collections ?? []).map((c) => ({ ...c, count: counts.get(c.id) ?? 0 }))}
        defaultTimezone={workspace.default_timezone}
        today={today}
      />
    </div>
  );
}
