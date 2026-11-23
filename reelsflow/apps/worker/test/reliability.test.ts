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
import { composeEmail, deliverEmails, EmailSendError, type EmailMessage, type EmailSender } from "../src/notify/email";
import { makeDb } from "./db";

/**
 * Worker + banco real (Postgres local) + API da Zernio SIMULADA. Nenhuma chamada sai da máquina.
 */
const db = makeDb(5);
const tmp = mkdtempSync(path.join(os.tmpdir(), "rf-reliab-"));
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

async function dueJob(accountId: string, mediaOpt: { mime?: string; ext?: string } = {}) {
  const camp = (await q("insert into public.campaigns (workspace_id, name, status, timezone, weekdays, times, start_date, caption, created_by) values ($1,'Diária','active','America/Sao_Paulo','{1,2,3,4,5,6,7}','{09:00}',current_date,'Legenda #memes',$2) returning id", [ws, user]))[0].id;
  const media = (await q("insert into public.media_assets (workspace_id, name, original_filename, storage_path, mime_type, size_bytes, sha256, status) values ($1,'v','v.mp4',$2,$3,10,$4,'uploading') returning id", [ws, `${ws}/${crypto.randomUUID()}/original.${mediaOpt.ext ?? "mp4"}`, mediaOpt.mime ?? "video/mp4", "f".repeat(64)]))[0].id;
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
  user = (await q("insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id", [`reliab-${Date.now()}@t.local`]))[0].id;
  ws = (await q("insert into public.workspaces (name, slug, created_by) values ('Confiabilidade', $1, $2) returning id", [`reliab-${Date.now()}`, user]))[0].id;
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


const alert = async (key: string) => (await q("select * from public.ops_alerts where dedupe_key = $1", [key]))[0];
const mails = (fail?: (m: EmailMessage) => Error | undefined): EmailSender & { sent: EmailMessage[] } => {
  const sent: EmailMessage[] = [];
  return { name: "fake", sent, async send(m) { const e = fail?.(m); if (e) throw e; sent.push(m); } };
};
const note = async (type: string, payload: Record<string, unknown> = {}) =>
  (await q("insert into public.notifications (workspace_id, user_id, type, payload) values ($1, $2, $3, $4) returning id, email_status", [ws, user, type, JSON.stringify(payload)]))[0];

describe("confiabilidade: configuração do servidor", () => {
  for (const [status, code, body] of [
    [401, "zernio_api_key", { error: "invalid api key", code: "unauthorized" }],
    [402, "zernio_payment_required", { error: "payment required", code: "payment_required" }],
  ] as const) {
    it(`Zernio ${status}: publicação espera SEM gastar tentativa, alerta operacional único, resolvido quando volta a publicar`, async () => {
      await q("delete from public.ops_alerts");
      const { id: accId, acc } = await zernioAccount();
      let broken = true;
      let jobId = "";
      const z = fakeZernio((r) => {
        if (broken) return { status, body };
        if (r.path === `accounts/${acc}`) return { body: account(acc) };
        if (r.method === "POST" && r.path === "posts") return { status: 201, body: publishedBody(acc, jobId) };
        return undefined;
      });
      jobId = await dueJob(accId);
      await tick(depsWith(z), opts, { lastMaintenance: Date.now() });
      let j = await job(jobId);
      expect(j).toMatchObject({ status: "failed_retryable", attempt_count: 0 });
      expect(new Date(j.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
      expect(await alert(code)).toMatchObject({ kind: code, severity: "critical", occurrences: 1, resolved_at: null });
      // repete: mesmo alerta (sem duplicar), contador sobe, tentativas continuam intactas
      await again(jobId);
      await tick(depsWith(z), opts, { lastMaintenance: Date.now() });
      expect((await alert(code)).occurrences).toBe(2);
      expect((await job(jobId)).attempt_count).toBe(0);
      expect((await q("select count(*)::int n from public.ops_alerts"))[0].n).toBe(1);
      // corrigido no servidor: publica e o alerta é resolvido
      broken = false;
      await again(jobId);
      await tick(depsWith(z), opts, { lastMaintenance: Date.now() });
      j = await job(jobId);
      expect(j.status).toBe("published");
      expect((await alert(code)).resolved_at).not.toBeNull();
      expect(z.creates()).toHaveLength(1);
    });
  }
});

describe("confiabilidade: vigia do worker (roda no banco)", () => {
  it("worker parado com publicação vencida: alerta crítico + aviso aos admins 1 vez a cada 6 h; voltou → resolvido", async () => {
    await q("delete from public.ops_alerts");
    await q("delete from public.notifications where type = 'system.worker_stalled'");
    const { id: accId } = await zernioAccount();
    await dueJob(accId);
    await q("update public.worker_heartbeats set last_seen_at = now() - interval '20 minutes'");
    const r1 = (await q("select public.worker_watchdog() as r"))[0].r;
    expect(r1).toMatchObject({ stalled: true });
    expect(await alert("worker_stalled")).toMatchObject({ severity: "critical", resolved_at: null });
    const n1 = await q("select user_id, email_status, payload from public.notifications where type = 'system.worker_stalled'");
    expect(n1).toHaveLength(1);
    expect(n1[0]).toMatchObject({ user_id: user, email_status: "pending" });
    await q("select public.worker_watchdog()");
    expect(await q("select 1 from public.notifications where type = 'system.worker_stalled'")).toHaveLength(1); // sem repetir
    expect((await alert("worker_stalled")).occurrences).toBe(2);
    await q("insert into public.worker_heartbeats (worker_id, kind, last_seen_at) values ('wz-test', 'worker', now()) on conflict (worker_id) do update set last_seen_at = now()");
    expect((await q("select public.worker_watchdog() as r"))[0].r).toMatchObject({ stalled: false });
    expect((await alert("worker_stalled")).resolved_at).not.toBeNull();
  });

  it("sem publicações vencidas, worker parado não alarma (nada a perder)", async () => {
    await q("delete from public.ops_alerts");
    await q("update public.worker_heartbeats set last_seen_at = now() - interval '2 hours'");
    expect((await q("select public.worker_watchdog() as r"))[0].r).toMatchObject({ stalled: false, due: 0 });
    expect(await alert("worker_stalled")).toBeUndefined();
  });

  it("onda de falhas definitivas (≥ 5/h) vira alerta operacional", async () => {
    await q("delete from public.ops_alerts");
    const { id: accId } = await zernioAccount();
    for (let i = 0; i < 5; i++) {
      const id = await dueJob(accId);
      await q("update public.publication_jobs set status = 'queued' where id = $1", [id]);
      await q("update public.publication_jobs set status = 'preparing' where id = $1", [id]);
      await q("update public.publication_jobs set status = 'failed_permanent' where id = $1", [id]);
    }
    await q("select public.worker_watchdog()");
    expect(await alert("publication_failure_spike")).toMatchObject({ severity: "error", resolved_at: null });
  });
});

describe("confiabilidade: avisos por e-mail", () => {
  beforeEach(async () => {
    await q("delete from public.notifications");
    await q("delete from public.notification_preferences");
  });

  it("só avisos importantes entram na fila de e-mail", async () => {
    expect((await note("publication.failed", { job_id: "j1" })).email_status).toBe("pending");
    expect((await note("publication.published", { job_id: "j2" })).email_status).toBeNull();
  });

  it("sem provedor configurado: nada é enviado; aviso fica no sistema como 'skipped'", async () => {
    const n = await note("account.disconnected", { account_id: "a1", account: "Pipocou" });
    expect(await deliverEmails(db, { sender: null, log: silentLogger })).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect((await q("select email_status, email_error from public.notifications where id = $1", [n.id]))[0]).toEqual({ email_status: "skipped", email_error: "provider_not_configured" });
  });

  it("com provedor: envia texto mínimo (sem dados sensíveis), registra entrega; repetido em 1 h não reenvia", async () => {
    const s = mails();
    await note("publication.failed", { job_id: "j9", account: "Pipocou", campaign: "Diária", message: "token=SEGREDO https://x/y?token=abc" });
    await note("publication.failed", { job_id: "j9", account: "Pipocou" });
    const r = await deliverEmails(db, { sender: s, log: silentLogger, appUrl: "https://app.reelsflow.test" });
    expect(r).toEqual({ sent: 1, skipped: 1, failed: 0 });
    expect(s.sent[0]!.subject).toBe("[ReelsFlow] Uma publicação falhou");
    expect(s.sent[0]!.text).toContain("Conta: Pipocou");
    expect(s.sent[0]!.text).toContain("https://app.reelsflow.test/w/");
    expect(s.sent[0]!.text).not.toMatch(/SEGREDO|token=/);
    const rows = await q("select email_status, email_error, emailed_at is not null as at from public.notifications order by created_at");
    expect(rows).toEqual([{ email_status: "sent", email_error: null, at: true }, { email_status: "skipped", email_error: "duplicate_recent", at: false }]);
  });

  it("preferências: e-mail desligado ou categoria silenciada → não envia", async () => {
    const s = mails();
    await q("insert into public.notification_preferences (user_id, workspace_id, muted_types) values ($1, $2, '{queue.low,upload.failed}')", [user, ws]);
    await note("upload.failed", { media: "v.mp4" });
    await note("account.disconnected", { account_id: "a2" });
    await deliverEmails(db, { sender: s, log: silentLogger });
    expect(s.sent.map((m) => m.subject)).toEqual(["[ReelsFlow] Uma conta precisa ser reconectada"]);
    await q("update public.notification_preferences set email_enabled = false where user_id = $1", [user]);
    await note("account.disconnected", { account_id: "a3" });
    await deliverEmails(db, { sender: s, log: silentLogger });
    expect(s.sent).toHaveLength(1);
  });

  it("limite por pessoa (10/h) e limite diário global", async () => {
    const s = mails();
    for (let i = 0; i < 12; i++) await note("publication.failed", { job_id: `job-${i}` });
    const r = await deliverEmails(db, { sender: s, log: silentLogger, batch: 50 });
    expect(r).toEqual({ sent: 10, skipped: 2, failed: 0 });
    await q("delete from public.notifications");
    await note("publication.failed", { job_id: "x1" });
    const capped = await deliverEmails(db, { sender: mails(), log: silentLogger, dailyCap: 0 });
    expect(capped).toEqual({ sent: 0, skipped: 1, failed: 0 });
  });

  it("falha temporária do provedor: tenta de novo e desiste na 3ª; rejeição permanente: desiste na hora", async () => {
    const flaky = mails(() => new EmailSendError("HTTP 503", false));
    const n = await note("publication.failed", { job_id: "t1" });
    for (let i = 0; i < 3; i++) await deliverEmails(db, { sender: flaky, log: silentLogger });
    expect((await q("select email_status, email_attempts from public.notifications where id = $1", [n.id]))[0]).toEqual({ email_status: "failed", email_attempts: 3 });
    const bad = mails(() => new EmailSendError("HTTP 422", true));
    const m = await note("publication.failed", { job_id: "t2" });
    await deliverEmails(db, { sender: bad, log: silentLogger });
    expect((await q("select email_status, email_attempts from public.notifications where id = $1", [m.id]))[0]).toEqual({ email_status: "failed", email_attempts: 1 });
  });

  it("texto do e-mail: assunto por tipo, link para a central de avisos", () => {
    const c = composeEmail({ type: "system.worker_stalled", payload: {}, workspace: "Leeoh", slug: "leeoh" }, "https://x.test/");
    expect(c.subject).toContain("processamento interrompido");
    expect(c.text).toContain("https://x.test/w/leeoh/notifications");
  });
});
