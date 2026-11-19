import { describe, expect, it } from "vitest";
import { ConnectorError, MockConnector, toConnectorError, type MockPlatformStore, type Phase } from "./index";

function memoryStore() {
  const posts = new Map<string, { id: string; status: "processing" | "published" }>();
  const store: MockPlatformStore = {
    async createUpload(_a, ref) {
      const id = `p${posts.size + 1}`;
      posts.set(ref, { id, status: "processing" });
      return id;
    },
    async publish(ref) {
      posts.get(ref)!.status = "published";
    },
    async find(ref) {
      return posts.get(ref) ?? null;
    },
  };
  return { store, posts };
}

const input = (behavior: string, attemptNo = 1, checkpoint: Record<string, unknown> | null = null) => ({
  jobId: "job1",
  attemptNo,
  account: { id: "acc", platform: "mock" as const, externalAccountId: "x", settings: { mock_behavior: behavior } },
  media: { storagePath: "p", mimeType: "video/mp4", sizeBytes: 1, durationMs: 1000 },
  caption: "c",
  checkpoint,
});

function recorder() {
  const saved: [Phase, Record<string, unknown>][] = [];
  return { saved, io: { save: async (p: Phase, c: Record<string, unknown>) => void saved.push([p, c]) } };
}

describe("MockConnector", () => {
  it("sucesso grava checkpoints antes de cada efeito e retorna id externo", async () => {
    const { store, posts } = memoryStore();
    const { saved, io } = recorder();
    const r = await new MockConnector(store).publish(input("success"), io);
    expect(r.externalId).toBe("p1");
    expect(saved.map((s) => s[0])).toEqual(["uploading", "processing_remote", "publishing"]);
    expect(posts.get("job1:1")?.status).toBe("published");
  });

  it("classifica falhas e indica se houve efeito externo", async () => {
    const { store } = memoryStore();
    const c = new MockConnector(store);
    const err = async (b: string, n = 1) => c.publish(input(b, n), recorder().io).catch((e: ConnectorError) => e);
    expect(await err("auth_revoked")).toMatchObject({ errorClass: "auth", sideEffectStarted: false });
    expect(await err("permanent")).toMatchObject({ errorClass: "permanent" });
    expect(await err("transient")).toMatchObject({ errorClass: "transient" });
    expect(await err("timeout_before")).toMatchObject({ errorClass: "timeout", sideEffectStarted: false });
    expect(await err("timeout_after")).toMatchObject({ errorClass: "timeout", sideEffectStarted: true });
    expect(await err("uncertain")).toMatchObject({ errorClass: "unknown", sideEffectStarted: true });
    expect(await err("rate_limit")).toMatchObject({ errorClass: "rate_limited", retryAfterSeconds: 120 });
    expect(await err("flaky")).toMatchObject({ errorClass: "transient" });
    await expect(c.publish(input("flaky", 2), recorder().io)).resolves.toBeDefined();
  });

  it("timeout após publicar: getStatus confirma a publicação (reconciliação)", async () => {
    const { store } = memoryStore();
    const c = new MockConnector(store);
    const { saved, io } = recorder();
    await c.publish(input("timeout_after"), io).catch(() => undefined);
    const checkpoint = saved.at(-1)![1];
    expect(await c.getStatus(input("success").account, checkpoint)).toMatchObject({ state: "published" });
    expect(await c.getStatus(input("success").account, { upload_ref: "nada" })).toEqual({ state: "not_found" });
    expect(await c.getStatus(input("uncertain").account, checkpoint)).toEqual({ state: "unknown" });
  });

  it("retomada com checkpoint não cria segundo upload", async () => {
    const { store, posts } = memoryStore();
    const c = new MockConnector(store);
    await store.createUpload("acc", "job1:1", "c");
    await c.publish(input("success", 2, { upload_ref: "job1:1" }), recorder().io);
    expect(posts.size).toBe(1);
  });

  it("toConnectorError reconhece timeouts de rede", () => {
    expect(toConnectorError(new Error("socket hang up"), true)).toMatchObject({ errorClass: "timeout", sideEffectStarted: true });
    expect(toConnectorError(new Error("boom"), false)).toMatchObject({ errorClass: "unknown" });
  });
});
