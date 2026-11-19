import "server-only";
import { ilikePattern } from "@reelsflow/domain";
import type { MediaAssetRow } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

export const PAGE_SIZE = 48;

export type LibraryQuery = {
  q?: string;
  status?: string;
  sort?: string;
  collection?: string;
  trash?: boolean;
  page?: number;
};

export type LibraryItem = Pick<
  MediaAssetRow,
  | "id"
  | "name"
  | "original_filename"
  | "status"
  | "failure_reason"
  | "size_bytes"
  | "duration_ms"
  | "width"
  | "height"
  | "fps"
  | "video_codec"
  | "audio_codec"
  | "compatibility"
  | "default_caption"
  | "default_hashtags"
  | "created_at"
  | "deleted_at"
  | "thumbnail_path"
> & { thumbUrl: string | null; position?: number; collectionIds: string[] };

const COLUMNS =
  "id, name, original_filename, status, failure_reason, size_bytes, duration_ms, width, height, fps, video_codec, audio_codec, compatibility, default_caption, default_hashtags, created_at, deleted_at, thumbnail_path";

const STATUSES = new Set(["uploaded", "processing", "ready", "failed"]);

/** Lista paginada da biblioteca. Todas as consultas passam pela RLS do usuário. */
export async function listMedia(workspaceId: string, query: LibraryQuery) {
  const supabase = await createClient();
  const page = Math.max(1, query.page ?? 1);
  const from = (page - 1) * PAGE_SIZE;

  let positions: Map<string, number> | null = null;
  if (query.collection) {
    const { data } = await supabase
      .from("collection_items")
      .select("media_asset_id, position")
      .eq("collection_id", query.collection)
      .eq("workspace_id", workspaceId)
      .order("position");
    positions = new Map((data ?? []).map((r) => [r.media_asset_id, r.position]));
  }

  let req = supabase.from("media_assets").select(COLUMNS, { count: "exact" }).eq("workspace_id", workspaceId).neq("status", "uploading");
  req = query.trash ? req.not("deleted_at", "is", null) : req.is("deleted_at", null);
  if (query.status && STATUSES.has(query.status)) {
    req = query.status === "processing" ? req.in("status", ["uploaded", "processing"]) : req.eq("status", query.status as "ready" | "failed");
  }
  if (query.q?.trim()) req = req.ilike("name", ilikePattern(query.q));
  if (positions) req = req.in("id", positions.size ? [...positions.keys()] : ["00000000-0000-0000-0000-000000000000"]);

  const sort = query.sort ?? (positions ? "manual" : "newest");
  if (sort === "oldest") req = req.order("created_at", { ascending: true });
  else if (sort === "name") req = req.order("name", { ascending: true });
  else req = req.order("created_at", { ascending: false });

  // Ordem manual (coleção): ordenada em memória pela posição; coleções são pequenas.
  const manual = sort === "manual" && positions;
  const { data, count, error } = manual ? await req : await req.range(from, from + PAGE_SIZE - 1);
  if (error) throw new Error("Falha ao carregar a biblioteca.");

  let rows = data ?? [];
  if (manual) {
    rows = [...rows].sort((a, b) => (positions!.get(a.id) ?? 0) - (positions!.get(b.id) ?? 0)).slice(from, from + PAGE_SIZE);
  }

  const ids = rows.map((r) => r.id);
  const [{ data: memberships }, thumbs] = await Promise.all([
    ids.length
      ? supabase.from("collection_items").select("media_asset_id, collection_id").in("media_asset_id", ids)
      : Promise.resolve({ data: [] as { media_asset_id: string; collection_id: string }[] }),
    signPaths(rows.map((r) => r.thumbnail_path).filter((p): p is string => Boolean(p)), 3600),
  ]);
  const byMedia = new Map<string, string[]>();
  for (const m of memberships ?? []) byMedia.set(m.media_asset_id, [...(byMedia.get(m.media_asset_id) ?? []), m.collection_id]);

  const items: LibraryItem[] = rows.map((r) => ({
    ...r,
    thumbUrl: r.thumbnail_path ? (thumbs.get(r.thumbnail_path) ?? null) : null,
    position: positions?.get(r.id),
    collectionIds: byMedia.get(r.id) ?? [],
  }));
  return { items, total: count ?? 0, page, pageCount: Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE)), sort };
}

/** URLs assinadas de curta duração (a policy de storage exige ser membro do workspace). */
export async function signPaths(paths: string[], expiresIn: number): Promise<Map<string, string>> {
  if (!paths.length) return new Map();
  const supabase = await createClient();
  const { data } = await supabase.storage.from("media").createSignedUrls(paths, expiresIn);
  const out = new Map<string, string>();
  for (const d of data ?? []) if (d.path && d.signedUrl && !d.error) out.set(d.path, d.signedUrl);
  return out;
}

export async function listCollections(workspaceId: string) {
  const supabase = await createClient();
  const { data } = await supabase.from("collections").select("id, name").eq("workspace_id", workspaceId).order("name");
  return data ?? [];
}
