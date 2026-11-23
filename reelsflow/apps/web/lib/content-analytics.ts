import "server-only";
import { Temporal } from "temporal-polyfill";
import { CONTENT_METRICS, type PostLatest, type Snapshot } from "@reelsflow/domain";
import type { SocialPlatform } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

/**
 * Leitura das métricas REAIS de conteúdo (sincronizadas pelo worker a partir da Zernio).
 * Nada é estimado: métrica ausente chega como null e a interface mostra "Indisponível".
 */

export type ContentPost = PostLatest & {
  platformPostId: string;
  permalink: string | null;
  origin: "reelsflow" | "external";
  mediaAssetId: string | null;
  mediaName: string | null;
  accountName: string | null;
  platform: SocialPlatform;
  syncStatus: string | null;
  syncError: string | null;
  providerSyncedAt: string | null;
  impressions: number | null;
  avgWatchMs: number | null;
  completionRate: number | null;
  skipRate: number | null;
  externalPublicationId: string | null;
};

export type SyncState = {
  socialAccountId: string;
  accountName: string | null;
  status: "pending" | "ok" | "needs_analytics_scope" | "rate_limited" | "error" | "not_supported";
  lastSuccessAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
};

export const SYNC_STATUS_TEXT: Record<SyncState["status"], string> = {
  pending: "Aguardando a primeira sincronização de métricas.",
  ok: "Métricas sincronizadas.",
  needs_analytics_scope:
    "A conexão desta conta na Zernio só permite publicar. Para ler visualizações, curtidas e outras métricas, a conta precisa ser reconectada incluindo a permissão de métricas (analytics).",
  rate_limited: "Limite de consultas da Zernio atingido; a próxima tentativa é automática.",
  error: "A última sincronização falhou; a próxima tentativa é automática.",
  not_supported: "Esta rede ainda não tem métricas disponíveis pela integração.",
};

export type Period = { key: string; label: string; fromDay: string; toDay: string; fromIso: string; toIso: string; days: number };

/** Períodos: 24h, 7, 30, 90 dias ou personalizado (?from=YYYY-MM-DD&to=YYYY-MM-DD). Dias no fuso do workspace. */
export function resolvePeriod(tz: string, sp: { days?: string; from?: string; to?: string }): Period {
  const today = Temporal.Now.plainDateISO(tz);
  const isDay = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (isDay(sp.from) && isDay(sp.to)) {
    let a = Temporal.PlainDate.from(sp.from!);
    let b = Temporal.PlainDate.from(sp.to!);
    if (Temporal.PlainDate.compare(a, b) > 0) [a, b] = [b, a];
    if (Temporal.PlainDate.compare(b, today) > 0) b = today;
    const days = a.until(b).days + 1;
    if (days <= 366) {
      return {
        key: "custom", label: `${fmtDay(a)} a ${fmtDay(b)}`, fromDay: a.toString(), toDay: b.toString(), days,
        fromIso: a.toZonedDateTime({ timeZone: tz }).toInstant().toString(), toIso: b.add({ days: 1 }).toZonedDateTime({ timeZone: tz }).toInstant().toString(),
      };
    }
  }
  const n = [1, 7, 30, 90].includes(Number(sp.days)) ? Number(sp.days) : 30;
  if (n === 1) {
    const now = Temporal.Now.instant();
    const from = now.subtract({ hours: 24 });
    return { key: "1", label: "últimas 24 horas", fromDay: from.toZonedDateTimeISO(tz).toPlainDate().toString(), toDay: today.toString(), fromIso: from.toString(), toIso: now.toString(), days: 1 };
  }
  const start = today.subtract({ days: n - 1 });
  return {
    key: String(n), label: `últimos ${n} dias`, fromDay: start.toString(), toDay: today.toString(), days: n,
    fromIso: start.toZonedDateTime({ timeZone: tz }).toInstant().toString(), toIso: today.add({ days: 1 }).toZonedDateTime({ timeZone: tz }).toInstant().toString(),
  };
}
const fmtDay = (d: Temporal.PlainDate) => `${String(d.day).padStart(2, "0")}/${String(d.month).padStart(2, "0")}/${d.year}`;

type PostRow = {
  id: string; social_account_id: string; platform: SocialPlatform; platform_post_id: string; permalink: string | null; published_at: string;
  origin: "reelsflow" | "external"; external_publication_id: string | null; media_asset_id: string | null; provider_sync_status: string | null;
  provider_sync_error: string | null; provider_synced_at: string | null; metrics_updated_at: string | null; engagement_rate: number | null;
  impressions: number | null; avg_watch_ms: number | null; completion_rate: number | null; skip_rate: number | null;
} & Record<(typeof CONTENT_METRICS)[number], number | null>;

const POST_COLS =
  "id, social_account_id, platform, platform_post_id, permalink, published_at, origin, external_publication_id, media_asset_id, provider_sync_status, provider_sync_error, provider_synced_at, metrics_updated_at, engagement_rate, impressions, avg_watch_ms, completion_rate, skip_rate, " +
  CONTENT_METRICS.join(", ");

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toPost(r: PostRow, media: Map<string, string>, accounts: Map<string, string>): ContentPost {
  const metrics = Object.fromEntries(CONTENT_METRICS.map((m) => [m, n(r[m])])) as Record<(typeof CONTENT_METRICS)[number], number | null>;
  return {
    id: r.id, socialAccountId: r.social_account_id, platform: r.platform, publishedAt: r.published_at, metricsUpdatedAt: r.metrics_updated_at,
    engagementRate: n(r.engagement_rate), ...metrics,
    platformPostId: r.platform_post_id, permalink: r.permalink, origin: r.origin, mediaAssetId: r.media_asset_id,
    mediaName: r.media_asset_id ? media.get(r.media_asset_id) ?? null : null, accountName: accounts.get(r.social_account_id) ?? null,
    syncStatus: r.provider_sync_status, syncError: r.provider_sync_error, providerSyncedAt: r.provider_synced_at,
    impressions: n(r.impressions), avgWatchMs: n(r.avg_watch_ms), completionRate: n(r.completion_rate), skipRate: n(r.skip_rate),
    externalPublicationId: r.external_publication_id,
  };
}

async function names(workspaceId: string, mediaIds: string[]) {
  const supabase = await createClient();
  const [acc, med] = await Promise.all([
    supabase.from("social_accounts").select("id, display_name").eq("workspace_id", workspaceId),
    mediaIds.length ? supabase.from("media_assets").select("id, name").in("id", mediaIds) : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);
  return {
    accounts: new Map((acc.data ?? []).map((a: { id: string; display_name: string }) => [a.id, a.display_name])),
    media: new Map((med.data ?? []).map((m: { id: string; name: string }) => [m.id, m.name])),
  };
}

/** Todos os posts sincronizados do workspace (últimos 400 por data) + fotos diárias do período + estado da sincronização. */
export async function loadContentAnalytics(workspaceId: string, period: Period) {
  const supabase = await createClient();
  const snapFrom = Temporal.PlainDate.from(period.fromDay).subtract({ days: 7 }).toString(); // inclui a base anterior ao início
  const [posts, snaps, state] = await Promise.all([
    supabase.from("social_posts").select(POST_COLS).eq("workspace_id", workspaceId).order("published_at", { ascending: false }).limit(400),
    supabase
      .from("social_post_metrics_daily")
      .select(`social_post_id, day, ${CONTENT_METRICS.join(", ")}`)
      .eq("workspace_id", workspaceId)
      .gte("day", snapFrom)
      .lte("day", period.toDay)
      .limit(20000),
    supabase.from("metrics_sync_state").select("social_account_id, status, last_success_at, last_run_at, last_error").eq("workspace_id", workspaceId),
  ]);
  const rows = (posts.data ?? []) as unknown as PostRow[];
  const { accounts, media } = await names(workspaceId, [...new Set(rows.map((r) => r.media_asset_id).filter((x): x is string => !!x))]);
  const all = rows.map((r) => toPost(r, media, accounts));
  const snapshots: Snapshot[] = ((snaps.data ?? []) as unknown as ({ social_post_id: string; day: string } & Record<string, unknown>)[]).map((s) => ({
    postId: s.social_post_id,
    day: s.day,
    ...(Object.fromEntries(CONTENT_METRICS.map((m) => [m, n(s[m])])) as Record<(typeof CONTENT_METRICS)[number], number | null>),
  }));
  const sync: SyncState[] = ((state.data ?? []) as { social_account_id: string; status: SyncState["status"]; last_success_at: string | null; last_run_at: string | null; last_error: string | null }[]).map((s) => ({
    socialAccountId: s.social_account_id, accountName: accounts.get(s.social_account_id) ?? null, status: s.status,
    lastSuccessAt: s.last_success_at, lastRunAt: s.last_run_at, lastError: s.last_error,
  }));
  const inPeriod = all.filter((p) => p.publishedAt >= period.fromIso && p.publishedAt < period.toIso);
  const lastUpdate = all.reduce<string | null>((acc, p) => (p.metricsUpdatedAt && (!acc || p.metricsUpdatedAt > acc) ? p.metricsUpdatedAt : acc), null);
  return { all, inPeriod, snapshots, sync, lastUpdate, error: posts.error?.message ?? null };
}

/** Um post + todo o seu histórico diário. */
export async function loadContentPost(workspaceId: string, postId: string) {
  const supabase = await createClient();
  const { data } = await supabase.from("social_posts").select(POST_COLS).eq("workspace_id", workspaceId).eq("id", postId).maybeSingle();
  if (!data) return null;
  const row = data as unknown as PostRow;
  const [{ accounts, media }, snaps, peers, ext] = await Promise.all([
    names(workspaceId, row.media_asset_id ? [row.media_asset_id] : []),
    supabase.from("social_post_metrics_daily").select(`social_post_id, day, captured_at, ${CONTENT_METRICS.join(", ")}`).eq("social_post_id", postId).order("day"),
    supabase.from("social_posts").select(POST_COLS).eq("workspace_id", workspaceId).eq("social_account_id", row.social_account_id).order("published_at", { ascending: false }).limit(400),
    row.external_publication_id
      ? supabase.from("external_publications").select("job_id").eq("id", row.external_publication_id).maybeSingle()
      : Promise.resolve({ data: null as { job_id: string } | null }),
  ]);
  let job: { id: string; campaign_id: string | null; scheduled_at: string; campaign: string | null } | null = null;
  if (ext.data?.job_id) {
    const j = await supabase.from("publication_jobs").select("id, campaign_id, scheduled_at").eq("id", ext.data.job_id).maybeSingle();
    if (j.data) {
      const c = j.data.campaign_id ? await supabase.from("campaigns").select("name").eq("id", j.data.campaign_id).maybeSingle() : { data: null };
      job = { id: j.data.id, campaign_id: j.data.campaign_id, scheduled_at: j.data.scheduled_at, campaign: (c.data as { name: string } | null)?.name ?? null };
    }
  }
  const post = toPost(row, media, accounts);
  const history = ((snaps.data ?? []) as unknown as ({ day: string; captured_at: string } & Record<string, unknown>)[]).map((s) => ({
    day: s.day,
    capturedAt: s.captured_at,
    ...(Object.fromEntries(CONTENT_METRICS.map((m) => [m, n(s[m])])) as Record<(typeof CONTENT_METRICS)[number], number | null>),
  }));
  return { post, history, peers: ((peers.data ?? []) as unknown as PostRow[]).map((r) => toPost(r, media, accounts)), job };
}
