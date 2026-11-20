import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { ConnectorRegistry, MockConnector } from "@reelsflow/connectors";
import { makeDb } from "./db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../src/log";
import { appendFromCollections, completeCampaigns, lowContentAlerts } from "../src/publishing/automations";
import { reconcileUncertain } from "../src/publishing/execute";
import { claimPublications, promoteDue, reapPublicationLeases } from "../src/publishing/scheduler";
import { PgMockStore } from "../src/publishing/store";
import { LocalStorage } from "../src/storage";
import { tick, type WorkerDeps } from "../src/worker";

const db = makeDb(10);
const tmp = mkdtempSync(path.join(os.tmpdir(), "rf-pub-"));
const connectors = new ConnectorRegistry().register(new MockConnector(new PgMockStore(db)));
const deps: WorkerDeps = { db, storage: new LocalStorage(tmp), log: silentLogger, ffmpeg: { ffprobe: "ffprobe", ffmpeg: "ffmpeg" }, tmpDir: tmp, connectors };
const opts = (workerId = "w1") => ({ workerId, concurrency: 4, leaseSeconds: 60, pollMs: 50, maintenanceEveryMs: 1e9, reconcileMinAgeSeconds: 0 });
const run = (workerId = "w1") => tick(deps, opts(workerId), { lastMaintenance: Date.now() });

let user: string;
let ws: string;

async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) {
  return (await db.query<T>(sql, params)).rows;
}

async function account(behavior = "success", spacing = 0, name = "Sim") {
  return (
    await q<{ id: string }>(
      `insert into public.social_accounts (workspace_id, platform, external_account_id, display_name, min_spacing_minutes, settings)
       values ($1, 'mock', $2, $3, $4, jsonb_build_object('mock_behavior', $5::text)) returning id`,
      [ws, `ext-${crypto.randomUUID()}`, name, spacing, behavior],
    )
  )[0]!.id;
}

async function media(caption: string | null = null) {
  return (
    await q<{ id: string }>(
      `insert into public.media_assets (workspace_id, uploaded_by, name, original_filename, storage_path, mime_type, size_bytes, sha256, status, default_caption)
       values ($1, $2, 'clip', 'clip.mp4', $3, 'video/mp4', 10, $4, 'uploading', $5) returning id`,
      [ws, user, `${ws}/${crypto.randomUUID()}/original.mp4`, "c".repeat(64), caption],
    )
  )[0]!.id;
}

async function readyMedia(caption: string | null = null) {
  const id = await media(caption);
  for (const s of ["uploaded", "processing", "ready"]) await db.query("update public.media_assets set status = $2 where id = $1", [id, s]);
  return id;
}

async function campaign(over: { status?: string; lateness?: number; caption?: string | null; collection?: string | null; endDate?: string | null } = {}) {
  return (
    await q<{ id: string }>(
      `insert into public.campaigns (workspace_id, name, status, timezone, weekdays, times, start_date, end_date, max_lateness_minutes, caption, source_collection_id, created_by)
       values ($1, 'Camp', $2, 'America/Sao_Paulo', '{1,2,3,4,5,6,7}', '{09:00}', current_date, $3, $4, $5, $6, $7) returning id`,
      [ws, over.status ?? "active", over.endDate ?? null, over.lateness ?? 120, over.caption ?? null, over.collection ?? null, user],
    )
  )[0]!.id;
}

/** Cria publicação já agendada (por padrão vencida há 1 segundo). */
async function job(opts: { campaign?: string; account: string; media?: string; at?: string; maxAttempts?: number }) {
  const camp = opts.campaign ?? (await campaign());
  const m = opts.media ?? (await readyMedia());
  const target =
    (await q<{ id: string }>("select id from public.campaign_targets where campaign_id = $1 and social_account_id = $2", [camp, opts.account]))[0]?.id ??
    (await q<{ id: string }>("insert into public.campaign_targets (campaign_id, workspace_id, social_account_id) values ($1,$2,$3) returning id", [camp, ws, opts.account]))[0]!.id;
  const cm = (await q<{ id: string }>("insert into public.campaign_media (campaign_id, workspace_id, media_asset_id) values ($1,$2,$3) returning id", [camp, ws, m]))[0]!.id;
  const at = opts.at ?? new Date(Date.now() - 1000).toISOString();
  const id = (
    await q<{ id: string }>(
      `insert into public.publication_jobs (workspace_id, campaign_id, campaign_media_id, target_id, social_account_id, media_asset_id,
                                            local_date, local_time, timezone, scheduled_at, status, next_attempt_at, max_attempts)
       values ($1,$2,$3,$4,$5,$6, current_date, '09:00', 'America/Sao_Paulo', $7, 'draft', $7, $8) returning id`,
      [ws, camp, cm, target, opts.account, m, at, opts.maxAttempts ?? 6],
    )
  )[0]!.id;
  await db.query("update public.publication_jobs set status = 'scheduled' where id = $1", [id]);
  return id;
}

const jobRow = async (id: string) => (await q("select * from public.publication_jobs where id = $1", [id]))[0]!;
const remotePosts = async (accountId: string) => (await q("select * from public.mock_remote_posts where social_account_id = $1", [accountId])).length;
const makeDue = (id: string) => db.query("update public.publication_jobs set next_attempt_at = now() - interval '1 second' where id = $1", [id]);

beforeAll(async () => {
  user = (await q<{ id: string }>("insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id", [`pub-${Date.now()}@t.local`]))[0]!.id;
  ws = (await q<{ id: string }>("insert into public.workspaces (name, slug, created_by) values ('Pub', $1, $2) returning id", [`pub-${Date.now()}`, user]))[0]!.id;
  await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, user]);
});

beforeEach(async () => {
  await db.query("delete from public.publication_jobs");
  await db.query("update public.media_jobs set status = 'cancelled' where status in ('queued','running')");
  await db.query("update public.workspaces set queue_paused = false where id = $1", [ws]);
  await db.query("delete from public.automation_rules where workspace_id = $1", [ws]);
});

afterAll(async () => {
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

describe("publicação com conector simulado", () => {
  it("sucesso: publica, registra ID externo, tentativa e notificação", async () => {
    const acc = await account("success");
    const id = await job({ account: acc });
    await run();
    const j = await jobRow(id);
    expect(j.status).toBe("published");
    expect(j.attempt_count).toBe(1);
    const ext = await q("select external_id, permalink, source from public.external_publications where job_id = $1", [id]);
    expect(ext[0]).toMatchObject({ source: "api" });
    expect(ext[0]!.permalink).toContain("mock.reelsflow.invalid");
    expect(await remotePosts(acc)).toBe(1);
    const att = await q("select outcome, phase_reached from public.publication_attempts where job_id = $1", [id]);
    expect(att).toEqual([{ outcome: "published", phase_reached: "publishing" }]);
    expect((await q("select 1 from public.notifications where type = 'publication.published' and payload->>'job_id' = $1", [id])).length).toBe(1);
  });

  it("erro transitório: reagenda com backoff e publica na próxima tentativa", async () => {
    const acc = await account("flaky");
    const id = await job({ account: acc });
    await run();
    let j = await jobRow(id);
    expect(j.status).toBe("failed_retryable");
    expect(new Date(j.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
    await makeDue(id);
    await run();
    j = await jobRow(id);
    expect(j.status).toBe("published");
    expect(j.attempt_count).toBe(2);
  });

  it("erro permanente: falha definitiva (DLQ) e notificação", async () => {
    const acc = await account("permanent");
    const id = await job({ account: acc });
    await run();
    expect((await jobRow(id)).status).toBe("failed_permanent");
    expect((await q("select 1 from public.notifications where type = 'publication.failed' and payload->>'job_id' = $1", [id])).length).toBe(1);
    expect(await remotePosts(acc)).toBe(0);
  });

  it("tentativas esgotadas viram falha permanente", async () => {
    const acc = await account("transient");
    const id = await job({ account: acc, maxAttempts: 2 });
    await run();
    expect((await jobRow(id)).status).toBe("failed_retryable");
    await makeDue(id);
    await run();
    expect(await jobRow(id)).toMatchObject({ status: "failed_permanent", attempt_count: 2 });
  });

  it("regra de retry desligada: uma única tentativa", async () => {
    const acc = await account("transient");
    await db.query("insert into public.automation_rules (workspace_id, rule_key, enabled) values ($1, 'retry_transient', false)", [ws]);
    const id = await job({ account: acc });
    await run();
    expect((await jobRow(id)).status).toBe("failed_permanent");
  });

  it("rate limit: respeita Retry-After", async () => {
    const acc = await account("rate_limit");
    const id = await job({ account: acc });
    await run();
    const j = await jobRow(id);
    expect(j.status).toBe("failed_retryable");
    const wait = (new Date(j.next_attempt_at).getTime() - Date.now()) / 1000;
    expect(wait).toBeGreaterThan(100);
    expect(wait).toBeLessThan(130);
  });

  it("timeout antes do envio: retry seguro, nada publicado", async () => {
    const acc = await account("timeout_before");
    const id = await job({ account: acc });
    await run();
    expect((await jobRow(id)).status).toBe("failed_retryable");
    expect(await remotePosts(acc)).toBe(0);
  });

  it("timeout DEPOIS de publicar: estado incerto → reconciliação confirma, sem duplicar", async () => {
    const acc = await account("timeout_after");
    const id = await job({ account: acc });
    await tick(deps, { ...opts(), reconcileMinAgeSeconds: 3600 }, { lastMaintenance: Date.now() });
    expect((await jobRow(id)).status).toBe("uncertain");
    expect(await remotePosts(acc)).toBe(1);

    // O próximo ciclo NÃO reenvia a publicação incerta: só reconcilia.
    await run();
    const kinds = await q("select kind, outcome from public.publication_attempts where job_id = $1 order by id", [id]);
    expect(kinds).toEqual([
      { kind: "publish", outcome: "uncertain" },
      { kind: "reconcile", outcome: "published" },
    ]);
    const j = await jobRow(id);
    expect(j.status).toBe("published");
    expect(await remotePosts(acc)).toBe(1);
    const ext = await q("select source from public.external_publications where job_id = $1", [id]);
    expect(ext[0]!.source).toBe("reconciled");
  });

  it("resultado nunca confirmado: após 5 consultas vai para revisão humana", async () => {
    const acc = await account("uncertain");
    const id = await job({ account: acc });
    await tick(deps, { ...opts(), reconcileMinAgeSeconds: 3600 }, { lastMaintenance: Date.now() });
    expect((await jobRow(id)).status).toBe("uncertain");
    for (let i = 0; i < 5; i++) await reconcileUncertain({ db, connectors, log: silentLogger, workerId: "r" }, 20, 0);
    expect(await jobRow(id)).toMatchObject({ status: "needs_review", review_reason: "uncertain_unresolved", reconcile_attempts: 5 });
    expect(await remotePosts(acc)).toBe(1);
  });

  it("token revogado: conta sem autorização, publicações da conta aguardam, admins avisados", async () => {
    const acc = await account("auth_revoked");
    const camp = await campaign();
    const id1 = await job({ account: acc, campaign: camp });
    const id2 = await job({ account: acc, campaign: camp, at: new Date(Date.now() - 500).toISOString() });
    await run();
    expect((await q("select status from public.social_accounts where id = $1", [acc]))[0]!.status).toBe("needs_reauth");
    expect((await jobRow(id1)).status).toBe("failed_retryable");
    await run();
    expect((await jobRow(id2)).status).toBe("queued"); // não é reivindicada enquanto a conta não for reconectada
    expect((await q("select 1 from public.notifications where type = 'account.disconnected' and payload->>'account_id' = $1", [acc])).length).toBeGreaterThan(0);
    expect((await q("select 1 from public.automation_runs where rule_key = 'pause_on_auth_loss' and subject_id = $1", [acc])).length).toBe(1);
  });

  it("vídeo excluído antes do horário: falha permanente explicada", async () => {
    const acc = await account("success");
    const m = await readyMedia();
    const id = await job({ account: acc, media: m });
    await db.query("update public.media_assets set deleted_at = now() where id = $1", [m]);
    await run();
    expect(await jobRow(id)).toMatchObject({ status: "failed_permanent", last_error_class: "media_unavailable" });
  });

  it("precedência: legenda do vídeo vence a da campanha; origem registrada", async () => {
    const acc = await account("success");
    const camp = await campaign({ caption: "Legenda da campanha" });
    const id1 = await job({ account: acc, campaign: camp, media: await readyMedia("Legenda do vídeo") });
    await run();
    expect((await jobRow(id1)).effective_config).toMatchObject({ caption: "Legenda do vídeo", sources: { caption: "media" } });
    const acc2 = await account("success");
    const id2 = await job({ account: acc2, campaign: camp, media: await readyMedia(null) });
    await run();
    expect((await jobRow(id2)).effective_config).toMatchObject({ caption: "Legenda da campanha", sources: { caption: "campaign" } });
  });
});

describe("garantias da fila", () => {
  it.each(Array.from({ length: Number(process.env.STRESS_ROUNDS ?? 1) }, (_, i) => i))("3 workers concorrentes, 30 publicações em 10 contas: cada uma publicada exatamente uma vez (#%i)", async () => {
    const accounts = await Promise.all(Array.from({ length: 10 }, () => account("success")));
    const camp = await campaign();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(await job({ account: accounts[i % 10]!, campaign: camp, at: new Date(Date.now() - 60_000 + i).toISOString() }));
    for (let round = 0; round < 6; round++) await Promise.all([run("wa"), run("wb"), run("wc")]);
    const statuses = await q<{ status: string; n: number }>("select status::text, count(*)::int as n from public.publication_jobs where id = any($1) group by status", [ids]);
    expect(statuses).toEqual([{ status: "published", n: 30 }]);
    const posts = await q<{ n: number }>("select count(*)::int as n from public.mock_remote_posts where social_account_id = any($1)", [accounts]);
    expect(posts[0]!.n).toBe(30);
    const ext = await q<{ n: number }>("select count(*)::int as n from public.external_publications where job_id = any($1)", [ids]);
    expect(ext[0]!.n).toBe(30);
  });

  it("no máximo uma publicação em andamento por conta (índice único)", async () => {
    const acc = await account("success");
    const camp = await campaign();
    const a = await job({ account: acc, campaign: camp });
    const b = await job({ account: acc, campaign: camp });
    await promoteDue(db);
    const claimed = await claimPublications(db, "x", 10, 60);
    expect(claimed.map((c) => c.id)).toEqual([a]);
    await expect(db.query("update public.publication_jobs set status = 'preparing' where id = $1", [b])).rejects.toThrow(/one_inflight/);
  });

  it("espaçamento mínimo entre publicações da mesma conta", async () => {
    const acc = await account("success", 30);
    const camp = await campaign();
    const a = await job({ account: acc, campaign: camp });
    const b = await job({ account: acc, campaign: camp });
    await run();
    await run();
    expect((await jobRow(a)).status).toBe("published");
    expect((await jobRow(b)).status).toBe("queued");
  });

  it("worker morre antes de enviar: volta à fila e publica uma vez", async () => {
    const acc = await account("success");
    const id = await job({ account: acc });
    await promoteDue(db);
    await claimPublications(db, "morto", 1, 60);
    await db.query("update public.publication_jobs set lease_expires_at = now() - interval '1 s' where id = $1", [id]);
    expect(await reapPublicationLeases(db)).toEqual({ requeued: 1, uncertain: 0 });
    await run();
    expect((await jobRow(id)).status).toBe("published");
    expect(await remotePosts(acc)).toBe(1);
  });

  it("worker morre DEPOIS de publicar: incerto → reconciliado, sem duplicar", async () => {
    const acc = await account("success");
    const id = await job({ account: acc });
    await promoteDue(db);
    await claimPublications(db, "morto", 1, 60);
    // simula o worker que gravou checkpoint, publicou e morreu antes de registrar
    const store = new PgMockStore(db);
    await db.query("update public.publication_jobs set status = 'uploading', external_checkpoint = $2 where id = $1", [id, JSON.stringify({ upload_ref: `${id}:1` })]);
    await store.createUpload(acc, `${id}:1`, "x");
    await store.publish(`${id}:1`);
    await db.query("update public.publication_jobs set lease_expires_at = now() - interval '1 s' where id = $1", [id]);
    expect(await reapPublicationLeases(db)).toEqual({ requeued: 0, uncertain: 1 });
    await run();
    expect((await jobRow(id)).status).toBe("published");
    expect(await remotePosts(acc)).toBe(1);
  });

  it("incerto sem publicação na plataforma: retry seguro", async () => {
    const acc = await account("success");
    const id = await job({ account: acc });
    await promoteDue(db);
    await claimPublications(db, "morto", 1, 60);
    await db.query("update public.publication_jobs set status = 'uploading', external_checkpoint = $2 where id = $1", [id, JSON.stringify({ upload_ref: "nunca-chegou" })]);
    await db.query("update public.publication_jobs set lease_expires_at = now() - interval '1 s' where id = $1", [id]);
    await reapPublicationLeases(db);
    await reconcileUncertain({ db, connectors, log: silentLogger, workerId: "r" }, 20, 0);
    expect((await jobRow(id)).status).toBe("failed_retryable");
    await run();
    expect((await jobRow(id)).status).toBe("published");
    expect(await remotePosts(acc)).toBe(1);
  });

  it("pausas: campanha, conta e fila do workspace impedem a publicação", async () => {
    const acc = await account("success");
    const paused = await campaign({ status: "paused" });
    const j1 = await job({ account: acc, campaign: paused });
    await run();
    expect((await jobRow(j1)).status).toBe("scheduled");

    const acc2 = await account("success");
    await db.query("update public.social_accounts set paused = true where id = $1", [acc2]);
    const j2 = await job({ account: acc2 });
    await run();
    expect((await jobRow(j2)).status).toBe("scheduled");

    const acc3 = await account("success");
    const j3 = await job({ account: acc3 });
    await promoteDue(db);
    await db.query("update public.workspaces set queue_paused = true where id = $1", [ws]);
    await run();
    expect((await jobRow(j3)).status).toBe("queued");
    await db.query("update public.workspaces set queue_paused = false where id = $1", [ws]);
    await run();
    expect((await jobRow(j3)).status).toBe("published");
  });

  it("política de atraso: vencida além da tolerância vai para revisão, não publica em rajada", async () => {
    const acc = await account("success");
    const camp = await campaign({ lateness: 60 });
    const id = await job({ account: acc, campaign: camp, at: new Date(Date.now() - 3 * 3600_000).toISOString() });
    await run();
    expect(await jobRow(id)).toMatchObject({ status: "needs_review", review_reason: "late" });
    expect(await remotePosts(acc)).toBe(0);
  });
});

describe("automações", () => {
  it("regra 1: vídeos novos da coleção entram no fim da fila", async () => {
    const acc = await account("success");
    const col = (await q<{ id: string }>("insert into public.collections (workspace_id, name, created_by) values ($1, $2, $3) returning id", [ws, `Col ${Date.now()}`, user]))[0]!.id;
    const camp = await campaign({ collection: col });
    const future = new Date(Date.now() + 10 * 86_400_000).toISOString();
    await job({ account: acc, campaign: camp, at: future });
    const m1 = await readyMedia();
    const m2 = await readyMedia();
    await db.query("insert into public.collection_items (collection_id, media_asset_id, workspace_id, position) values ($1,$2,$4,0),($1,$3,$4,1)", [col, m1, m2, ws]);
    expect(await appendFromCollections(db, silentLogger)).toBe(2);
    const rows = await q<{ media_asset_id: string; scheduled_at: Date; status: string }>(
      "select media_asset_id, scheduled_at, status from public.publication_jobs where campaign_id = $1 order by scheduled_at",
      [camp],
    );
    expect(rows.map((r) => r.media_asset_id).slice(1)).toEqual([m1, m2]);
    expect(rows[1]!.scheduled_at.getTime()).toBeGreaterThan(Date.parse(future));
    expect(rows.every((r) => r.status === "scheduled")).toBe(true);
    expect(await appendFromCollections(db, silentLogger)).toBe(0); // idempotente
  });

  it("regra 3: alerta de pouco conteúdo, no máximo uma vez por dia", async () => {
    const acc = await account("success");
    const camp = await campaign();
    await job({ account: acc, campaign: camp, at: new Date(Date.now() + 86_400_000).toISOString() });
    const before = (await q("select 1 from public.notifications where type = 'queue.low' and payload->>'campaign_id' = $1", [camp])).length;
    await lowContentAlerts(db);
    await lowContentAlerts(db);
    const after = (await q("select 1 from public.notifications where type = 'queue.low' and payload->>'campaign_id' = $1", [camp])).length;
    expect(after - before).toBe(1);
  });

  it("regra 4: campanha sem pendências é concluída com resumo", async () => {
    const acc = await account("success");
    const camp = await campaign();
    await job({ account: acc, campaign: camp });
    await run();
    expect(await completeCampaigns(db)).toBeGreaterThanOrEqual(1);
    const c = (await q("select status, summary from public.campaigns where id = $1", [camp]))[0]!;
    expect(c.status).toBe("completed");
    expect(c.summary).toEqual({ published: 1 });
    expect((await q("select 1 from public.notifications where type = 'campaign.completed' and payload->>'campaign_id' = $1", [camp])).length).toBe(1);
  });
});
