import { ZernioApiError, type ZernioClient, type ZernioPostMetricsRow } from "@reelsflow/connectors/server";
import type { Db } from "../db";
import type { Logger } from "../log";

/**
 * Sincroniza métricas REAIS de posts das contas conectadas pela Zernio (GET /v1/metrics/posts).
 *
 * - Frequência: a cada 3 h por conta (a Zernio atualiza ~90 min nos 7 primeiros dias e depois a cada
 *   24–72 h; consultar mais vezes não traz dado novo). No máximo 1 conta por ciclo do worker.
 * - Lê: (1) os posts publicados pelo ReelsFlow, pelo id da Zernio (até 100 por chamada);
 *       (2) a lista da conta nos últimos 92 dias (inclui posts publicados fora do ReelsFlow), paginada.
 * - Grava: social_posts (métricas mais recentes) e uma foto diária (social_post_metrics_daily), sem
 *   duplicar (upsert por post e dia). Métrica ausente fica NULL.
 * - Conta sem a área `analytics` na conexão: não consulta métricas; marca `needs_analytics_scope`.
 * - 429: respeita Retry-After; 402/403/outros: registra o erro e tenta mais tarde. Nunca lança para o
 *   ciclo de publicação.
 */
export const METRICS_SYNC_EVERY_MINUTES = 180;
const WINDOW_DAYS = 92;
const MAX_PAGES = 10;
const INSIGHTS_PERMISSIONS = ["instagram_business_manage_insights", "instagram_manage_insights", "read_insights", "video.insights", "yt-analytics.readonly"];

type DueAccount = { id: string; workspace_id: string; external_account_id: string; platform: string };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.max(0, Math.round(n));
};

export async function syncContentMetrics(db: Db, deps: { zernio: ZernioClient; log: Logger; now?: () => Date; everyMinutes?: number }) {
  const now = deps.now?.() ?? new Date();
  const due = await db.query<DueAccount>(
    `select a.id, a.workspace_id, a.external_account_id, a.platform::text as platform
       from public.social_accounts a
       left join public.metrics_sync_state s on s.social_account_id = a.id
      where a.provider = 'zernio' and a.status <> 'disconnected' and a.platform <> 'mock'
        and coalesce(s.next_run_at, 'epoch') <= $1
      order by coalesce(s.next_run_at, 'epoch') limit 1`,
    [now.toISOString()],
  );
  const acc = due.rows[0];
  if (!acc) return { synced: 0 };

  const setState = async (status: string, nextMinutes: number, error: string | null, posts?: number) => {
    await db.query(
      `insert into public.metrics_sync_state (social_account_id, workspace_id, status, last_run_at, last_success_at, next_run_at, last_error, posts_seen)
       values ($1, $2, $3, $4, case when $3 = 'ok' then $4::timestamptz end, $4::timestamptz + make_interval(mins => $5), $6, coalesce($7, 0))
       on conflict (social_account_id) do update set
         status = excluded.status, last_run_at = excluded.last_run_at,
         last_success_at = coalesce(excluded.last_success_at, metrics_sync_state.last_success_at),
         next_run_at = excluded.next_run_at, last_error = excluded.last_error,
         posts_seen = case when $7::int is null then metrics_sync_state.posts_seen else excluded.posts_seen end`,
      [acc.id, acc.workspace_id, status, now.toISOString(), nextMinutes, error?.slice(0, 300) ?? null, posts ?? null],
    );
  };

  try {
    // 1) Escopo: sem a área analytics a Zernio não lê métricas ("posting-only cannot read analytics").
    const account = await deps.zernio.getAccount(acc.external_account_id);
    const perms = account.permissions ?? [];
    const areas = account.scopeAreas ?? [];
    const hasInsights = perms.some((p) => INSIGHTS_PERMISSIONS.includes(p)) || (areas.length > 0 && areas.includes("analytics"));
    if (!hasInsights) {
      await setState("needs_analytics_scope", 360, "Conexão sem permissão de métricas (área analytics). Reconecte a conta incluindo métricas.");
      deps.log.warn("metrics sync skipped: no analytics scope", { account_id: acc.id });
      return { synced: 0, status: "needs_analytics_scope" };
    }

    // 2) Posts do ReelsFlow (id da Zernio no checkpoint da publicação), últimos 92 dias.
    const ours = await db.query<{ ext_pub_id: string; zernio_post_id: string; media_asset_id: string | null; external_id: string | null }>(
      `select e.id as ext_pub_id, j.external_checkpoint ->> 'zernio_post_id' as zernio_post_id, j.media_asset_id, e.external_id
         from public.external_publications e join public.publication_jobs j on j.id = e.job_id
        where e.social_account_id = $1 and e.published_at > $2::timestamptz - interval '92 days'
          and j.external_checkpoint ->> 'zernio_post_id' is not null`,
      [acc.id, now.toISOString()],
    );
    const byZernioId = new Map(ours.rows.map((r) => [r.zernio_post_id, r]));
    const byPlatformId = new Map(ours.rows.filter((r) => r.external_id).map((r) => [r.external_id!, r]));

    const rows: ZernioPostMetricsRow[] = [];
    const ids = [...byZernioId.keys()];
    for (let i = 0; i < ids.length; i += 100) rows.push(...(await deps.zernio.listPostMetrics({ postId: ids.slice(i, i + 100) })).data);

    // 3) Lista da conta (inclui posts publicados fora do ReelsFlow).
    const from = new Date(now.getTime() - (WINDOW_DAYS - 1) * 86_400_000);
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await deps.zernio.listPostMetrics({ accountId: acc.external_account_id, fromDate: iso(from), toDate: iso(now), limit: 100, cursor });
      rows.push(...r.data);
      if (!r.pagination?.hasMore || !r.pagination.nextCursor) break;
      cursor = r.pagination.nextCursor;
    }

    // 4) Grava (dedupe por id nativo; a linha mais recente vence).
    const seen = new Map<string, ZernioPostMetricsRow>();
    for (const r of rows) {
      if (!r.platformPostId || r.accountId !== acc.external_account_id) continue;
      const prev = seen.get(r.platformPostId);
      if (!prev || (r.lastSyncedAt ?? "") >= (prev.lastSyncedAt ?? "")) seen.set(r.platformPostId, r);
    }
    const day = iso(now);
    for (const r of seen.values()) {
      const link = (r.postId && byZernioId.get(r.postId)) || byPlatformId.get(r.platformPostId!) || null;
      const synced = Boolean(r.lastSyncedAt);
      // Antes da 1ª sincronização da Zernio os números vêm zerados/provisórios: grava NULL, nunca 0.
      const m = synced ? (r.metrics ?? {}) : {};
      const values = {
        views: int(m.views), reach: int(m.reach), impressions: int(m.impressions), likes: int(m.likes), comments: int(m.comments),
        shares: int(m.shares), saves: int(m.saves), engagement: int(m.engagement), engagement_rate: num(m.engagementRate),
        follows: int(m.follows), profile_views: int(m.profileViews), avg_watch_ms: int(m.averageWatchTime),
        total_watch_ms: int(m.totalWatchTime), skip_rate: num(m.skipRate), completion_rate: num(m.completionRate),
      };
      const up = await db.query<{ id: string }>(
        `insert into public.social_posts (workspace_id, social_account_id, platform, provider, provider_post_id, platform_post_id, permalink,
            published_at, origin, external_publication_id, media_asset_id, provider_sync_status, provider_sync_error, provider_synced_at,
            views, reach, impressions, likes, comments, shares, saves, engagement, engagement_rate, follows, profile_views,
            avg_watch_ms, total_watch_ms, skip_rate, completion_rate, metrics_updated_at)
         values ($1, $2, $3::public.social_platform, 'zernio', $4, $5, $6, coalesce($7::timestamptz, now()), $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, case when $29 then $30::timestamptz end)
         on conflict (social_account_id, platform_post_id) do update set
            provider_post_id = coalesce(excluded.provider_post_id, social_posts.provider_post_id),
            permalink = coalesce(excluded.permalink, social_posts.permalink),
            origin = case when social_posts.external_publication_id is not null or excluded.external_publication_id is not null then 'reelsflow' else excluded.origin end,
            external_publication_id = coalesce(social_posts.external_publication_id, excluded.external_publication_id),
            media_asset_id = coalesce(social_posts.media_asset_id, excluded.media_asset_id),
            provider_sync_status = excluded.provider_sync_status, provider_sync_error = excluded.provider_sync_error,
            provider_synced_at = coalesce(excluded.provider_synced_at, social_posts.provider_synced_at),
            -- só substitui métricas quando a Zernio já sincronizou (não apaga valores bons com "pendente")
            views = case when $29 then excluded.views else social_posts.views end,
            reach = case when $29 then excluded.reach else social_posts.reach end,
            impressions = case when $29 then excluded.impressions else social_posts.impressions end,
            likes = case when $29 then excluded.likes else social_posts.likes end,
            comments = case when $29 then excluded.comments else social_posts.comments end,
            shares = case when $29 then excluded.shares else social_posts.shares end,
            saves = case when $29 then excluded.saves else social_posts.saves end,
            engagement = case when $29 then excluded.engagement else social_posts.engagement end,
            engagement_rate = case when $29 then excluded.engagement_rate else social_posts.engagement_rate end,
            follows = case when $29 then excluded.follows else social_posts.follows end,
            profile_views = case when $29 then excluded.profile_views else social_posts.profile_views end,
            avg_watch_ms = case when $29 then excluded.avg_watch_ms else social_posts.avg_watch_ms end,
            total_watch_ms = case when $29 then excluded.total_watch_ms else social_posts.total_watch_ms end,
            skip_rate = case when $29 then excluded.skip_rate else social_posts.skip_rate end,
            completion_rate = case when $29 then excluded.completion_rate else social_posts.completion_rate end,
            metrics_updated_at = case when $29 then excluded.metrics_updated_at else social_posts.metrics_updated_at end
         returning id`,
        [
          acc.workspace_id, acc.id, acc.platform, r.postId, r.platformPostId, r.platformPostUrl, r.publishedAt,
          link ? "reelsflow" : "external", link?.ext_pub_id ?? null, link?.media_asset_id ?? null,
          r.syncStatus, r.syncError, r.lastSyncedAt,
          values.views, values.reach, values.impressions, values.likes, values.comments, values.shares, values.saves, values.engagement,
          values.engagement_rate, values.follows, values.profile_views, values.avg_watch_ms, values.total_watch_ms, values.skip_rate,
          values.completion_rate, synced, now.toISOString(),
        ],
      );
      if (synced && up.rows[0]) {
        await db.query(
          `insert into public.social_post_metrics_daily (social_post_id, workspace_id, day, captured_at, views, reach, likes, comments, shares, saves, engagement, follows, profile_views, total_watch_ms)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           on conflict (social_post_id, day) do update set captured_at = excluded.captured_at, views = excluded.views, reach = excluded.reach,
             likes = excluded.likes, comments = excluded.comments, shares = excluded.shares, saves = excluded.saves, engagement = excluded.engagement,
             follows = excluded.follows, profile_views = excluded.profile_views, total_watch_ms = excluded.total_watch_ms`,
          [up.rows[0].id, acc.workspace_id, day, now.toISOString(), values.views, values.reach, values.likes, values.comments, values.shares, values.saves, values.engagement, values.follows, values.profile_views, values.total_watch_ms],
        );
      }
    }
    await setState("ok", deps.everyMinutes ?? METRICS_SYNC_EVERY_MINUTES, null, seen.size);
    deps.log.info("metrics synced", { account_id: acc.id, posts: seen.size });
    return { synced: seen.size, status: "ok" };
  } catch (e) {
    if (e instanceof ZernioApiError) {
      if (e.status === 429) {
        await setState("rate_limited", Math.max(15, Math.ceil((e.retryAfterSeconds ?? 900) / 60)), "Limite de consultas da Zernio atingido; nova tentativa mais tarde.");
      } else if (e.status === 402) {
        await setState("error", 24 * 60, "A Zernio informou que o plano não inclui analytics (402).");
      } else if (e.status === 403) {
        await setState("needs_analytics_scope", 360, "A Zernio recusou a leitura de métricas (403). Verifique a conexão da conta.");
      } else {
        await setState("error", 60, `Falha ao ler métricas na Zernio (HTTP ${e.status}).`);
      }
      deps.log.warn("metrics sync failed", { account_id: acc.id, status: e.status, code: e.code });
      return { synced: 0, status: "error" };
    }
    await setState("error", 60, "Falha inesperada na sincronização de métricas.");
    deps.log.error("metrics sync crashed", { account_id: acc.id, error: String(e) });
    return { synced: 0, status: "error" };
  }
}
