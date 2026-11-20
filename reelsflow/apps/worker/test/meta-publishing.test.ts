import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConnectorRegistry } from "@reelsflow/connectors";
import { GraphClient, InstagramConnector, TokenCipher } from "@reelsflow/connectors/server";
import { FakeGraph } from "@reelsflow/connectors/testing";
import { makeDb } from "./db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../src/log";
import { PgCredentialProvider } from "../src/publishing/credentials";
import { LocalStorage } from "../src/storage";
import { tick, type WorkerDeps } from "../src/worker";
import { maintainInstagramTokens } from "../src/publishing/tokens";

const db = makeDb(5);
const tmp = mkdtempSync(path.join(os.tmpdir(), "rf-meta-"));
const cipher = new TokenCipher({ 1: randomBytes(32).toString("base64") }, 1);
let user: string;
let ws: string;

const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;

function depsWith(graph: FakeGraph, opts: { cipher?: TokenCipher | null; pollBudgetMs?: number } = {}): WorkerDeps {
  const connectors = new ConnectorRegistry().register(
    new InstagramConnector(new GraphClient({ fetchImpl: graph.fetch }), { sleep: async () => {}, pollBudgetMs: opts.pollBudgetMs }),
  );
  return {
    db,
    storage: new LocalStorage(tmp),
    log: silentLogger,
    ffmpeg: { ffprobe: "ffprobe", ffmpeg: "ffmpeg" },
    tmpDir: tmp,
    connectors,
    credentials: new PgCredentialProvider(db, opts.cipher === undefined ? cipher : opts.cipher),
    mediaUrl: async (p) => `https://storage.test/${p}?token=assinado`,
  };
}
const opts = { workerId: "wm", concurrency: 2, leaseSeconds: 60, pollMs: 50, maintenanceEveryMs: 1e9, reconcileMinAgeSeconds: 0 };

async function igAccount(withToken = true) {
  // IDs reais do Instagram têm 17 dígitos (acima de Number.MAX_SAFE_INTEGER).
  const igId = `178414${String(Date.now()).slice(-8)}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
  const id = (await q("insert into public.social_accounts (workspace_id, platform, external_account_id, display_name, min_spacing_minutes) values ($1,'instagram',$2,'@loja',0) returning id", [ws, igId]))[0].id;
  if (withToken) {
    const s = cipher.seal("IGAA-TOKEN-SECRETO", `instagram:${igId}`);
    await q("insert into public.social_account_tokens (social_account_id, workspace_id, token_type, ciphertext, iv, auth_tag, key_version, expires_at) values ($1,$2,'ig_user',$3,$4,$5,$6, now() + interval '60 days')", [id, ws, s.ciphertext, s.iv, s.tag, s.keyVersion]);
  }
  return { id, igId };
}

async function dueJob(accountId: string) {
  const camp = (await q("insert into public.campaigns (workspace_id, name, status, timezone, weekdays, times, start_date, caption, created_by) values ($1,'C','active','UTC','{1,2,3,4,5,6,7}','{09:00}',current_date,'Legenda da campanha',$2) returning id", [ws, user]))[0].id;
  const media = (await q("insert into public.media_assets (workspace_id, name, original_filename, storage_path, mime_type, size_bytes, sha256, status) values ($1,'v','v.mp4',$2,'video/mp4',10,$3,'uploading') returning id", [ws, `${ws}/${crypto.randomUUID()}/original.mp4`, "e".repeat(64)]))[0].id;
  for (const s of ["uploaded", "processing", "ready"]) await q("update public.media_assets set status = $2 where id = $1", [media, s]);
  const target = (await q("insert into public.campaign_targets (campaign_id, workspace_id, social_account_id) values ($1,$2,$3) returning id", [camp, ws, accountId]))[0].id;
  const cm = (await q("insert into public.campaign_media (campaign_id, workspace_id, media_asset_id) values ($1,$2,$3) returning id", [camp, ws, media]))[0].id;
  const at = new Date(Date.now() - 1000).toISOString();
  const id = (await q("insert into public.publication_jobs (workspace_id, campaign_id, campaign_media_id, target_id, social_account_id, media_asset_id, local_date, local_time, timezone, scheduled_at, status, next_attempt_at) values ($1,$2,$3,$4,$5,$6,current_date,'09:00','UTC',$7,'draft',$7) returning id", [ws, camp, cm, target, accountId, media, at]))[0].id;
  await q("update public.publication_jobs set status = 'scheduled' where id = $1", [id]);
  return id;
}

const job = async (id: string) => (await q("select * from public.publication_jobs where id = $1", [id]))[0];

beforeAll(async () => {
  user = (await q("insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id", [`meta-${Date.now()}@t.local`]))[0].id;
  ws = (await q("insert into public.workspaces (name, slug, created_by) values ('MetaW', $1, $2) returning id", [`metaw-${Date.now()}`, user]))[0].id;
  await q("insert into public.workspace_members (workspace_id, user_id, role) values ($1,$2,'owner')", [ws, user]);
  // Vários perfis do Instagram no mesmo workspace: plano Agency (Starter permite 1 por rede).
  await q("insert into public.subscriptions (workspace_id, plan) values ($1, 'agency')", [ws]);
});
beforeEach(async () => {
  await q("delete from public.publication_jobs");
});
afterAll(async () => {
  await db.end();
  rmSync(tmp, { recursive: true, force: true });
});

const quota = { body: { data: [{ quota_usage: 0, config: { quota_total: 50 } }] } };

/** Graph do Instagram Login simulada: GET /me devolve o ID numérico SEM aspas, como a doc mostra. */
const igGraph = (igId: string) => {
  const g = new FakeGraph();
  const inner = g.fetch;
  g.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/me")) {
      g.calls.push({ method: "GET", host: u.host, path: "me", params: Object.fromEntries(u.searchParams), headers: {} });
      return new Response(`{"user_id": ${igId}, "username": "loja"}`);
    }
    return inner(input as never, init);
  }) as typeof fetch;
  return g;
};

describe("worker + conector Instagram (Graph simulada)", () => {
  it("publica com token decifrado em memória e URL temporária do vídeo", async () => {
    const acc = await igAccount();
    const g = igGraph(acc.igId)
      .on("GET", `${acc.igId}/content_publishing_limit`, quota)
      .on("POST", `${acc.igId}/media`, { body: { id: "c1" } })
      .on("GET", "c1", { body: { status_code: "FINISHED" } })
      .on("POST", `${acc.igId}/media_publish`, { body: { id: "m1" } })
      .on("GET", "m1", { body: { permalink: "https://www.instagram.com/reel/m1/" } });
    const id = await dueJob(acc.id);
    await tick(depsWith(g), opts, { lastMaintenance: Date.now() });
    expect(await job(id)).toMatchObject({ status: "published" });
    expect((await q("select external_id, permalink from public.external_publications where job_id = $1", [id]))[0]).toEqual({ external_id: "m1", permalink: "https://www.instagram.com/reel/m1/" });
    expect(g.calls.every((c) => c.host === "graph.instagram.com")).toBe(true);
    expect(g.calls.filter((c) => c.method === "POST").every((c) => c.headers.Authorization === "Bearer IGAA-TOKEN-SECRETO")).toBe(true);
    expect(g.calls.filter((c) => c.method === "GET").every((c) => c.params.access_token === "IGAA-TOKEN-SECRETO")).toBe(true);
    const create = g.calls.find((c) => c.path === `${acc.igId}/media`)!;
    expect(create.params.video_url).toMatch(/^https:\/\/storage\.test\/.+\?token=assinado$/);
    expect(create.params.caption).toBe("Legenda da campanha");
    // o token nunca é gravado em claro
    const dump = JSON.stringify(await q("select * from public.publication_jobs where id = $1", [id])) + JSON.stringify(await q("select * from public.publication_attempts where job_id = $1", [id]));
    expect(dump).not.toContain("IGAA-TOKEN-SECRETO");
  });

  it("timeout no media_publish → incerto → reconciliação pelo container, sem segundo media_publish", async () => {
    const acc = await igAccount();
    const g = igGraph(acc.igId)
      .on("GET", `${acc.igId}/content_publishing_limit`, quota)
      .on("POST", `${acc.igId}/media`, { body: { id: "c2" } })
      .on("GET", "c2", { body: { status_code: "FINISHED" } }, { body: { status_code: "PUBLISHED" } })
      .on("POST", `${acc.igId}/media_publish`, new Error("socket hang up"))
      .on("GET", `${acc.igId}/media`, { body: { data: [{ id: "m2", permalink: "https://www.instagram.com/reel/m2/", timestamp: new Date().toISOString() }] } });
    const id = await dueJob(acc.id);
    await tick(depsWith(g), { ...opts, reconcileMinAgeSeconds: 3600 }, { lastMaintenance: Date.now() });
    expect((await job(id)).status).toBe("uncertain");
    await tick(depsWith(g), opts, { lastMaintenance: Date.now() });
    expect((await job(id)).status).toBe("published");
    expect(g.count("POST", `${acc.igId}/media_publish`)).toBe(1);
    expect((await q("select source, external_id from public.external_publications where job_id = $1", [id]))[0]).toEqual({ source: "reconciled", external_id: "m2" });
  });

  it("token revogado (190): conta requer reconexão e a publicação aguarda", async () => {
    const acc = await igAccount();
    // Token revogado: o primeiro GET (/me) já responde 190.
    const g = new FakeGraph().on("GET", "me", { status: 401, body: { error: { message: "Error validating access token", type: "OAuthException", code: 190 } } });
    const id = await dueJob(acc.id);
    await tick(depsWith(g), opts, { lastMaintenance: Date.now() });
    expect((await q("select status from public.social_accounts where id = $1", [acc.id]))[0].status).toBe("needs_reauth");
    expect((await job(id)).status).toBe("failed_retryable");
  });

  it("conta sem token: autorização; chave ausente no worker: espera sem desconectar a conta", async () => {
    const noTok = await igAccount(false);
    const id1 = await dueJob(noTok.id);
    await tick(depsWith(new FakeGraph()), opts, { lastMaintenance: Date.now() });
    expect((await q("select status from public.social_accounts where id = $1", [noTok.id]))[0].status).toBe("needs_reauth");
    expect((await job(id1)).status).toBe("failed_retryable");

    const acc = await igAccount();
    const id2 = await dueJob(acc.id);
    await tick(depsWith(new FakeGraph(), { cipher: null }), opts, { lastMaintenance: Date.now() });
    expect(await job(id2)).toMatchObject({ status: "failed_retryable", last_error_class: "transient" });
    expect((await q("select status from public.social_accounts where id = $1", [acc.id]))[0].status).toBe("active");
  });

  it("token que não pertence à conta selecionada: nada é criado nem publicado (falha permanente)", async () => {
    const acc = await igAccount();
    const g = igGraph("17841499999999999")
      .on("GET", `${acc.igId}/content_publishing_limit`, quota)
      .on("POST", `${acc.igId}/media`, { body: { id: "cX" } });
    const id = await dueJob(acc.id);
    await tick(depsWith(g), opts, { lastMaintenance: Date.now() });
    expect(await job(id)).toMatchObject({ status: "failed_permanent" });
    expect(g.count("POST", `${acc.igId}/media`)).toBe(0);
    expect(g.count("POST", `${acc.igId}/media_publish`)).toBe(0);
    const att = await q("select error_code from public.publication_attempts where job_id = $1", [id]);
    expect(att[0].error_code).toBe("ig_account_mismatch");
  });

  it("processamento lento na Meta: retoma o MESMO container sem gastar tentativas", async () => {
    const acc = await igAccount();
    const g = igGraph(acc.igId)
      .on("GET", `${acc.igId}/content_publishing_limit`, quota)
      .on("POST", `${acc.igId}/media`, { body: { id: "c3" } })
      .on("GET", "c3", { body: { status_code: "IN_PROGRESS" } }, { body: { status_code: "IN_PROGRESS" } }, { body: { status_code: "IN_PROGRESS" } }, { body: { status_code: "FINISHED" } })
      .on("POST", `${acc.igId}/media_publish`, { body: { id: "m3" } })
      .on("GET", "m3", { body: { permalink: "https://www.instagram.com/reel/m3/" } });
    const id = await dueJob(acc.id);
    const deps = depsWith(g, { pollBudgetMs: 0 });
    for (let i = 0; i < 3; i++) {
      await tick(deps, opts, { lastMaintenance: Date.now() });
      const j = await job(id);
      expect(j).toMatchObject({ status: "failed_retryable", attempt_count: 0 });
      await q("update public.publication_jobs set next_attempt_at = now() where id = $1", [id]);
    }
    await tick(deps, opts, { lastMaintenance: Date.now() });
    expect(await job(id)).toMatchObject({ status: "published" });
    expect(g.count("POST", `${acc.igId}/media`)).toBe(1);
    expect(g.count("POST", `${acc.igId}/media_publish`)).toBe(1);
    expect(g.count("GET", "c3")).toBe(4); // uma leitura de status por tentativa, sem repetição
  });
});

describe("renovação de tokens do Instagram Login", () => {
  const setToken = (accId: string, sql: string) => q(`update public.social_account_tokens set ${sql} where social_account_id = $1`, [accId]);
  const tokenOf = async (accId: string, igId: string) => {
    const t = (await q("select ciphertext, iv, auth_tag, key_version, expires_at, last_refresh_error from public.social_account_tokens where social_account_id = $1", [accId]))[0];
    return { ...t, plain: cipher.open({ ciphertext: t.ciphertext, iv: t.iv, tag: t.auth_tag, keyVersion: t.key_version }, `instagram:${igId}`) };
  };
  const run = (g: FakeGraph) => maintainInstagramTokens(db, { cipher, graph: new GraphClient({ fetchImpl: g.fetch }), log: silentLogger });

  it("renova token na janela (≤ 15 dias, emitido há > 24 h), confere a identidade e grava cifrado", async () => {
    const acc = await igAccount();
    await setToken(acc.id, "expires_at = now() + interval '10 days', issued_at = now() - interval '50 days'");
    const g = igGraph(acc.igId).on("GET", "refresh_access_token", { body: { access_token: "IGAA-NOVO", token_type: "bearer", expires_in: 5184000 } });
    const r = await run(g);
    expect(r.refreshed).toBeGreaterThanOrEqual(1);
    const t = await tokenOf(acc.id, acc.igId);
    expect(t.plain).toBe("IGAA-NOVO");
    expect(new Date(t.expires_at).getTime()).toBeGreaterThan(Date.now() + 59 * 86400_000);
    expect(g.calls.find((c) => c.path === "refresh_access_token")!.params).toMatchObject({ grant_type: "ig_refresh_token", access_token: "IGAA-TOKEN-SECRETO" });
    // Segunda execução imediata: nada a fazer (token novo fora da janela).
    const g2 = igGraph(acc.igId);
    await run(g2);
    expect(g2.count("GET", "refresh_access_token")).toBe(0);
  });

  it("token emitido há menos de 24 h não é renovado (regra da doc)", async () => {
    const acc = await igAccount();
    await setToken(acc.id, "expires_at = now() + interval '10 days', issued_at = now() - interval '2 hours'");
    const g = igGraph(acc.igId);
    await run(g);
    expect(g.count("GET", "refresh_access_token")).toBe(0);
  });

  it("token renovado de outra conta NÃO é gravado", async () => {
    const acc = await igAccount();
    await setToken(acc.id, "expires_at = now() + interval '10 days', issued_at = now() - interval '50 days'");
    const g = igGraph("17841499999999999").on("GET", "refresh_access_token", { body: { access_token: "IGAA-ALHEIO", expires_in: 5184000 } });
    await run(g);
    const t = await tokenOf(acc.id, acc.igId);
    expect(t.plain).toBe("IGAA-TOKEN-SECRETO");
    expect(t.last_refresh_error).toMatch(/outra conta/);
  });

  it("renovação negada (190): conta requer reconexão e admins são avisados uma vez por dia", async () => {
    const acc = await igAccount();
    await setToken(acc.id, "expires_at = now() + interval '10 days', issued_at = now() - interval '50 days'");
    const g = new FakeGraph().on("GET", "refresh_access_token", { status: 400, body: { error: { message: "Error validating access token", type: "OAuthException", code: 190 } } });
    await run(g);
    expect((await q("select status from public.social_accounts where id = $1", [acc.id]))[0].status).toBe("needs_reauth");
    await q("update public.social_accounts set status = 'active' where id = $1", [acc.id]);
    await setToken(acc.id, "last_refresh_attempt_at = null");
    await run(g);
    const n = await q("select count(*)::int n from public.notifications where type = 'account.disconnected' and payload ->> 'account_id' = $1", [acc.id]);
    expect(n[0].n).toBe(1);
  });

  it("vencido: conta requer reconexão; perto de vencer sem renovar: aviso antecipado", async () => {
    const dead = await igAccount();
    await setToken(dead.id, "expires_at = now() - interval '1 minute'");
    const soon = await igAccount();
    await setToken(soon.id, "expires_at = now() + interval '3 days', issued_at = now() - interval '57 days', last_refresh_attempt_at = now()");
    await run(new FakeGraph());
    expect((await q("select status from public.social_accounts where id = $1", [dead.id]))[0].status).toBe("needs_reauth");
    const warn = await q("select count(*)::int n from public.notifications where type = 'account.token_expiring' and payload ->> 'account_id' = $1", [soon.id]);
    expect(warn[0].n).toBe(1);
  });
});
