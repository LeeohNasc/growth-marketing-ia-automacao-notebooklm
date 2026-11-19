import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { signPaths } from "@/lib/media";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { AddVideosForm } from "./add-form";

export const metadata: Metadata = { title: "Adicionar vídeos" };

export default async function AddVideosPage({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  const { workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data: campaign } = await supabase.from("campaigns").select("id, name").eq("id", id).eq("workspace_id", workspace.id).maybeSingle();
  if (!campaign) notFound();
  const [{ data: videos }, { data: existing }] = await Promise.all([
    supabase
      .from("media_assets")
      .select("id, name, duration_ms, compatibility, thumbnail_path, created_at")
      .eq("workspace_id", workspace.id)
      .eq("status", "ready")
      .is("deleted_at", null)
      .order("created_at")
      .limit(1000),
    supabase.from("campaign_media").select("media_asset_id").eq("campaign_id", id),
  ]);
  const thumbs = await signPaths((videos ?? []).map((v) => v.thumbnail_path).filter((p): p is string => Boolean(p)), 3600);
  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Adicionar vídeos</h1>
        <p className="text-sm text-muted-foreground">
          {campaign.name}: os vídeos entram no <strong>fim da fila</strong>, depois do último horário já agendado. Nada do que já está no calendário muda.
        </p>
      </div>
      <Card>
        <CardContent className="pt-5">
          <AddVideosForm
            slug={slug}
            campaignId={id}
            exclude={(existing ?? []).map((e) => e.media_asset_id)}
            videos={(videos ?? []).map((v) => ({ ...v, thumbUrl: v.thumbnail_path ? (thumbs.get(v.thumbnail_path) ?? null) : null }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
