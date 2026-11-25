"use server";
import { redirect } from "next/navigation";
import { DEFAULT_CARD_STYLE, EDITORIAL_TEMPLATE_VERSION, can } from "@reelsflow/domain";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

/** Novo Card Editorial (rascunho), pré-preenchido com a primeira conta conectada, se houver. */
export async function createCardAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  const { workspace, user, role } = await requireWorkspace(slug);
  if (!can(role, "editContent")) redirect(`/w/${slug}/create?e=forbidden`);
  const rawMedia = String(formData.get("media") ?? "");
  const media = /^[0-9a-f-]{36}$/.test(rawMedia) ? rawMedia : null;
  const supabase = await createClient();
  const { data: acc } = await supabase
    .from("social_accounts")
    .select("id, display_name, settings")
    .eq("workspace_id", workspace.id)
    .neq("status", "disconnected")
    .neq("platform", "mock")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  const username = ((acc?.settings ?? {}) as { username?: string }).username ?? "";
  const { data, error } = await supabase
    .from("editorial_cards")
    .insert({
      workspace_id: workspace.id,
      created_by: user.id,
      title: "Card sem título",
      page_name: acc?.display_name.replace(/^@/, "").slice(0, 60) ?? "",
      username: /^[\p{L}\p{N}._]{1,30}$/u.test(username) ? username : "",
      social_account_id: acc?.id ?? null,
      style: DEFAULT_CARD_STYLE,
      template_version: EDITORIAL_TEMPLATE_VERSION,
      // Vindo da Publicação rápida com um vídeo escolhido: já começa como Reels 9:16 de vídeo.
      ...(media ? { format: "vertical" as const, media_kind: "video" as const } : {}),
    })
    .select("id")
    .single();
  if (error || !data) redirect(`/w/${slug}/create?e=create`);
  redirect(`/w/${slug}/create/editorial/${data.id}${media ? `?media=${media}` : ""}`);
}

export async function duplicateCardAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  await requireWorkspace(slug);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("duplicate_editorial_card", { p_card: String(formData.get("card") ?? "") });
  if (error || !data) redirect(`/w/${slug}/create?e=duplicate`);
  redirect(`/w/${slug}/create/editorial/${data}`);
}

export async function deleteCardAction(formData: FormData) {
  const slug = String(formData.get("slug") ?? "");
  await requireWorkspace(slug);
  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_editorial_card", { p_card: String(formData.get("card") ?? "") });
  redirect(`/w/${slug}/create${error ? "?e=delete" : "?ok=deleted"}`);
}
