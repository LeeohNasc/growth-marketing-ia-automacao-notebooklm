import { randomBytes } from "node:crypto";
import { ZernioClient } from "@reelsflow/connectors/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../src/log";
import { syncContentMetrics } from "../src/publishing/metrics-sync";
import { makeDb } from "./db";

/** Sincronização de métricas com banco real (Postgres local) e API da Zernio SIMULADA. */
const db = makeDb(3);
const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;
const hex24 = () => randomBytes(12).toString("hex");
let user: string;
let ws: string;

type Req = { path: string; query: URLSearchParams };
function fakeZernio(route: (r: Req) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined) {
  const calls: Req[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const u = new URL(String(input));
    const r = { path: u.pathname.replace("/api/v1/", ""), query: u.searchParams };
    calls.push(r);
    const out = route(r);
    if (!out) return new Response(JSON.stringify({ error: "não simulado" }), { status: 404 });
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200, headers: out.headers });
  }) as unknown as typeof fetch;
  return { calls, client: new ZernioClient({ apiKey: "sk_test", fetchImpl }), metricCalls: () => calls.filter((c) => c.path === "metrics/posts") };
}
const accountBody = (acc: string, scopeAreas: string[], permissions: string[]) => ({ account: { _id: acc, platform: "instagram", isActive: true, scopeAreas, permissions } });
const WITH_ANALYTICS = [["posting", "analytics"], ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_insights"]] as const;
const row = (acc: string, over: Record<string, unknown> = {}) => ({
  postId: null, externalPostId: null, accountId: acc, platform: "instagram", platformPostId: "17900000000000999",
  platformPostUrl: "https://www.instagram.com/reel/EXT/", publishedAt: "2026-11-10T12:00:00Z", lastSyncedAt: "2026-11-22T09:00:00Z",
  syncStatus: "synced", syncError: null, metrics: { views: 1500, likes: 80, comments: 4, shares: 9, saves: 3, reach: 1100, engagementRate: 6.4, averageWatchTime: 4200 },
  ...over,
});

async function account() {
  const acc = hex24();
  const id = (await q("select public.link_zernio_account($1, $2, $3, 'instagram', 'pipocoumemes', 'Pipocou') as id", [ws, acc, hex24()]))[0].id;
  return { id, acc };
}
/** Uma publicação do ReelsFlow já concluída (para testar o vínculo com o vídeo da biblioteca). */
async function reelsflowPublication(accountId: string, zernioPostId: string, igId: string) {
  const camp = (await q("insert into public.campaigns (workspace_id, name, status, timezone, weekdays, times, start_date, caption, created_by) values ($1,'C','active','America/Sao_Paulo','{1,2,3,4,5,6,7}','{09:00}',current_date,'x',$2) returning id", [ws, user]))[0].id;
  const media = (await q("insert into public.media_assets (workspace_id, name, original_filename, storage_path, mime_type, size_bytes, sha256, status) values ($1,'v','v.mp4',$2,'video/mp4',10,$3,'uploading') returning id", [ws, `${ws}/${crypto.randomUUID()}/o.mp4`, "f".repeat(64)]))[0].id;
  for (const s of ["uploaded", "processing", "ready"]) await q("update public.media_assets set status = $2 where id = $1", [media, s]);
  const target = (await q("insert into public.campaign_targets (campaign_id, workspace_id, social_account_id) values ($1,$2,$3) returning id", [camp, ws, accountId]))[0].id;
  const cm = (await q("insert into public.campaign_media (campaign_id, workspace_id, media_asset_id) values ($1,$2,$3) returning id", [camp, ws, media]))[0].id;
  const job = (await q("insert into public.publication_jobs (workspace_id, campaign_id, campaign_media_id, target_id, social_account_id, media_asset_id, local_date, local_time, timezone, scheduled_at, status, next_attempt_at, external_checkpoint) values ($1,$2,$3,$4,$5,$6,current_date,'09:00','America/Sao_Paulo',now(),'draft',now(), jsonb_build_object('zernio_post_id', $7::text)) returning id", [ws, camp, cm, target, accountId, media, zernioPostId]))[0].id;
  const ext = (await q("insert into public.external_publications (workspace_id, job_id, social_account_id, platform, external_id, permalink, published_at, source) values ($1,$2,$3,'instagram',$4,'https://www.instagram.com/reel/RF/',now() - interval '1 day','api') returning id", [ws, job, accountId, igId]))[0].id;
  return { media, ext };
}

beforeAll(async () => {
  user = (await q("insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id", [`metrics-${Date.now()}@t.local`]))[0].id;
  ws = (await q("insert into public.workspaces (name, slug, created_by) values ('Leeoh', $1, $2) returning id", [`m-${Date.now()}`, user]))[0].id;
  await q("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'owner')", [ws, user]);
  await q("insert into public.subscriptions (workspace_id, plan) values ($1, 'agency')", [ws]);
});
beforeEach(async () => {
  await q("update public.social_accounts set status = 'disconnected' where provider = 'zernio'");
});
afterAll(async () => {
  await db.end();
});

const NOW = new Date("2026-11-22T12:00:00Z");
const run = (z: ReturnType<typeof fakeZernio>, now = NOW) => syncContentMetrics(db, { zernio: z.client, log: silentLogger, now: () => now });

describe("sincronização de métricas (Zernio simulada)", () => {
  it("conta sem área analytics: não consulta métricas e marca needs_analytics_scope", async () => {
    const { id, acc } = await account();
    const z = fakeZernio((r) => (r.path === `accounts/${acc}` ? { body: accountBody(acc, ["posting"], ["instagram_business_basic", "instagram_business_content_publish"]) } : undefined));
    expect(await run(z)).toMatchObject({ status: "needs_analytics_scope" });
    expect(z.metricCalls()).toHaveLength(0);
    const s = (await q("select status, next_run_at from public.metrics_sync_state where social_account_id = $1", [id]))[0];
    expect(s.status).toBe("needs_analytics_scope");
    expect(new Date(s.next_run_at).getTime()).toBe(NOW.getTime() + 360 * 60_000);
    expect((await q("select count(*)::int n from public.social_posts where social_account_id = $1", [id]))[0].n).toBe(0);
    // não roda de novo antes do horário
    expect(await run(z)).toEqual({ synced: 0 });
  });

  it("com escopo: grava posts do ReelsFlow (vinculados à biblioteca) e externos, foto diária; idempotente", async () => {
    const { id, acc } = await account();
    const { media, ext } = await reelsflowPublication(id, "zpost-rf-1", "17900000000000111");
    const ours = row(acc, { postId: "zpost-rf-1", platformPostId: "17900000000000111", metrics: { views: 4000, likes: 300, comments: 20, shares: 50 } });
    const z = fakeZernio((r) => {
      if (r.path === `accounts/${acc}`) return { body: accountBody(acc, [...WITH_ANALYTICS[0]], [...WITH_ANALYTICS[1]]) };
      if (r.path === "metrics/posts" && r.query.get("postId")) return { body: { data: [ours] } };
      if (r.path === "metrics/posts" && r.query.get("accountId") === acc) {
        return r.query.get("cursor")
          ? { body: { data: [ours], pagination: { hasMore: false, nextCursor: null } } }
          : { body: { data: [row(acc), row("outra-conta", { platformPostId: "1" })], pagination: { hasMore: true, nextCursor: "c2" } } };
      }
      return undefined;
    });
    expect(await run(z)).toMatchObject({ status: "ok", synced: 2 });
    const calls = z.metricCalls();
    expect(calls.find((c) => c.query.get("postId"))?.query.get("postId")).toBe("zpost-rf-1");
    expect(calls.find((c) => c.query.get("accountId"))?.query.get("fromDate")).toBe("2026-08-23"); // 92 dias, inclusive
    expect(calls.filter((c) => c.query.get("accountId"))).toHaveLength(2); // paginou

    const posts = await q("select platform_post_id, origin, media_asset_id, external_publication_id, views, likes, saves, engagement_rate, avg_watch_ms, metrics_updated_at from public.social_posts where social_account_id = $1 order by platform_post_id", [id]);
    expect(posts).toHaveLength(2); // conta de outra pessoa ignorada
    expect(posts[0]).toMatchObject({ platform_post_id: "17900000000000111", origin: "reelsflow", media_asset_id: media, external_publication_id: ext, views: "4000", saves: null });
    expect(posts[1]).toMatchObject({ platform_post_id: "17900000000000999", origin: "external", media_asset_id: null, views: "1500", engagement_rate: "6.4000", avg_watch_ms: "4200" });

    // nova rodada (mesmo dia): sem duplicar, atualiza a foto do dia
    await q("update public.metrics_sync_state set next_run_at = 'epoch' where social_account_id = $1", [id]);
    (ours.metrics as Record<string, number>).views = 4500;
    await run(z, new Date(NOW.getTime() + 3 * 3600_000));
    expect((await q("select count(*)::int n from public.social_posts where social_account_id = $1", [id]))[0].n).toBe(2);
    const daily = await q("select d.day::text, d.views from public.social_post_metrics_daily d join public.social_posts p on p.id = d.social_post_id where p.platform_post_id = '17900000000000111' and p.social_account_id = $1", [id]);
    expect(daily).toEqual([{ day: "2026-11-22", views: "4500" }]);
    const st = (await q("select status, posts_seen, last_success_at from public.metrics_sync_state where social_account_id = $1", [id]))[0];
    expect(st).toMatchObject({ status: "ok", posts_seen: 2 });
  });

  it("Zernio ainda não sincronizou (lastSyncedAt nulo): não grava métricas nem foto (não inventa zero)", async () => {
    const { id, acc } = await account();
    const z = fakeZernio((r) =>
      r.path === `accounts/${acc}` ? { body: accountBody(acc, [...WITH_ANALYTICS[0]], [...WITH_ANALYTICS[1]]) }
      : r.path === "metrics/posts" ? { body: { data: [row(acc, { lastSyncedAt: null, syncStatus: "pending", metrics: { views: 0 } })] } }
      : undefined,
    );
    await run(z);
    const p = (await q("select id, views, metrics_updated_at, provider_sync_status from public.social_posts where social_account_id = $1", [id]))[0];
    expect(p).toMatchObject({ views: null, metrics_updated_at: null, provider_sync_status: "pending" });
    expect((await q("select count(*)::int n from public.social_post_metrics_daily where social_post_id = $1", [p.id]))[0].n).toBe(0);
  });

  it("429: respeita Retry-After; 402: tenta em 24 h; nunca lança", async () => {
    const { id, acc } = await account();
    let status = 429;
    const z = fakeZernio((r) =>
      r.path === `accounts/${acc}` ? { body: accountBody(acc, [...WITH_ANALYTICS[0]], [...WITH_ANALYTICS[1]]) }
      : r.path === "metrics/posts" ? { status, body: { error: "x" }, headers: { "Retry-After": "1800" } }
      : undefined,
    );
    expect(await run(z)).toMatchObject({ status: "error" });
    let s = (await q("select status, next_run_at, last_error from public.metrics_sync_state where social_account_id = $1", [id]))[0];
    expect(s.status).toBe("rate_limited");
    expect(new Date(s.next_run_at).getTime()).toBe(NOW.getTime() + 30 * 60_000);
    await q("update public.metrics_sync_state set next_run_at = 'epoch' where social_account_id = $1", [id]);
    status = 402;
    await run(z);
    s = (await q("select status, next_run_at, last_error from public.metrics_sync_state where social_account_id = $1", [id]))[0];
    expect(s.status).toBe("error");
    expect(s.last_error).toContain("402");
    expect(new Date(s.next_run_at).getTime()).toBe(NOW.getTime() + 24 * 3600_000);
  });
});
