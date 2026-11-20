import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TokenCipher } from "../crypto";
import { ConnectorError, type Phase, type PublishInput } from "../types";
import { FacebookConnector } from "./facebook";
import { FakeGraph } from "./fake-graph";
import { GraphClient, MetaApiError, classifyMetaError, retryAfterFromHeaders } from "./graph";
import { InstagramConnector } from "./instagram";
import { buildAuthUrl, discoverAccounts, exchangeCode } from "./oauth";
import { parseSignedRequest } from "./signed-request";

const key = () => randomBytes(32).toString("base64");
const noSleep = async () => {};

describe("TokenCipher", () => {
  it("cifra e decifra; amarra ao contexto; detecta adulteração", () => {
    const c = new TokenCipher({ 1: key() }, 1);
    const s = c.seal("EAAB-token-secreto", "acc-1");
    expect(s.ciphertext).not.toContain("token");
    expect(c.open(s, "acc-1")).toBe("EAAB-token-secreto");
    expect(() => c.open(s, "acc-2")).toThrow();
    expect(() => c.open({ ...s, ciphertext: Buffer.from("x").toString("base64") }, "acc-1")).toThrow();
  });
  it("rotação: lê versões antigas e cifra com a atual", () => {
    const k1 = key();
    const old = new TokenCipher({ 1: k1 }, 1).seal("t", "a");
    const rotated = new TokenCipher({ 1: k1, 2: key() }, 2);
    expect(rotated.open(old, "a")).toBe("t");
    expect(rotated.seal("t", "a").keyVersion).toBe(2);
    expect(() => new TokenCipher({ 1: "curta" }, 1)).toThrow();
  });
  it("configuração por variável de ambiente", () => {
    expect(TokenCipher.fromEnv({ TOKEN_ENCRYPTION_KEY: key() }).seal("x", "y").keyVersion).toBe(1);
    expect(() => TokenCipher.fromEnv({})).toThrow();
  });
});

describe("signed_request (exclusão de dados)", () => {
  const secret = "app-secret";
  const make = (payload: object, s = secret) => {
    const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", s).update(p).digest("base64url");
    return `${sig}.${p}`;
  };
  it("aceita assinatura válida", () => {
    expect(parseSignedRequest(make({ algorithm: "HMAC-SHA256", user_id: "123", issued_at: 1 }), secret)).toMatchObject({ user_id: "123" });
  });
  it("recusa assinatura errada, payload adulterado e algoritmo diferente", () => {
    expect(parseSignedRequest(make({ algorithm: "HMAC-SHA256", user_id: "1" }, "outro"), secret)).toBeNull();
    const good = make({ algorithm: "HMAC-SHA256", user_id: "1" });
    const tampered = good.split(".")[0] + "." + Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "2" })).toString("base64url");
    expect(parseSignedRequest(tampered, secret)).toBeNull();
    expect(parseSignedRequest(make({ algorithm: "none", user_id: "1" }), secret)).toBeNull();
    expect(parseSignedRequest("lixo", secret)).toBeNull();
  });
});

describe("classificação de erros da Graph API", () => {
  const e = (code: number, status = 400, extra: object = {}) => new MetaApiError("x", status, { code, ...extra }, null);
  it("limites, autorização, transitórios e permanentes", () => {
    for (const c of [4, 17, 32, 613, 80001, 80002]) expect(classifyMetaError(e(c), false).errorClass).toBe("rate_limited");
    expect(classifyMetaError(e(190), false).errorClass).toBe("auth");
    expect(classifyMetaError(e(10), false).errorClass).toBe("auth");
    expect(classifyMetaError(e(2), false).errorClass).toBe("transient");
    expect(classifyMetaError(e(100), false).errorClass).toBe("permanent");
    expect(classifyMetaError(e(1363128), false).errorClass).toBe("permanent");
    expect(classifyMetaError(e(999, 503), false).errorClass).toBe("transient");
    expect(classifyMetaError(e(999, 503), true)).toMatchObject({ errorClass: "unknown", sideEffectStarted: true });
    expect(classifyMetaError(Object.assign(new Error("aborted"), { name: "AbortError" }), true)).toMatchObject({ errorClass: "timeout", sideEffectStarted: true });
  });
  it("tempo de espera do cabeçalho X-Business-Use-Case-Usage", () => {
    const h = new Headers({ "x-business-use-case-usage": JSON.stringify({ "123": [{ type: "pages", call_count: 100, estimated_time_to_regain_access: 7 }] }) });
    expect(retryAfterFromHeaders(h)).toBe(420);
    expect(retryAfterFromHeaders(new Headers())).toBeNull();
  });
});

describe("OAuth", () => {
  const cfg = { appId: "app", appSecret: "sec", redirectUri: "https://app.test/api/oauth/meta/callback" };
  it("URL do diálogo com state, escopos e versão", () => {
    const u = new URL(buildAuthUrl(new GraphClient(), cfg, "st4te"));
    expect(u.origin + u.pathname).toBe("https://www.facebook.com/v27.0/dialog/oauth");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: "app", redirect_uri: cfg.redirectUri, state: "st4te", response_type: "code" });
    expect(u.searchParams.get("scope")).toBe("pages_show_list,pages_read_engagement,pages_manage_posts");
  });
  it("troca code → token curto → token longo", async () => {
    const g = new FakeGraph().on("GET", "oauth/access_token", { body: { access_token: "short" } }, { body: { access_token: "long", expires_in: 5183944 } });
    const r = await exchangeCode(new GraphClient({ fetchImpl: g.fetch }), cfg, "c0de");
    expect(r.token).toBe("long");
    expect(r.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 86400_000);
    expect(g.calls[0]!.params).toMatchObject({ code: "c0de", redirect_uri: cfg.redirectUri });
    expect(g.calls[1]!.params).toMatchObject({ grant_type: "fb_exchange_token", fb_exchange_token: "short" });
  });
  it("descobre só Páginas (Instagram usa o Instagram Login), com permissões faltantes", async () => {
    const g = new FakeGraph()
      .on("GET", "me", { body: { id: "u1", name: "Ana" } })
      .on("GET", "me/permissions", { body: { data: [{ permission: "pages_show_list", status: "granted" }, { permission: "pages_read_engagement", status: "granted" }, { permission: "pages_manage_posts", status: "granted" }, { permission: "instagram_basic", status: "granted" }, { permission: "instagram_content_publish", status: "declined" }] } })
      .on("GET", "me/accounts", { body: { data: [{ id: "p1", name: "Loja", access_token: "pt1", tasks: ["CREATE_CONTENT"], instagram_business_account: { id: "ig1", username: "loja" } }, { id: "p2", name: "Só leitura", access_token: "pt2", tasks: ["ANALYZE"] }] } });
    const r = await discoverAccounts(new GraphClient({ fetchImpl: g.fetch }), "long");
    expect(r.metaUserId).toBe("u1");
    expect(r.candidates.map((c) => [c.key, c.canPublish, c.missingScopes])).toEqual([
      ["facebook:p1", true, []],
      ["facebook:p2", false, []],
    ]);
    expect(g.calls.every((c) => c.headers.Authorization === "OAuth long")).toBe(true);
    expect(g.calls.every((c) => !("access_token" in c.params))).toBe(true); // token nunca na URL
  });
});

const account = (platform: "instagram" | "facebook", id: string) => ({ id: "acc", platform, externalAccountId: id, settings: {} });
const input = (platform: "instagram" | "facebook", id: string, checkpoint: Record<string, unknown> | null = null): PublishInput => ({
  jobId: "job",
  attemptNo: 1,
  account: account(platform, id),
  media: { storagePath: "p", mimeType: "video/mp4", sizeBytes: 1, durationMs: 10_000, url: "https://storage.test/v.mp4?token=assinado" },
  caption: "Legenda #reels",
  checkpoint,
  credentials: { accessToken: "page-token" },
});
function io() {
  const saved: [Phase, Record<string, unknown>][] = [];
  return { saved, io: { save: async (p: Phase, c: Record<string, unknown>) => void saved.push([p, c]) } };
}

/** Instagram Login: GET /me confirma que o token é da conta de destino antes de tudo. */
const igFake = (userId = "ig1") => new FakeGraph().on("GET", "me", { body: { user_id: userId, username: "loja" } });

describe("InstagramConnector", () => {
  const quotaOk = { body: { data: [{ quota_usage: 3, config: { quota_total: 50, quota_duration: 86400 } }] } };
  it("fluxo completo: cota → container REELS → FINISHED → media_publish → permalink", async () => {
    const g = igFake()
      .on("GET", "ig1/content_publishing_limit", quotaOk)
      .on("POST", "ig1/media", { body: { id: "c1" } })
      .on("GET", "c1", { body: { status_code: "IN_PROGRESS" } }, { body: { status_code: "FINISHED" } })
      .on("POST", "ig1/media_publish", { body: { id: "m1" } })
      .on("GET", "m1", { body: { permalink: "https://www.instagram.com/reel/abc/" } });
    const { saved, io: sink } = io();
    const r = await new InstagramConnector(new GraphClient({ fetchImpl: g.fetch }), { sleep: noSleep }).publish(input("instagram", "ig1"), sink);
    expect(r).toEqual({ externalId: "m1", permalink: "https://www.instagram.com/reel/abc/" });
    const create = g.calls.find((c) => c.path === "ig1/media")!;
    expect(create.params).toMatchObject({ media_type: "REELS", video_url: "https://storage.test/v.mp4?token=assinado", caption: "Legenda #reels" });
    expect(g.calls.find((c) => c.path === "ig1/media_publish")!.params).toMatchObject({ creation_id: "c1" });
    expect(saved.map((s) => s[0])).toEqual(["processing_remote", "publishing"]);
    expect(saved[1]![1]).toMatchObject({ container_id: "c1" });
  });

  it("cota esgotada: rate limit sem criar container", async () => {
    const g = igFake().on("GET", "ig1/content_publishing_limit", { body: { data: [{ quota_usage: 50, config: { quota_total: 50 } }] } });
    const err = await new InstagramConnector(new GraphClient({ fetchImpl: g.fetch })).publish(input("instagram", "ig1"), io().io).catch((e) => e);
    expect(err).toMatchObject({ errorClass: "rate_limited", code: "ig_quota" });
    expect(g.count("POST", "ig1/media")).toBe(0);
  });

  it("container com ERROR: rejeição permanente, sem publicar", async () => {
    const g = igFake().on("GET", "ig1/content_publishing_limit", quotaOk).on("POST", "ig1/media", { body: { id: "c1" } }).on("GET", "c1", { body: { status_code: "ERROR", status: "2207026" } });
    const err = await new InstagramConnector(new GraphClient({ fetchImpl: g.fetch }), { sleep: noSleep }).publish(input("instagram", "ig1"), io().io).catch((e) => e);
    expect(err).toMatchObject({ errorClass: "permanent", sideEffectStarted: false });
    expect(g.count("POST", "ig1/media_publish")).toBe(0);
  });

  it("processamento lento: falha transitória e retomada pelo checkpoint sem novo container", async () => {
    const g = igFake().on("GET", "ig1/content_publishing_limit", quotaOk).on("POST", "ig1/media", { body: { id: "c1" } }).on("GET", "c1", { body: { status_code: "IN_PROGRESS" } });
    const c = new InstagramConnector(new GraphClient({ fetchImpl: g.fetch }), { sleep: noSleep, pollBudgetMs: 0 });
    const { saved, io: sink } = io();
    expect(await c.publish(input("instagram", "ig1"), sink).catch((e) => e)).toMatchObject({ errorClass: "transient", code: "ig_processing" });
    const g2 = igFake().on("GET", "c1", { body: { status_code: "FINISHED" } }).on("POST", "ig1/media_publish", { body: { id: "m9" } }).on("GET", "m9", { body: {} });
    const r = await new InstagramConnector(new GraphClient({ fetchImpl: g2.fetch }), { sleep: noSleep }).publish(input("instagram", "ig1", saved[0]![1]), io().io);
    expect(r.externalId).toBe("m9");
    expect(g2.count("POST", "ig1/media")).toBe(0);
  });

  it("timeout no media_publish: incerto; reconciliação pelo container encontra o media", async () => {
    const g = igFake()
      .on("GET", "ig1/content_publishing_limit", quotaOk)
      .on("POST", "ig1/media", { body: { id: "c1" } })
      .on("GET", "c1", { body: { status_code: "FINISHED" } })
      .on("POST", "ig1/media_publish", Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    const c = new InstagramConnector(new GraphClient({ fetchImpl: g.fetch }), { sleep: noSleep });
    const { saved, io: sink } = io();
    const err = await c.publish(input("instagram", "ig1"), sink).catch((e) => e);
    expect(err).toMatchObject({ errorClass: "timeout", sideEffectStarted: true });

    const g2 = igFake().on("GET", "c1", { body: { status_code: "PUBLISHED" } }).on("GET", "ig1/media", { body: { data: [{ id: "m7", permalink: "https://www.instagram.com/reel/x/", timestamp: new Date().toISOString() }] } });
    const st = await new InstagramConnector(new GraphClient({ fetchImpl: g2.fetch })).getStatus(account("instagram", "ig1"), saved.at(-1)![1], { accessToken: "t" });
    expect(st).toEqual({ state: "published", externalId: "m7", permalink: "https://www.instagram.com/reel/x/" });
  });

  it("limite no media_publish: não publicou (retry seguro); token inválido: auth", async () => {
    const base = () => igFake().on("GET", "ig1/content_publishing_limit", quotaOk).on("POST", "ig1/media", { body: { id: "c1" } }).on("GET", "c1", { body: { status_code: "FINISHED" } });
    const g = base().on("POST", "ig1/media_publish", { status: 400, body: { error: { message: "limit", code: 4 } } });
    expect(await new InstagramConnector(new GraphClient({ fetchImpl: g.fetch })).publish(input("instagram", "ig1"), io().io).catch((e) => e)).toMatchObject({ errorClass: "rate_limited", sideEffectStarted: false });
    const g2 = igFake().on("GET", "ig1/content_publishing_limit", { status: 401, body: { error: { message: "Error validating access token", code: 190 } } });
    expect(await new InstagramConnector(new GraphClient({ fetchImpl: g2.fetch })).publish(input("instagram", "ig1"), io().io).catch((e) => e)).toMatchObject({ errorClass: "auth" });
  });

  it("estado do container na reconciliação", async () => {
    const st = async (code: string) =>
      new InstagramConnector(new GraphClient({ fetchImpl: igFake().on("GET", "c1", { body: { status_code: code } }).fetch })).getStatus(account("instagram", "ig1"), { container_id: "c1" }, { accessToken: "t" });
    expect((await st("IN_PROGRESS")).state).toBe("processing");
    expect((await st("FINISHED")).state).toBe("not_found");
    expect((await st("EXPIRED")).state).toBe("not_found");
    expect(await new InstagramConnector(new GraphClient()).getStatus(account("instagram", "ig1"), {}, null)).toEqual({ state: "not_found" });
  });

  it("sem credenciais: erro de autorização", async () => {
    expect(await new InstagramConnector(new GraphClient()).publish({ ...input("instagram", "ig1"), credentials: null }, io().io).catch((e) => e)).toBeInstanceOf(ConnectorError);
  });
});

describe("FacebookConnector", () => {
  it("start → upload com file_url → finish PUBLISHED → status publicado", async () => {
    const g = new FakeGraph()
      .on("POST", "p1/video_reels", { body: { video_id: "v1", upload_url: "https://rupload.facebook.com/video-upload/v1" } }, { body: { success: true } })
      .on("POST", /^rupload:video-upload\/v27\.0\/v1$/, { body: { success: true } })
      .on("GET", "v1", { body: { status: { video_status: "processing", publishing_phase: { status: "in_progress" } } } }, { body: { status: { video_status: "ready", publishing_phase: { status: "complete", publish_status: "published" } } } }, { body: { permalink_url: "/reel/123" } });
    const { saved, io: sink } = io();
    const r = await new FacebookConnector(new GraphClient({ fetchImpl: g.fetch }), { sleep: noSleep }).publish(input("facebook", "p1"), sink);
    expect(r).toEqual({ externalId: "v1", permalink: "https://www.facebook.com/reel/123" });
    expect(g.calls[0]!.params).toMatchObject({ upload_phase: "start" });
    const up = g.calls.find((c) => c.path.startsWith("rupload:"))!;
    expect(up.headers).toMatchObject({ Authorization: "OAuth page-token", file_url: "https://storage.test/v.mp4?token=assinado" });
    expect(g.calls.filter((c) => c.path === "p1/video_reels")[1]!.params).toMatchObject({ upload_phase: "finish", video_id: "v1", video_state: "PUBLISHED", description: "Legenda #reels" });
    expect(saved.map((s) => s[0])).toEqual(["uploading", "processing_remote", "publishing"]);
  });

  it("timeout no finish: incerto; status publicado na reconciliação", async () => {
    const g = new FakeGraph()
      .on("POST", "p1/video_reels", { body: { video_id: "v1" } }, new Error("socket hang up"))
      .on("POST", /^rupload:/, { body: { success: true } });
    const { saved, io: sink } = io();
    expect(await new FacebookConnector(new GraphClient({ fetchImpl: g.fetch })).publish(input("facebook", "p1"), sink).catch((e) => e)).toMatchObject({ errorClass: "timeout", sideEffectStarted: true });
    const g2 = new FakeGraph().on("GET", "v1", { body: { status: { publishing_phase: { status: "complete", publish_status: "published" } } } }, { body: { permalink_url: "https://www.facebook.com/reel/1" } });
    expect(await new FacebookConnector(new GraphClient({ fetchImpl: g2.fetch })).getStatus(account("facebook", "p1"), saved.at(-1)![1], { accessToken: "t" })).toMatchObject({ state: "published", externalId: "v1" });
  });

  it("duração fora do limite (1363128): permanente; erro no processamento: permanente", async () => {
    const g = new FakeGraph()
      .on("POST", "p1/video_reels", { body: { video_id: "v1" } }, { status: 400, body: { error: { message: "duration", code: 1363128 } } })
      .on("POST", /^rupload:/, { body: { success: true } });
    expect(await new FacebookConnector(new GraphClient({ fetchImpl: g.fetch })).publish(input("facebook", "p1"), io().io).catch((e) => e)).toMatchObject({ errorClass: "permanent", sideEffectStarted: false });
    const g2 = new FakeGraph()
      .on("POST", "p1/video_reels", { body: { video_id: "v1" } }, { body: { success: true } })
      .on("POST", /^rupload:/, { body: { success: true } })
      .on("GET", "v1", { body: { status: { processing_phase: { status: "error", error: { message: "Formato inválido" } } } } });
    expect(await new FacebookConnector(new GraphClient({ fetchImpl: g2.fetch }), { sleep: noSleep }).publish(input("facebook", "p1"), io().io).catch((e) => e)).toMatchObject({ errorClass: "permanent", message: "Formato inválido" });
  });

  it("retomada: vídeo já publicado não é reenviado", async () => {
    const g = new FakeGraph().on("GET", "v1", { body: { status: { publishing_phase: { publish_status: "published" } } } }, { body: {} });
    const r = await new FacebookConnector(new GraphClient({ fetchImpl: g.fetch })).publish(input("facebook", "p1", { video_id: "v1" }), io().io);
    expect(r.externalId).toBe("v1");
    expect(g.count("POST", "p1/video_reels")).toBe(0);
  });
});
