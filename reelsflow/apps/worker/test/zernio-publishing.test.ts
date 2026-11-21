import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConnectorRegistry } from "@reelsflow/connectors";
import { ZernioClient, ZernioConnector } from "@reelsflow/connectors/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../src/log";
import { syncZernioAccounts } from "../src/publishing/zernio-accounts";
import { LocalStorage } from "../src/storage";
import { tick, type WorkerDeps } from "../src/worker";
import { makeDb } from "./db";

/**
 * Worker + banco real (Postgres local) + API da Zernio SIMULADA. Nenhuma chamada sai da máquina.
 */
const db = makeDb(5);
const tmp = mkdtempSync(path.join(os.tmpdir(), "rf-zernio-"));
const PROFILE = "6b00e219a6e2ffc97925922b";
let user: string;
let ws: string;
const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;
const hex24 = () => randomBytes(12).toString("hex");

type Req = { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: any };
function fakeZernio(route: (r: Req) => { status?: number; body?: unknown } | Error | undefined) {
  const calls: Req[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const r: Req = { method: init?.method ?? "GET", path: u.pathname.replace("/api/v1/", ""), query: u.searchParams, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(r);
    const out = route(r);
    if (out instanceof Error) throw out;
    if (!out) return new Response(JSON.stringify({ error: `não simulado ${r.method} ${r.path}` }), { status: 404 });
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200 });
  }) as unknown as typeof fetch;
  const client = new ZernioClient({ apiKey: "sk_test", fetchImpl });
  return { calls, client, creates: () => calls.filter((c) => c.method === "POST" && c.path === "posts") };
}

const mediaTtls: (number | undefined)[] = [];
function depsWith(z: ReturnType<typeof fakeZernio> | null): WorkerDeps {
  const connectors = new ConnectorRegistry();
  if (z) connectors.register(new ZernioConnector(z.client, { sleep: async () => {}, pollBudgetMs: 0 }));
  return {
    db,
    storage: new LocalStorage(tmp),
    log: silentLogger,
    ffmpeg: { ffprobe: "ffprobe", ffmpeg: "ffmpeg" },
    tmpDir: tmp,
    connectors,
    mediaUrl: async (p, ttl) => {
      mediaTtls.push(ttl);
      return `https://storage.test/${p}?token=assinado`;
    },
    zernio: z?.client ?? null,
  };
}
const opts = { workerId: "wz", concurrency: 2, leaseSeconds: 60, pollMs: 50, maintenanceEveryMs: 1e9, reconcileMinAgeSeconds: 0 };

async function zernioAccount(profile = PROFILE) {
  const acc = hex24();
  const id = (await q("select public.link_zernio_account($1, $2, $3, 'instagram', 'pipocoumemes', 'Pipocou') as id", [ws, acc, profile]))[0].id;
  await q("update public.social_accounts set min_spacing_minutes = 0 where id = $1", [id]);
  return { id, acc };
}
const account = (acc: string, profile = PROFILE) => ({ account: { _id: acc, platform: "instagram", profileId: profile, isActive: true } });
const postBody = (acc: string, jobId: string, status: string, target: Record<string, unknown> = {}) => ({
  post: { _id: `post-${jobId.slice(0, 8)}`, status, externalId: `reelsflow-job-${jobId}`, platforms: [{ platform: "instagram", accountId: acc, status: "pending", ...target }] },
});
const publishedBody = (acc: string, jobId: string) =>
  postBody(acc, jobId, "published", { status: "published", platformPostId: "17900000000000123", platformPostUrl: "https://www.instagram.com/reel/PIPOCOU/" });

async function dueJob(accountId: string) {
  const camp = (await q("insert into public.campaigns (workspace_id, name, status, timezone, weekdays, times, start_date, caption, created_by) values ($1,'Diária','active','America/Sao_Paulo','{1,2,3,4,5,6,7}','{09:00}',current_date,'Legenda #memes',$2) returning id", [ws, user]))[0].id;
  const media = (await q("insert into public.media_assets (workspace_id, name, original_filename, storage_path, mime_type, size_bytes, sha256, status) values ($1,'v','v.mp4',$2,'video/mp4',10,$3,'uploading') returning id", [ws, `${ws}/${crypto.randomUUID()}/original.mp4`, "f".repeat(64)]))[0].id;
  for (const s of ["uploaded", "processing", "ready"]) await q("update public.media_assets set status = $2 where id = $1", [media, s]);
  const target = (await q("insert into public.campaign_targets (campaign_id, workspace_id, social_account_id) values ($1,$2,$3) returning id", [camp, ws, accountId]))[0].id;
  const cm = (await q("insert into public.campaign_media (campaign_id, workspace_id, media_asset_id) values ($1,$2,$3) returning id", [camp, ws, media]))[0].id;
  const at = new Date(Date.now() - 1000).toISOString();
  const id = (await q("insert into public.publication_jobs (workspace_id, campaign_id, campaign_media_id, target_id, social_account_id, media_asset_id, local_date, local_time, timezone, scheduled_at, status, next_attempt_at) values ($1,$2,$3,$4,$5,$6,current_date,'09:00','America/Sao_Paulo',$7,'draft',$7) returning id", [ws, camp, cm, target, accountId, media, at]))[0].id;
  await q("update public.publication_jobs set status = 'scheduled' where id = $1", [id]);
  return id;
}
const job = async (id: string) => (await q("select * from public.publication_jobs where id = $1", [id]))[0];
const again = (id: string) => q("update public.publication_jobs set next_attempt_at = now() where id = $1", [id]);

beforeAll(async () => {
  user = (await q("insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id", [`zernio-${Date.now()}@t.local`]))[0].id;
  ws = (await q("insert into public.workspaces (name, slug, created_by) values ('Leeoh Nasc', $1, $2) returning id", [`leeoh-${Date.now()}`, user]))[0].id;
  await q("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'owner')", [ws, user]);
  await q("insert into public.subscriptions (workspace_id, plan) values ($1, 'agency')", [ws]); // várias contas de teste no mesmo workspace
});
beforeEach(async () => {
  await q("delete from public.publication_jobs");
  mediaTtls.length = 0;
});
afterAll(async () => {
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

describe("worker + Zernio (API simulada)", () => {
  it("no horário: publica via Zernio, grava ID e link do Reel, sem token no ReelsFlow e com URL do vídeo de 24 h", async () => {
    const { id: accId, acc } = await zernioAccount();
    let jobId = "";
    const z = fakeZernio((r) =>
      r.path === `accounts/${acc}` ? { body: account(acc) } : r.method === "POST" && r.path === "posts" ? { status: 201, body: publishedBody(acc, jobId) } : undefined,
    );
    jobId = await dueJob(accId);
    await tick(depsWith(z), opts, { lastMaintenance: Date.now() });
    expect(await job(jobId)).toMatchObject({ status: "published" });
    expect((await q("select platform, external_id, permalink, source from public.external_publications where job_id = $1", [jobId]))[0]).toEqual({
      platform: "instagram",
      external_id: "17900000000000123",
      permalink: "https://www.instagram.com/reel/PIPOCOU/",
      source: "api",
    });
    const create = z.creates()[0]!;
    expect(create.headers["Idempotency-Key"]).toBe(`reelsflow-job-${jobId}`);
    expect(create.body).toMatchObject({ publishNow: true, externalId: `reelsflow-job-${jobId}`, content: "Legenda #memes", platforms: [{ accountId: acc }] });
    expect(mediaTtls).toEqual([24 * 3600]);
    expect((await q("select count(*)::int n from public.social_account_tokens where social_account_id = $1", [accId]))[0].n).toBe(0);
  });

  it("sem ZERNIO_API_KEY no worker: a publicação ESPERA (sem gastar tentativa) e a conta continua ativa", async () => {
    const { id: accId } = await zernioAccount();
    const jobId = await dueJob(accId);
    await tick(depsWith(null), opts, { lastMaintenance: Date.now() });
    expect(await job(jobId)).toMatchObject({ status: "failed_retryable", attempt_count: 0 });
    expect((await q("select error_code from public.publication_attempts where job_id = $1", [jobId]))[0].error_code).toBe("zernio_not_configured");
    expect((await q("select status from public.social_accounts where id = $1", [accId]))[0].status).toBe("active");
  });

  it("Zernio ainda publicando: tentativas seguintes só consultam o MESMO post, sem gastar tentativas, até publicar", async () => {
    const { id: accId, acc } = await zernioAccount();
    let jobId = "";
    let gets = 0;
    const z = fakeZernio((r) => {
      if (r.path === `accounts/${acc}`) return { body: account(acc) };
      if (r.method === "POST" && r.path === "posts") return { status: 201, body: postBody(acc, jobId, "publishing", { status: "processing" }) };
      if (r.method === "GET" && r.path.startsWith("posts/")) return { body: ++gets < 3 ? postBody(acc, jobId, "publishing", { status: "processing" }) : publishedBody(acc, jobId) };
    });
    jobId = await dueJob(accId);
    for (let i = 0; i < 3; i++) {
      await tick(depsWith(z), opts, { lastMaintenance: Date.now() });
      expect(await job(jobId)).toMatchObject({ status: "failed_retryable", attempt_count: 0 });
      await again(jobId);
    }
    await tick(depsWith(z), opts, { lastMaintenance: Date.now() });
    expect(await job(jobId)).toMatchObject({ status: "published" });
    expect(z.creates()).toHaveLength(1);
  });

  it("queda de rede no pedido de publicação: INCERTO → reconciliação acha o post pelo externalId; nunca dois posts", async () => {
    const { id: accId, acc } = await zernioAccount();
    let jobId = "";
    let failCreate = true;
    const z = fakeZernio((r) => {
      if (r.path === `accounts/${acc}`) return { body: account(acc) };
      if (r.method === "POST" && r.path === "posts") return failCreate ? new TypeError("fetch failed") : { status: 200, body: publishedBody(acc, jobId) };
      if (r.method === "GET" && r.path === "posts") return { body: { posts: [publishedBody(acc, jobId).post] } };
    });
    jobId = await dueJob(accId);
    await tick(depsWith(z), { ...opts, reconcileMinAgeSeconds: 3600 }, { lastMaintenance: Date.now() });
    expect((await job(jobId)).status).toBe("uncertain");
    failCreate = false;
    await tick(depsWith(z), opts, { lastMaintenance: Date.now() });
    expect(await job(jobId)).toMatchObject({ status: "published" });
    expect((await q("select source, external_id from public.external_publications where job_id = $1", [jobId]))[0]).toEqual({ source: "reconciled", external_id: "17900000000000123" });
    expect(z.creates()).toHaveLength(1); // a reconciliação NÃO recria o post
  });

  it("incerto e a Zernio não recebeu: repete com a MESMA Idempotency-Key (a Zernio nunca cria dois)", async () => {
    const { id: accId, acc } = await zernioAccount();
    let jobId = "";
    let n = 0;
    const z = fakeZernio((r) => {
      if (r.path === `accounts/${acc}`) return { body: account(acc) };
      if (r.method === "POST" && r.path === "posts") return n++ === 0 ? new TypeError("fetch failed") : { status: 201, body: publishedBody(acc, jobId) };
      if (r.method === "GET" && r.path === "posts") return { body: { posts: [] } };
    });
    jobId = await dueJob(accId);
    await tick(depsWith(z), { ...opts, reconcileMinAgeSeconds: 3600 }, { lastMaintenance: Date.now() });
    await tick(depsWith(z), opts, { lastMaintenance: Date.now() }); // reconcilia: not_found → fila
    await again(jobId);
    await tick(depsWith(z), opts, { lastMaintenance: Date.now() });
    expect(await job(jobId)).toMatchObject({ status: "published" });
    const keys = z.creates().map((c) => c.headers["Idempotency-Key"]);
    expect(keys).toEqual([`reelsflow-job-${jobId}`, `reelsflow-job-${jobId}`]);
  });

  it("conta que não pertence ao perfil do workspace: falha definitiva sem criar post", async () => {
    const { id: accId, acc } = await zernioAccount();
    const z = fakeZernio((r) => (r.path === `accounts/${acc}` ? { body: account(acc, "cccccccccccccccccccccccc") } : undefined));
    const jobId = await dueJob(accId);
    await tick(depsWith(z), opts, { lastMaintenance: Date.now() });
    expect(await job(jobId)).toMatchObject({ status: "failed_permanent" });
    expect(z.creates()).toHaveLength(0);
  });

  it("rejeição da rede (conteúdo): falha definitiva com o motivo e notificação; sem nova tentativa", async () => {
    const { id: accId, acc } = await zernioAccount();
    let jobId = "";
    const z = fakeZernio((r) =>
      r.path === `accounts/${acc}`
        ? { body: account(acc) }
        : r.method === "POST"
          ? { status: 207, body: postBody(acc, jobId, "failed", { status: "failed", errorCategory: "user_content", errorMessage: "Unsupported video format" }) }
          : undefined,
    );
    jobId = await dueJob(accId);
    await tick(depsWith(z), opts, { lastMaintenance: Date.now() });
    const j = await job(jobId);
    expect(j).toMatchObject({ status: "failed_permanent" });
    expect(j.last_error_message).toContain("Unsupported video format");
    const n = await q("select count(*)::int n from public.notifications where type = 'publication.failed' and payload ->> 'job_id' = $1", [jobId]);
    expect(n[0].n).toBe(1);
  });
});

describe("sincronização de saúde das contas Zernio", () => {
  it("precisa reconectar → conta segura as publicações e admins são avisados; voltou → reativa sozinha", async () => {
    const { id: accId, acc } = await zernioAccount();
    let healthy = false;
    const z = fakeZernio((r) => (r.path === "accounts/health" ? { body: { accounts: [{ accountId: acc, canPost: healthy, needsReconnect: !healthy, status: healthy ? "healthy" : "error" }] } } : undefined));
    await syncZernioAccounts(db, { zernio: z.client, log: silentLogger });
    expect((await q("select status from public.social_accounts where id = $1", [accId]))[0].status).toBe("needs_reauth");
    expect((await q("select count(*)::int n from public.notifications where type = 'account.disconnected' and payload ->> 'account_id' = $1", [accId]))[0].n).toBe(1);

    // Dentro de 10 min não consulta de novo (limite da API).
    const before = z.calls.length;
    await syncZernioAccounts(db, { zernio: z.client, log: silentLogger });
    expect(z.calls.length).toBe(before);

    healthy = true;
    await q("update public.social_accounts set settings = settings - 'zernio_checked_at' where id = $1", [accId]);
    await syncZernioAccounts(db, { zernio: z.client, log: silentLogger });
    expect((await q("select status from public.social_accounts where id = $1", [accId]))[0].status).toBe("active");
  });
});
