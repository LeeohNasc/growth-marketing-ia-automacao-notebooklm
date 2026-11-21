import { describe, expect, it } from "vitest";
import { ZernioApiError, ZernioClient } from "./client";

const KEY = "sk_" + "a".repeat(64);

type Call = { method: string; url: URL; headers: Record<string, string>; body: unknown };
function mockFetch(handler: (c: Call) => { status?: number; body?: unknown; headers?: Record<string, string> } | Error) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const c: Call = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const r = handler(c);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("ZernioClient", () => {
  it("lê a chave de ZERNIO_API_KEY e recusa ambiente sem chave", () => {
    expect(() => ZernioClient.fromEnv({})).toThrow("ZERNIO_API_KEY");
    expect(ZernioClient.fromEnv({ ZERNIO_API_KEY: KEY })).toBeInstanceOf(ZernioClient);
  });

  it("autentica com Bearer na base https://zernio.com/api/v1", async () => {
    const m = mockFetch(() => ({ body: { profiles: [] } }));
    await new ZernioClient({ apiKey: KEY, fetchImpl: m.fetchImpl }).listProfiles({ externalId: "ws-1" });
    expect(m.calls[0]!.url.toString()).toBe("https://zernio.com/api/v1/profiles?externalId=ws-1");
    expect(m.calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("ensureProfile reaproveita o perfil existente pelo externalId (sem criar outro)", async () => {
    const m = mockFetch(() => ({ body: { profiles: [{ _id: "p1", name: "ReelsFlow", externalId: "ws-1" }] } }));
    const r = await new ZernioClient({ apiKey: KEY, fetchImpl: m.fetchImpl }).ensureProfile({ name: "ReelsFlow", externalId: "ws-1" });
    expect(r).toEqual({ profile: { _id: "p1", name: "ReelsFlow", externalId: "ws-1" }, created: false });
    expect(m.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("ensureProfile cria quando não existe", async () => {
    const m = mockFetch((c) =>
      c.method === "GET" ? { body: { profiles: [] } } : { status: 201, body: { message: "ok", profile: { _id: "p2", name: "ReelsFlow", externalId: "ws-2" } } },
    );
    const r = await new ZernioClient({ apiKey: KEY, fetchImpl: m.fetchImpl }).ensureProfile({ name: "ReelsFlow", externalId: "ws-2", description: "d" });
    expect(r.created).toBe(true);
    expect(r.profile._id).toBe("p2");
    expect(m.calls[1]!.body).toEqual({ name: "ReelsFlow", externalId: "ws-2", description: "d" });
  });

  it("ensureProfile: corrida (409 profile_external_id_conflict) usa o perfil existente", async () => {
    let gets = 0;
    const m = mockFetch((c) => {
      if (c.method === "GET") return gets++ === 0 ? { body: { profiles: [] } } : { body: { profiles: [{ _id: "p3", name: "ReelsFlow", externalId: "ws-3" }] } };
      return { status: 409, body: { error: "exists", type: "invalid_request_error", code: "profile_external_id_conflict", details: { existingProfileId: "p3" } } };
    });
    const r = await new ZernioClient({ apiKey: KEY, fetchImpl: m.fetchImpl }).ensureProfile({ name: "ReelsFlow", externalId: "ws-3" });
    expect(r).toMatchObject({ profile: { _id: "p3" }, created: false });
  });

  it("link de conexão: GET /v1/connect/{platform} com profileId e redirect_url", async () => {
    const m = mockFetch(() => ({ body: { authUrl: "https://www.instagram.com/oauth/authorize?x=1", state: "st" } }));
    const r = await new ZernioClient({ apiKey: KEY, fetchImpl: m.fetchImpl }).getConnectUrl("instagram", "p1", { redirectUrl: "https://app.test/back" });
    expect(r.authUrl).toBe("https://www.instagram.com/oauth/authorize?x=1");
    const u = m.calls[0]!.url;
    expect(u.pathname).toBe("/api/v1/connect/instagram");
    expect(Object.fromEntries(u.searchParams)).toEqual({ profileId: "p1", redirect_url: "https://app.test/back" });
  });

  it("recusa plataforma fora da lista e resposta sem authUrl", async () => {
    const c = new ZernioClient({ apiKey: KEY, fetchImpl: mockFetch(() => ({ body: {} })).fetchImpl });
    await expect(c.getConnectUrl("myspace" as never, "p1")).rejects.toThrow("não suportada");
    await expect(c.getConnectUrl("tiktok", "p1")).rejects.toMatchObject({ code: "missing_auth_url" });
  });

  it("erros tipados (type/code/details/request id/Retry-After) e retryable", async () => {
    const m = mockFetch(() => ({
      status: 429,
      body: { error: "Too many requests", type: "rate_limit_error", code: "rate_limited" },
      headers: { "retry-after": "30", "x-request-id": "req-1" },
    }));
    const err = await new ZernioClient({ apiKey: KEY, fetchImpl: m.fetchImpl }).listAccounts().catch((e) => e);
    expect(err).toBeInstanceOf(ZernioApiError);
    expect(err).toMatchObject({ status: 429, type: "rate_limit_error", code: "rate_limited", requestId: "req-1", retryAfterSeconds: 30, retryable: true });
    const auth = await new ZernioClient({ apiKey: KEY, fetchImpl: mockFetch(() => ({ status: 401, body: { error: "Invalid key", type: "authentication_error" } })).fetchImpl })
      .listProfiles()
      .catch((e) => e);
    expect(auth).toMatchObject({ status: 401, retryable: false });
  });

  it("a chave nunca aparece em mensagens de erro", async () => {
    const m = mockFetch(() => ({ status: 400, body: { error: `bad header Bearer ${KEY}` } }));
    const err = await new ZernioClient({ apiKey: KEY, fetchImpl: m.fetchImpl }).listProfiles().catch((e) => e);
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("[redacted]");
  });

  it("falha de rede e timeout viram erro repetível sem detalhes sensíveis", async () => {
    const net = await new ZernioClient({ apiKey: KEY, fetchImpl: mockFetch(() => new TypeError("fetch failed")).fetchImpl }).listProfiles().catch((e) => e);
    expect(net).toMatchObject({ status: 0, type: "network_error", retryable: true });
    const to = await new ZernioClient({ apiKey: KEY, fetchImpl: mockFetch(() => Object.assign(new Error("aborted"), { name: "AbortError" })).fetchImpl })
      .listProfiles()
      .catch((e) => e);
    expect(to).toMatchObject({ type: "timeout", retryable: true });
  });

  it("lista e desconecta contas", async () => {
    const m = mockFetch((c) => (c.method === "DELETE" ? { status: 200, body: { message: "ok" } } : { body: { accounts: [{ _id: "a1", platform: "instagram", profileId: "p1", username: "loja" }] } }));
    const c = new ZernioClient({ apiKey: KEY, fetchImpl: m.fetchImpl });
    expect((await c.listAccounts("p1"))[0]!._id).toBe("a1");
    await c.disconnectAccount("a1");
    expect(m.calls.map((x) => `${x.method} ${x.url.pathname}${x.url.search}`)).toEqual(["GET /api/v1/accounts?profileId=p1", "DELETE /api/v1/accounts/a1"]);
  });
});
