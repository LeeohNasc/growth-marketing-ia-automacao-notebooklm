import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "@reelsflow/domain";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { EditorialEditor } from "./editor";

export const metadata: Metadata = { title: "Card Editorial" };

export default async function EditorialCardPage({ params }: { params: Promise<{ workspace: string; id: string }> }) {
  const { workspace: slug, id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { workspace, role } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data: card } = await supabase.from("editorial_cards").select("*").eq("id", id).eq("workspace_id", workspace.id).maybeSingle();
  if (!card) notFound();

  // URLs assinadas de curta duração, SÓ para caminhos do próprio workspace (RLS do storage também barra).
  const prefix = `${workspace.id}/cards/`;
  const logoPath = ((card.style ?? {}) as { watermark?: { logoPath?: string | null } }).watermark?.logoPath ?? null;
  const own = [card.avatar_path, ...card.media_paths, logoPath].filter((p): p is string => Boolean(p) && p!.startsWith(prefix));
  const signed = new Map<string, string>();
  if (own.length) {
    const { data } = await supabase.storage.from("media").createSignedUrls(own, 600);
    for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl);
  }
  const sign = (p: string | null) => (p ? (signed.get(p) ?? null) : null);

  let renderedUrl: string | null = null;
  if (card.rendered_media_id) {
    const { data: m } = await supabase.from("media_assets").select("storage_path, status").eq("id", card.rendered_media_id).maybeSingle();
    if (m?.status === "ready") renderedUrl = (await supabase.storage.from("media").createSignedUrl(m.storage_path, 600)).data?.signedUrl ?? null;
  }
  const { data: accounts } = await supabase
    .from("social_accounts")
    .select("id, display_name, platform, provider, settings")
    .eq("workspace_id", workspace.id)
    .neq("status", "disconnected")
    .neq("platform", "mock")
    .order("display_name");

  return (
    <div className="mx-auto grid max-w-6xl gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <Link href={`/w/${slug}/create`} className="text-sm text-muted-foreground hover:underline">
            ← Criar publicação
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Card Editorial</h1>
          <p className="text-sm text-muted-foreground">A prévia é desenhada pelo mesmo código que gera o arquivo final.</p>
        </div>
      </div>
      <EditorialEditor
        slug={slug}
        workspaceId={workspace.id}
        canEdit={can(role, "editContent")}
        card={card}
        sourceUrls={{ avatar: sign(card.avatar_path), media: card.media_paths.map((p) => sign(p)), logo: sign(logoPath) }}
        accounts={(accounts ?? []).map((a) => ({
          id: a.id,
          display_name: a.display_name,
          username: ((a.settings ?? {}) as { username?: string }).username ?? null,
          platform: a.platform,
          provider: a.provider,
        }))}
        renderedUrl={renderedUrl}
      />
    </div>
  );
}
