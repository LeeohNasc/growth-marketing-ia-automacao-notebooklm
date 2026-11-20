import { describe, expect, it } from "vitest";
import type { Phase, PublishInput } from "../types";
import { FakeGraph } from "./fake-graph";
import { GraphClient } from "./graph";
import { InstagramConnector } from "./instagram";
import {
  buildInstagramAuthUrl,
  cleanInstagramCode,
  exchangeInstagramCode,
  exchangeInstagramLongLived,
  fetchInstagramProfile,
  missingInstagramScopes,
  refreshInstagramToken,
} from "./instagram-login";

const cfg = { appId: "ig-app", appSecret: "ig-secret", redirectUri: "https://app.test/api/oauth/instagram/callback" };
const noSleep = async () => {};

describe("Instagram Login — OAuth", () => {
  it("URL de autorização com escopos business, state e force_reauth", () => {
    const u = new URL(buildInstagramAuthUrl(cfg, "st"));
    expect(u.origin + u.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "ig-app",
      redirect_uri: cfg.redirectUri,
      response_type: "code",
      scope: "instagram_business_basic,instagram_business_content_publish",
      state: "st",
      force_reauth: "true",
    });
  });

  it("remove o sufixo #_ do code", () => {
    expect(cleanInstagramCode("abc#_")).toBe("abc");
    expect(cleanInstagramCode("abc")).toBe("abc");
  });

  it("troca o code em api.instagram.com (multipart) e lê a resposta dentro de data[]", async () => {
    let seen: { url: string; body: FormData } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), body: init.body as FormData };
      return new Response('{"data":[{"access_token":"short","user_id":17841400000000001,"permissions":"instagram_business_basic,instagram_business_content_publish"}]}');
    }) as unknown as typeof fetch;
    const r = await exchangeInstagramCode(cfg, "c0de#_", fetchImpl);
    expect(seen!.url).toBe("https://api.instagram.com/oauth/access_token");
    expect(Object.fromEntries((seen!.body as unknown as Iterable<[string, string]>))).toEqual({
      client_id: "ig-app",
      client_secret: "ig-secret",
      grant_type: "authorization_code",
      redirect_uri: cfg.redirectUri,
      code: "c0de",
    });
    expect(r).toEqual({ shortToken: "short", userId: "17841400000000001", permissions: ["instagram_business_basic", "instagram_business_content_publish"] });
    expect(missingInstagramScopes(r.permissions)).toEqual([]);
  });

  it("code inválido vira erro (sem token)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error_type: "OAuthException", code: 400, error_message: "Invalid authorization code" }), { status: 400 })) as unknown as typeof fetch;
    await expect(exchangeInstagramCode(cfg, "x", fetchImpl)).rejects.toThrow("Invalid authorization code");
  });

  it("token curto → longo (ig_exchange_token) e renovação (ig_refresh_token) em graph.instagram.com", async () => {
    const g = new FakeGraph()
      .on("GET", "access_token", { body: { access_token: "long", token_type: "bearer", expires_in: 5184000 } })
      .on("GET", "refresh_access_token", { body: { access_token: "long2", token_type: "bearer", expires_in: 5184000 } });
    const graph = new GraphClient({ fetchImpl: g.fetch });
    const long = await exchangeInstagramLongLived(graph, cfg, "short");
    const ref = await refreshInstagramToken(graph, "long");
    expect(long.token).toBe("long");
    expect(long.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 86400_000);
    expect(ref.token).toBe("long2");
    expect(g.calls.map((c) => [c.host, c.path, c.params.grant_type])).toEqual([
      ["graph.instagram.com", "access_token", "ig_exchange_token"],
      ["graph.instagram.com", "refresh_access_token", "ig_refresh_token"],
    ]);
    expect(g.calls[0]!.params).toMatchObject({ client_secret: "ig-secret", access_token: "short" });
    expect(g.calls[1]!.params.client_secret).toBeUndefined(); // renovação não usa o App Secret
  });

  it("perfil via /me (formato data[] da doc ou objeto direto)", async () => {
    const wrapped = new FakeGraph().on("GET", "me", {
      body: { data: [{ user_id: "178", username: "loja", name: "Loja", account_type: "Business", profile_picture_url: "https://cdn/p.jpg" }] },
    });
    expect(await fetchInstagramProfile(new GraphClient({ fetchImpl: wrapped.fetch }), "t")).toEqual({
      userId: "178",
      username: "loja",
      name: "Loja",
      avatarUrl: "https://cdn/p.jpg",
      accountType: "Business",
    });
    expect(wrapped.calls[0]!.host).toBe("graph.instagram.com");
    const plain = new FakeGraph().on("GET", "me", { body: { user_id: 9, username: "x" } });
    expect((await fetchInstagramProfile(new GraphClient({ fetchImpl: plain.fetch }), "t")).userId).toBe("9");
  });
});

const input = (checkpoint: Record<string, unknown> | null = null): PublishInput => ({
  jobId: "job",
  attemptNo: 1,
  account: { id: "acc", platform: "instagram", externalAccountId: "ig1", settings: {} },
  media: { storagePath: "p", mimeType: "video/mp4", sizeBytes: 1, durationMs: 10_000, url: "https://storage.test/v.mp4?token=assinado" },
  caption: "Legenda #reels",
  checkpoint,
  credentials: { accessToken: "IGAA-token" },
});
const sink = () => {
  const saved: [Phase, Record<string, unknown>][] = [];
  return { saved, io: { save: async (p: Phase, c: Record<string, unknown>) => void saved.push([p, c]) } };
};
const happy = () =>
  new FakeGraph()
    .on("GET", "me", { body: { user_id: "ig1", username: "loja" } })
    .on("GET", "ig1/content_publishing_limit", { body: { data: [{ quota_usage: 1, config: { quota_total: 100 } }] } })
    .on("POST", "ig1/media", { body: { id: "c1" } })
    .on("GET", "c1", { body: { status_code: "FINISHED" } })
    .on("POST", "ig1/media_publish", { body: { id: "m1" } })
    .on("GET", "m1", { body: { permalink: "https://www.instagram.com/reel/abc/" } });

describe("InstagramConnector — Instagram Login", () => {
  it("usa graph.instagram.com; token em Bearer nos POSTs e access_token nas leituras (como na doc)", async () => {
    const g = happy();
    const r = await new InstagramConnector(new GraphClient({ fetchImpl: g.fetch }), { sleep: noSleep }).publish(input(), sink().io);
    expect(r).toEqual({ externalId: "m1", permalink: "https://www.instagram.com/reel/abc/" });
    expect(g.calls.every((c) => c.host === "graph.instagram.com")).toBe(true);
    for (const c of g.calls) {
      if (c.method === "POST") {
        expect(c.headers.Authorization).toBe("Bearer IGAA-token");
        expect(c.params.access_token).toBeUndefined();
      } else {
        expect(c.params.access_token).toBe("IGAA-token");
      }
    }
    expect(g.calls[0]!.path).toBe("me"); // identidade conferida antes de qualquer efeito
    expect(g.calls.find((c) => c.path === "ig1/media")!.params).toMatchObject({ media_type: "REELS", share_to_feed: "true" });
  });

  it("token de outra conta: não cria container nem publica", async () => {
    const other = new FakeGraph().on("GET", "me", { body: { user_id: "ig-OUTRA", username: "outra" } });
    const err = await new InstagramConnector(new GraphClient({ fetchImpl: other.fetch })).publish(input(), sink().io).catch((e) => e);
    expect(err).toMatchObject({ errorClass: "permanent", code: "ig_account_mismatch", sideEffectStarted: false });
    expect(other.calls.map((c) => c.path)).toEqual(["me"]);
  });

  it("container é retomado entre tentativas e o prazo total de processamento é respeitado", async () => {
    let clock = 1_000_000;
    const g = new FakeGraph()
      .on("GET", "me", { body: { user_id: "ig1" } })
      .on("GET", "ig1/content_publishing_limit", { body: { data: [] } })
      .on("POST", "ig1/media", { body: { id: "c1" } })
      .on("GET", "c1", { body: { status_code: "IN_PROGRESS" } });
    const c = new InstagramConnector(new GraphClient({ fetchImpl: g.fetch }), { sleep: noSleep, pollBudgetMs: 0, now: () => clock });
    const s = sink();
    expect(await c.publish(input(), s.io).catch((e) => e)).toMatchObject({ code: "ig_processing", errorClass: "transient" });
    const cp = s.saved[0]![1];
    expect(cp).toEqual({ container_id: "c1", container_created_at: 1_000_000 });

    clock += 31 * 60_000;
    const err = await c.publish(input(cp), sink().io).catch((e) => e);
    expect(err).toMatchObject({ code: "ig_processing_timeout", errorClass: "permanent" });
    expect(g.count("POST", "ig1/media")).toBe(1);
    expect(g.count("POST", "ig1/media_publish")).toBe(0);
  });

  it("reconciliação escolhe o Reel pela legenda quando há mais de um recente", async () => {
    const now = new Date().toISOString();
    const g = new FakeGraph().on("GET", "me", { body: { user_id: "ig1" } }).on("GET", "c1", { body: { status_code: "PUBLISHED" } }).on("GET", "ig1/media", {
      body: {
        data: [
          { id: "m-outro", caption: "Outro", timestamp: now, media_product_type: "REELS", permalink: "https://www.instagram.com/reel/o/" },
          { id: "m-certo", caption: "Legenda #reels", timestamp: now, media_product_type: "REELS", permalink: "https://www.instagram.com/reel/c/" },
        ],
      },
    });
    const c = new InstagramConnector(new GraphClient({ fetchImpl: g.fetch }), { sleep: noSleep });
    const r = await c.publish(input({ container_id: "c1", container_created_at: Date.now(), publish_requested_at: now }), sink().io);
    // Container já PUBLISHED: não chama media_publish de novo.
    expect(g.count("POST", "ig1/media_publish")).toBe(0);
    expect(r).toEqual({ externalId: "m-certo", permalink: "https://www.instagram.com/reel/c/" });
  });

  it("vários recentes sem legenda igual: não chuta um ID; registra o container", async () => {
    const now = new Date().toISOString();
    const g = new FakeGraph()
      .on("GET", "me", { body: { user_id: "ig1" } })
      .on("GET", "c1", { body: { status_code: "PUBLISHED" } })
      .on("GET", "ig1/media", { body: { data: [{ id: "a", caption: "x", timestamp: now }, { id: "b", caption: "y", timestamp: now }] } });
    const r = await new InstagramConnector(new GraphClient({ fetchImpl: g.fetch })).publish(input({ container_id: "c1", publish_requested_at: now }), sink().io);
    expect(r).toEqual({ externalId: "container:c1", permalink: null });
  });
});

describe("IDs grandes", () => {
  it("user_id numérico de 17 dígitos não é arredondado em /me nem na checagem de identidade", async () => {
    const big = (path: string, body: string) => {
      const f = (async (url: string) => {
        const u = new URL(String(url));
        return new Response(u.pathname.endsWith(path) ? body : "{}");
      }) as unknown as typeof fetch;
      return new GraphClient({ fetchImpl: f });
    };
    const p = await fetchInstagramProfile(big("/me", '{"user_id": 17841400000000001, "username": "loja"}'), "t");
    expect(p.userId).toBe("17841400000000001");
  });
});
