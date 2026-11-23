import "server-only";
import type { JobStatusDb } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

export const STATUS_GROUPS: Record<string, { label: string; statuses: JobStatusDb[] }> = {
  all: { label: "Todas (exceto canceladas)", statuses: ["draft", "scheduled", "queued", "preparing", "uploading", "processing_remote", "publishing", "published", "failed_retryable", "failed_permanent", "uncertain", "needs_review"] },
  upcoming: { label: "Agendadas", statuses: ["draft", "scheduled", "queued"] },
  active: { label: "Em andamento", statuses: ["preparing", "uploading", "processing_remote", "publishing"] },
  problems: { label: "Com problema", statuses: ["failed_retryable", "failed_permanent", "uncertain", "needs_review"] },
  published: { label: "Publicadas", statuses: ["published"] },
  cancelled: { label: "Canceladas", statuses: ["cancelled"] },
};

export type JobListItem = {
  id: string;
  status: JobStatusDb;
  scheduled_at: string;
  published_at: string | null;
  attempt_count: number;
  last_error_class: string | null;
  last_error_message: string | null;
  pinned: boolean;
  media: string | null;
  account: string | null;
  platform: string | null;
  campaign: string | null;
  campaignId: string | null;
  permalink: string | null;
  externalId: string | null;
  mediaAssetId: string | null;
  localTime: string;
  /** Caminho da miniatura no Storage (não assinado). */
  thumbnailPath: string | null;
};

/** Publicações com nomes resolvidos (consultas separadas: RLS em todas). */
export async function listJobs(
  workspaceId: string,
  f: { statuses: JobStatusDb[]; campaign?: string; account?: string; from?: string; to?: string; order?: "asc" | "desc"; limit: number; offset?: number },
) {
  const supabase = await createClient();
  let q = supabase
    .from("publication_jobs")
    .select("id, status, scheduled_at, published_at, attempt_count, last_error_class, last_error_message, pinned, media_asset_id, social_account_id, campaign_id, local_time", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .in("status", f.statuses);
  if (f.campaign) q = q.eq("campaign_id", f.campaign);
  if (f.account) q = q.eq("social_account_id", f.account);
  if (f.from) q = q.gte("scheduled_at", f.from);
  if (f.to) q = q.lt("scheduled_at", f.to);
  q = q.order("scheduled_at", { ascending: (f.order ?? "asc") === "asc" }).range(f.offset ?? 0, (f.offset ?? 0) + f.limit - 1);
  const { data: jobs, count } = await q;
  const rows = jobs ?? [];
  const ids = (k: "media_asset_id" | "social_account_id" | "campaign_id") => [...new Set(rows.map((r) => r[k]).filter((x): x is string => Boolean(x)))];
  const none = { data: [] as never[] };
  const [{ data: media }, { data: accounts }, { data: campaigns }, { data: ext }] = await Promise.all([
    ids("media_asset_id").length ? supabase.from("media_assets").select("id, name, thumbnail_path").in("id", ids("media_asset_id")) : Promise.resolve(none),
    ids("social_account_id").length ? supabase.from("social_accounts").select("id, display_name, platform").in("id", ids("social_account_id")) : Promise.resolve(none),
    ids("campaign_id").length ? supabase.from("campaigns").select("id, name").in("id", ids("campaign_id")) : Promise.resolve(none),
    rows.length ? supabase.from("external_publications").select("job_id, permalink, external_id").in("job_id", rows.map((r) => r.id)) : Promise.resolve(none),
  ]);
  const m = new Map((media ?? []).map((x: { id: string; name: string; thumbnail_path: string | null }) => [x.id, x]));
  const a = new Map((accounts ?? []).map((x: { id: string; display_name: string; platform: string }) => [x.id, x]));
  const c = new Map((campaigns ?? []).map((x: { id: string; name: string }) => [x.id, x.name]));
  const e = new Map((ext ?? []).map((x: { job_id: string; permalink: string | null; external_id: string | null }) => [x.job_id, x]));
  const items: JobListItem[] = rows.map((r) => ({
    id: r.id,
    status: r.status,
    scheduled_at: r.scheduled_at,
    published_at: r.published_at,
    attempt_count: r.attempt_count,
    last_error_class: r.last_error_class,
    last_error_message: r.last_error_message,
    pinned: r.pinned,
    media: r.media_asset_id ? (m.get(r.media_asset_id)?.name ?? null) : null,
    account: r.social_account_id ? (a.get(r.social_account_id)?.display_name ?? null) : null,
    platform: r.social_account_id ? (a.get(r.social_account_id)?.platform ?? null) : null,
    campaign: r.campaign_id ? (c.get(r.campaign_id) ?? null) : null,
    campaignId: r.campaign_id,
    permalink: e.get(r.id)?.permalink ?? null,
    externalId: e.get(r.id)?.external_id ?? null,
    mediaAssetId: r.media_asset_id,
    localTime: r.local_time,
    thumbnailPath: r.media_asset_id ? (m.get(r.media_asset_id)?.thumbnail_path ?? null) : null,
  }));
  return { items, total: count ?? 0 };
}
