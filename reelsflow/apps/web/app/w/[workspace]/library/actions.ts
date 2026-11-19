"use server";
import { revalidatePath } from "next/cache";
import { collectionNameSchema, fieldErrors, normalizeHashtags, updateMediaSchema } from "@reelsflow/domain";
import type { ActionState } from "@/lib/action-state";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

/**
 * Todas as ações revalidam o workspace pela URL (slug) e dependem da RLS /
 * funções SECURITY DEFINER do banco para a autorização final.
 */
async function ctx(slug: string) {
  const { workspace } = await requireWorkspace(slug);
  return { supabase: await createClient(), workspaceId: workspace.id, path: `/w/${slug}/library` };
}

const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 500) : []);

export async function deleteMediaAction(slug: string, mediaIds: string[]) {
  const { supabase, path } = await ctx(slug);
  const { data, error } = await supabase.rpc("delete_media", { p_ids: ids(mediaIds) });
  revalidatePath(path);
  return error ? { ok: false, message: "Você não tem permissão para excluir estes vídeos." } : { ok: true, count: data ?? 0 };
}

export async function restoreMediaAction(slug: string, mediaIds: string[]) {
  const { supabase, path } = await ctx(slug);
  const { data, error } = await supabase.rpc("restore_media", { p_ids: ids(mediaIds) });
  revalidatePath(path);
  return error ? { ok: false, message: "Não foi possível restaurar." } : { ok: true, count: data ?? 0 };
}

export async function retryProcessingAction(slug: string, mediaIds: string[]) {
  const { supabase, path } = await ctx(slug);
  const { data, error } = await supabase.rpc("retry_media_processing", { p_ids: ids(mediaIds) });
  revalidatePath(path);
  return error ? { ok: false, message: "Não foi possível reprocessar." } : { ok: true, count: data ?? 0 };
}

export async function updateMediaAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const slug = String(formData.get("slug") ?? "");
  const id = String(formData.get("id") ?? "");
  const values = { name: String(formData.get("name") ?? ""), caption: String(formData.get("caption") ?? ""), hashtags: String(formData.get("hashtags") ?? "") };
  const parsed = updateMediaSchema.safeParse(values);
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };
  const { supabase, workspaceId, path } = await ctx(slug);
  const { data, error } = await supabase
    .from("media_assets")
    .update({ name: parsed.data.name, default_caption: parsed.data.caption || null, default_hashtags: normalizeHashtags(parsed.data.hashtags) })
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .select("id");
  if (error || !data?.length) return { message: "Não foi possível salvar (permissão de editor necessária).", values };
  revalidatePath(path);
  return { ok: true, message: "Alterações salvas.", values };
}

export async function getPlaybackUrlAction(slug: string, mediaId: string): Promise<string | null> {
  const { supabase, workspaceId } = await ctx(slug);
  const { data: m } = await supabase.from("media_assets").select("storage_path").eq("id", mediaId).eq("workspace_id", workspaceId).maybeSingle();
  if (!m) return null;
  const { data } = await supabase.storage.from("media").createSignedUrl(m.storage_path, 600);
  return data?.signedUrl ?? null;
}

export async function createCollectionAction(slug: string, name: string) {
  const parsed = collectionNameSchema.safeParse(name);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Nome inválido." };
  const { supabase, workspaceId, path } = await ctx(slug);
  const { data: auth } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("collections")
    .insert({ workspace_id: workspaceId, name: parsed.data, created_by: auth.user!.id })
    .select("id")
    .single();
  revalidatePath(path);
  if (error) return { ok: false, message: error.code === "23505" ? "Já existe uma coleção com esse nome." : "Não foi possível criar a coleção." };
  return { ok: true, id: data.id };
}

export async function deleteCollectionAction(slug: string, collectionId: string) {
  const { supabase, workspaceId, path } = await ctx(slug);
  const { error } = await supabase.from("collections").delete().eq("id", collectionId).eq("workspace_id", workspaceId);
  revalidatePath(path);
  return { ok: !error };
}

export async function addToCollectionAction(slug: string, collectionId: string, mediaIds: string[]) {
  const { supabase, workspaceId, path } = await ctx(slug);
  const { data: existing } = await supabase.from("collection_items").select("media_asset_id, position").eq("collection_id", collectionId);
  const have = new Set((existing ?? []).map((e) => e.media_asset_id));
  let next = Math.max(-1, ...(existing ?? []).map((e) => e.position)) + 1;
  const rows = ids(mediaIds)
    .filter((m) => !have.has(m))
    .map((m) => ({ collection_id: collectionId, media_asset_id: m, workspace_id: workspaceId, position: next++ }));
  if (rows.length) {
    const { error } = await supabase.from("collection_items").insert(rows);
    if (error) return { ok: false, message: "Não foi possível adicionar à coleção." };
  }
  revalidatePath(path);
  return { ok: true, count: rows.length };
}

export async function removeFromCollectionAction(slug: string, collectionId: string, mediaIds: string[]) {
  const { supabase, path } = await ctx(slug);
  const { error } = await supabase.from("collection_items").delete().eq("collection_id", collectionId).in("media_asset_id", ids(mediaIds));
  revalidatePath(path);
  return { ok: !error };
}

export async function reorderCollectionAction(slug: string, collectionId: string, orderedIds: string[]) {
  const { supabase, path } = await ctx(slug);
  const { error } = await supabase.rpc("reorder_collection", { p_collection: collectionId, p_media: ids(orderedIds) });
  revalidatePath(path);
  return { ok: !error };
}

/** Move um vídeo uma posição para cima/baixo na ordem manual da coleção. */
export async function moveInCollectionAction(slug: string, collectionId: string, mediaId: string, direction: -1 | 1) {
  const { supabase } = await ctx(slug);
  const { data } = await supabase.from("collection_items").select("media_asset_id").eq("collection_id", collectionId).order("position").order("added_at");
  const order = (data ?? []).map((r) => r.media_asset_id);
  const i = order.indexOf(mediaId);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= order.length) return { ok: false };
  [order[i], order[j]] = [order[j]!, order[i]!];
  return reorderCollectionAction(slug, collectionId, order);
}
