import { describe, expect, it } from "vitest";
import type { Phase, PublishInput } from "../types";
import { ZernioClient } from "./client";
import { ZernioConnector, zernioJobKey } from "./connector";

const ACC = "6b00e99db2568bfa4f7a2643";
const PROFILE = "6b00e219a6e2ffc97925922b";

type Route = (req: { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: any }) => { status?: number; body?: unknown; headers?: Record<string, string> } | Error | undefined;

/** API da Zernio simulada: registra chamadas; nada sai da máquina. */
function fakeZernio(route: Route) {
  const calls: { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: any }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const req = { method: init?.method ?? "GET", path: u.pathname.replace("/api/v1/", ""), query: u.searchParams, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(req);
    const r = route(req);
    if (r instanceof Error) throw r;
    if (!r) return new Response(JSON.stringify({ error: `rota não simulada ${req.method} ${req.path}` }), { status: 404 });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { calls, client: new ZernioClient({ apiKey: "sk_test", fetchImpl }), count: (m: string, p: string) => calls.filter((c) => c.method === m && c.path === p).length };
}

const account = { _id: ACC, platform: "instagram", profileId: PROFILE, username: "pipocoumemes", isActive: true };
const post = (status: string, target: Record<string, unknown> = {}) => ({
  post: { _id: "post1", status, externalId: zernioJobKey("job1"), platforms: [{ platform: "instagram", accountId: ACC, status: "pending", ...target }] },
});
const published = post("published", { status: "published", platformPostId: "17900000000000001", platformPostUrl: "https://www.instagram.com/reel/ABC/" });

const input = (checkpoint: Record<string, unknown> | null = null, over: Partial<PublishInput["account"]> = {}): PublishInput => ({
  jobId: "job1",
  attemptNo: 1,
  account: { id: "acc-rf", platform: "instagram", externalAccountId: ACC, settings: {}, providerProfileId: PROFILE, ...over },
  media: { storagePath: "ws/m/original.mp4", mimeType: "video/mp4", sizeBytes: 5_000_000, durationMs: 6000, url: "https://storage.test/v.mp4?token=assinado" },
  caption: "Legenda #memes",
  checkpoint,
  credentials: null,
});
const sink = () => {
  const saved: [Phase, Record<string, unknown>][] = [];
  return { saved, io: { save: async (p: Phase, c: Record<string, unknown>) => void saved.push([p, c]) } };
};
const conn = (client: ZernioClient, opts = {}) => new ZernioConnector(client, { sleep: async () => {}, pollBudgetMs: 0, ...opts });

describe("ZernioConnector — publicação", () => {
  it("publica na hora: confere a conta, cria o post com Idempotency-Key/externalId e devolve ID e link do Reel", async () => {
    const z = fakeZernio((r) => (r.path === `accounts/${ACC}` ? { body: { account } } : r.method === "POST" && r.path === "posts" ? { status: 201, body: published } : undefined));
    const s = sink();
    const res = await conn(z.client).publish(input(), s.io);
    expect(res).toEqual({ externalId: "17900000000000001", permalink: "https://www.instagram.com/reel/ABC/" });
    const create = z.calls.find((c) => c.method === "POST")!;
    expect(create.headers["Idempotency-Key"]).toBe("reelsflow-job-job1");
    expect(create.body).toMatchObject({
      publishNow: true,
      externalId: "reelsflow-job-job1",
      profileId: PROFILE,
      content: "Legenda #memes",
      mediaItems: [{ type: "video", url: "https://storage.test/v.mp4?token=assinado" }],
      platforms: [{ platform: "instagram", accountId: ACC, platformSpecificData: { shareToFeed: true } }],
    });
    // checkpoint salvo ANTES do pedido (sem id) e depois com o id do post
    expect(s.saved[0]![1]).toMatchObject({ idempotency_key: "reelsflow-job-job1" });
    expect(s.saved[0]![1].zernio_post_id).toBeUndefined();
    expect(s.saved.at(-1)![1]).toMatchObject({ zernio_post_id: "post1" });
  });

  it("conta de outro perfil ou de outra rede: nada é criado", async () => {
    for (const acc of [{ ...account, profileId: "aaaaaaaaaaaaaaaaaaaaaaaa" }, { ...account, platform: "tiktok" }]) {
      const z = fakeZernio((r) => (r.path === `accounts/${ACC}` ? { body: { account: acc } } : undefined));
      expect(await conn(z.client).publish(input(), sink().io).catch((e) => e)).toMatchObject({ errorClass: "permanent", code: "zernio_account_mismatch" });
      expect(z.count("POST", "posts")).toBe(0);
    }
    const z = fakeZernio(() => undefined);
    expect(await conn(z.client).publish(input(null, { providerProfileId: null }), sink().io).catch((e) => e)).toMatchObject({ code: "zernio_profile_missing" });
    expect(z.calls).toHaveLength(0);
  });

  it("ainda publicando: termina a tentativa como 'zernio_processing'; a próxima só CONSULTA o mesmo post", async () => {
    const z = fakeZernio((r) => (r.path === `accounts/${ACC}` ? { body: { account } } : r.method === "POST" ? { status: 201, body: post("publishing", { status: "processing" }) } : undefined));
    const s = sink();
    expect(await conn(z.client).publish(input(), s.io).catch((e) => e)).toMatchObject({ errorClass: "transient", code: "zernio_processing" });
    const cp = s.saved.at(-1)![1];
    const z2 = fakeZernio((r) => (r.method === "GET" && r.path === "posts/post1" ? { body: published } : undefined));
    const res = await conn(z2.client).publish(input(cp), sink().io);
    expect(res.externalId).toBe("17900000000000001");
    expect(z2.count("POST", "posts")).toBe(0);
    expect(z2.count("GET", `accounts/${ACC}`)).toBe(0);
  });

  it("207 'scheduled' (erro transitório que a Zernio repete sozinha) não é falha; acompanha até publicar", async () => {
    let gets = 0;
    const z = fakeZernio((r) => {
      if (r.path === `accounts/${ACC}`) return { body: { account } };
      if (r.method === "POST") return { status: 207, body: post("scheduled", { status: "pending", errorMessage: "temporary error, retrying" }) };
      if (r.path === "posts/post1") return gets++ < 1 ? { body: post("publishing", { status: "processing" }) } : { body: published };
    });
    const res = await conn(z.client, { pollBudgetMs: 60_000 }).publish(input(), sink().io);
    expect(res.permalink).toBe("https://www.instagram.com/reel/ABC/");
  });

  it("207 'failed' por conteúdo: falha definitiva com a mensagem da rede, sem retry nem novo post", async () => {
    const z = fakeZernio((r) =>
      r.path === `accounts/${ACC}` ? { body: { account } } : r.method === "POST" ? { status: 207, body: post("failed", { status: "failed", errorCategory: "user_content", errorMessage: "Video aspect ratio not supported" }) } : undefined,
    );
    const err = await conn(z.client).publish(input(), sink().io).catch((e) => e);
    expect(err).toMatchObject({ errorClass: "permanent", code: "zernio_user_content" });
    expect(err.message).toContain("Video aspect ratio not supported");
    expect(z.count("POST", "posts/post1/retry")).toBe(0);
  });

  it("falha transitória da plataforma: pede /retry no MESMO post (limitado) e publica", async () => {
    let retried = false;
    const z = fakeZernio((r) => {
      if (r.path === `accounts/${ACC}`) return { body: { account } };
      if (r.method === "POST" && r.path === "posts") return { status: 207, body: post("failed", { status: "failed", errorCategory: "platform_error" }) };
      if (r.path === "posts/post1/retry") {
        retried = true;
        return { body: post("publishing", { status: "processing" }) };
      }
      if (r.path === "posts/post1") return { body: retried ? published : post("failed", { status: "failed", errorCategory: "platform_error" }) };
    });
    const s = sink();
    const res = await conn(z.client, { pollBudgetMs: 60_000 }).publish(input(), s.io);
    expect(res.externalId).toBe("17900000000000001");
    expect(z.count("POST", "posts")).toBe(1);
    expect(z.count("POST", "posts/post1/retry")).toBe(1);
    expect(s.saved.at(-1)![1]).toMatchObject({ remote_retries: 1 });
    // Limite atingido: vira falha definitiva, sem mais retries.
    const z2 = fakeZernio((r) => (r.path === "posts/post1" ? { body: post("failed", { status: "failed", errorCategory: "platform_error" }) } : undefined));
    const err = await conn(z2.client).publish(input({ provider: "zernio", idempotency_key: "reelsflow-job-job1", zernio_post_id: "post1", remote_retries: 3 }), sink().io).catch((e) => e);
    expect(err).toMatchObject({ errorClass: "permanent" });
    expect(z2.count("POST", "posts/post1/retry")).toBe(0);
  });

  it("token expirado na Zernio: erro de autorização (conta aguarda reconexão)", async () => {
    const z = fakeZernio((r) => (r.path === "posts/post1" ? { body: post("failed", { status: "failed", errorCategory: "auth_expired", errorMessage: "token expired" }) } : undefined));
    expect(await conn(z.client).publish(input({ provider: "zernio", idempotency_key: "k", zernio_post_id: "post1" }), sink().io).catch((e) => e)).toMatchObject({ errorClass: "auth" });
  });
});

describe("ZernioConnector — erros HTTP e duplicação", () => {
  const withCreate = (resp: ReturnType<Route>) => fakeZernio((r) => (r.path === `accounts/${ACC}` ? { body: { account } } : r.method === "POST" ? resp : undefined));

  it("sem resposta no pedido (rede/5xx): INCERTO, nunca falha cega", async () => {
    for (const resp of [new TypeError("fetch failed"), { status: 502, body: { error: "bad gateway", type: "platform_error" } }]) {
      const err = await conn(withCreate(resp as never).client).publish(input(), sink().io).catch((e) => e);
      expect(err).toMatchObject({ sideEffectStarted: true });
      expect(["unknown", "timeout"]).toContain(err.errorClass);
    }
  });

  it("409 duplicate_content: não publica de novo nem adota o post de outra publicação", async () => {
    const err = await conn(withCreate({ status: 409, body: { error: "dup", code: "duplicate_content", details: { existingPostId: "other" } } }).client).publish(input(), sink().io).catch((e) => e);
    expect(err).toMatchObject({ errorClass: "permanent", code: "zernio_duplicate_content" });
  });

  it("409 idempotency_conflict (mesmo pedido em processamento): espera e repete", async () => {
    const err = await conn(withCreate({ status: 409, body: { error: "busy", code: "idempotency_conflict" }, headers: { "retry-after": "5" } }).client).publish(input(), sink().io).catch((e) => e);
    expect(err).toMatchObject({ errorClass: "transient", retryAfterSeconds: 5 });
  });

  it("401 (chave do ReelsFlow inválida) espera sem culpar a conta; 429 respeita Retry-After; 400 é definitivo", async () => {
    expect(await conn(withCreate({ status: 401, body: { error: "bad key", type: "authentication_error" } }).client).publish(input(), sink().io).catch((e) => e)).toMatchObject({
      errorClass: "transient",
      code: "zernio_api_key",
    });
    expect(await conn(withCreate({ status: 429, body: { error: "slow" }, headers: { "retry-after": "20" } }).client).publish(input(), sink().io).catch((e) => e)).toMatchObject({
      errorClass: "rate_limited",
      retryAfterSeconds: 20,
    });
    expect(await conn(withCreate({ status: 400, body: { error: "invalid", code: "invalid_field_value" } }).client).publish(input(), sink().io).catch((e) => e)).toMatchObject({
      errorClass: "permanent",
    });
  });

  it("sem resultado em 6 h: vira incerto (reconciliação), não falha", async () => {
    let clock = 0;
    const z = fakeZernio((r) => (r.path === "posts/post1" ? { body: post("publishing", { status: "processing" }) } : undefined));
    const c = conn(z.client, { now: () => clock });
    clock = 7 * 3600_000;
    const err = await c.publish(input({ provider: "zernio", idempotency_key: "k", zernio_post_id: "post1", requested_at: 0 }), sink().io).catch((e) => e);
    expect(err).toMatchObject({ errorClass: "unknown", code: "zernio_unresolved", sideEffectStarted: true });
  });
});

describe("ZernioConnector — reconciliação", () => {
  const acc = input().account;
  it("sem id salvo: procura o post pelo externalId da publicação", async () => {
    const z = fakeZernio((r) => (r.path === "posts" && r.method === "GET" ? { body: { posts: [published.post] } } : undefined));
    const st = await conn(z.client).getStatus(acc, { provider: "zernio", idempotency_key: "reelsflow-job-job1" });
    expect(st).toEqual({ state: "published", externalId: "17900000000000001", permalink: "https://www.instagram.com/reel/ABC/" });
    expect(z.calls[0]!.query.get("externalId")).toBe("reelsflow-job-job1");
  });
  it("não encontrado → seguro repetir; em andamento → processing; erro → unknown", async () => {
    expect(await conn(fakeZernio(() => ({ body: { posts: [] } })).client).getStatus(acc, { idempotency_key: "k" })).toEqual({ state: "not_found" });
    expect((await conn(fakeZernio(() => ({ body: post("publishing", { status: "processing" }) })).client).getStatus(acc, { zernio_post_id: "post1" })).state).toBe("processing");
    expect((await conn(fakeZernio(() => new TypeError("x")).client).getStatus(acc, { zernio_post_id: "post1" })).state).toBe("unknown");
  });
});

describe("ZernioConnector — imagem (Card Editorial)", () => {
  const img = (platform: "instagram" | "tiktok" = "instagram"): PublishInput => ({
    ...input(null, { platform }),
    media: { storagePath: "ws/m/original.jpg", mimeType: "image/jpeg", sizeBytes: 300_000, durationMs: null, url: "https://storage.test/card.jpg?token=x" },
  });
  it("envia como imagem (post de feed), sem opções de Reel", async () => {
    const z = fakeZernio((r) => (r.path === `accounts/${ACC}` ? { body: { account } } : r.method === "POST" ? { status: 201, body: published } : undefined));
    await conn(z.client).publish(img(), sink().io);
    const body = z.calls.find((c) => c.method === "POST")!.body;
    expect(body.mediaItems).toEqual([{ type: "image", url: "https://storage.test/card.jpg?token=x" }]);
    expect(body.platforms[0].platformSpecificData).toBeUndefined();
  });
  it("imagem para TikTok: recusada antes de qualquer chamada", async () => {
    const z = fakeZernio(() => undefined);
    expect(await conn(z.client).publish(img("tiktok"), sink().io).catch((e) => e)).toMatchObject({ errorClass: "permanent", code: "zernio_image_platform" });
    expect(z.calls).toHaveLength(0);
  });
});
