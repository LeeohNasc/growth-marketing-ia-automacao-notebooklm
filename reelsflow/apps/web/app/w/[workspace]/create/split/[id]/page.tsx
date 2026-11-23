import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, normalizeSplit } from "@reelsflow/domain";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { SplitEditor, type LibraryVideo } from "./editor";

export const metadata: Metadata = { title: "Tela Dividida" };

export default async function SplitProjectPage({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { workspace, role } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data: project } = await supabase.from("split_projects").select("*").eq("id", id).eq("workspace_id", workspace.id).maybeSingle();
  if (!project) notFound();

  // Vídeos da Biblioteca que podem ser origem (o próprio render de um projeto também pode, como em qualquer edição).
  const { data: media } = await supabase
    .from("media_assets")
    .select("id, name, duration_ms, width, height, status, has_audio, created_at")
    .eq("workspace_id", workspace.id)
    .eq("kind", "video")
    .is("deleted_at", null)
    .in("status", ["uploaded", "processing", "ready"])
    .order("created_at", { ascending: false })
    .limit(300);
  const library: LibraryVideo[] = (media ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    durationS: m.duration_ms ? m.duration_ms / 1000 : null,
    size: m.width && m.height ? `${m.width}×${m.height}` : null,
    hasAudio: m.has_audio,
    status: m.status,
  }));

  let rendered: { id: string; status: string } | null = null;
  if (project.rendered_media_id) {
    const { data: m } = await supabase.from("media_assets").select("id, status").eq("id", project.rendered_media_id).maybeSingle();
    if (m) rendered = { id: m.id, status: m.status };
  }

  return (
    // Tablet/desktop: altura útil exata (janela − cabeçalho − padding) para a prévia ficar fixa e o painel rolar sozinho.
    <div className="mx-auto flex max-w-7xl flex-col gap-4 md:h-[calc(100dvh-3.5rem-3rem)]">
      <div className="shrink-0">
        <Link href={`/w/${slug}/create`} className="text-sm text-muted-foreground hover:underline">
          ← Criar publicação
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Tela Dividida</h1>
        <p className="text-sm text-muted-foreground max-md:hidden">A prévia usa as mesmas regras de enquadramento e tempo do arquivo final. Os vídeos de origem nunca são alterados.</p>
      </div>
      <div className="md:min-h-0 md:flex-1">
        <SplitEditor
          slug={slug}
          workspaceId={workspace.id}
          canEdit={can(role, "editContent")}
          project={{
            id: project.id,
            title: project.title,
            config: normalizeSplit(project.config),
            topMediaId: project.top_media_id,
            bottomMediaId: project.bottom_media_id,
            renderStatus: project.render_status,
            renderError: project.render_error,
          }}
          library={library}
          rendered={rendered}
        />
      </div>
    </div>
  );
}
