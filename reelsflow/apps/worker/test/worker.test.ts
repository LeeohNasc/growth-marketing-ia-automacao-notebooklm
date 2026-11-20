import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeDb } from "./db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger, silentLogger } from "../src/log";
import { expireStaleUploads, processStorageGc } from "../src/maintenance";
import { backoffSeconds, claimJobs, failJob, reapExpiredLeases } from "../src/queue";
import { LocalStorage } from "../src/storage";
import { runJob, tick } from "../src/worker";
import type { HandlerDeps } from "../src/handlers/types";


const db = makeDb(6);
const root = mkdtempSync(path.join(os.tmpdir(), "rf-storage-"));
const tmp = mkdtempSync(path.join(os.tmpdir(), "rf-tmp-"));
const storage = new LocalStorage(root);
const deps: HandlerDeps = { db, storage, log: silentLogger, ffmpeg: { ffprobe: "ffprobe", ffmpeg: "ffmpeg" }, tmpDir: tmp };
const opts = { workerId: "test-worker", concurrency: 4, leaseSeconds: 60, pollMs: 100, maintenanceEveryMs: 0 };

let videoFile: string;
let userId: string;
let ws: string;

function makeVideo(file: string, size = "360x640", seconds = 4) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=30`, "-f", "lavfi", "-i", "sine", "-t", String(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
}

async function newMedia(opts: { status?: string; ext?: string; deleted?: boolean } = {}) {
  const id = (await db.query<{ id: string }>("select gen_random_uuid() as id")).rows[0]!.id;
  const storagePath = `${ws}/${id}/original.${opts.ext ?? "mp4"}`;
  await db.query(
    `insert into public.media_assets (id, workspace_id, uploaded_by, name, original_filename, storage_path, mime_type, size_bytes, sha256, status, deleted_at)
     values ($1, $2, $3, 'clip', 'clip.mp4', $4, 'video/mp4', 1000, $5, 'uploading', case when $6 then now() else null end)`,
    [id, ws, userId, storagePath, "a".repeat(64), opts.deleted ?? false],
  );
  if (opts.status && opts.status !== "uploading") {
    await db.query("update public.media_assets set status = 'uploaded' where id = $1", [id]);
  }
  return { id, storagePath };
}

async function enqueue(kind: "probe" | "purge", mediaId: string | null, payload: object = {}) {
  const r = await db.query<{ id: string }>(
    "insert into public.media_jobs (workspace_id, media_asset_id, kind, payload) values ($1, $2, $3, $4) returning id::text",
    [ws, mediaId, kind, JSON.stringify(payload)],
  );
  return r.rows[0]!.id;
}

const media = async (id: string) => (await db.query("select * from public.media_assets where id = $1", [id])).rows[0];
const job = async (id: string) => (await db.query("select * from public.media_jobs where id = $1", [id])).rows[0];

beforeAll(async () => {
  videoFile = path.join(tmp, "src.mp4");
  makeVideo(videoFile);
  userId = (await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id", [`w-${Date.now()}@test.local`])).rows[0]!.id;
  ws = (
    await db.query<{ id: string }>(
      "insert into public.workspaces (name, slug, created_by) values ('Worker', $1, $2) returning id",
      [`worker-${Date.now()}`, userId],
    )
  ).rows[0]!.id;
  await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, userId]);
});

beforeEach(async () => {
  // Isola cada teste: nenhum job pendente de outros testes.
  await db.query("update public.media_jobs set status = 'cancelled' where status in ('queued','running')");
});

afterAll(async () => {
  await db.end();
  rmSync(root, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe("fila", () => {
  it("workers concorrentes nunca reivindicam o mesmo job", async () => {
    const ids = await Promise.all(Array.from({ length: 40 }, () => enqueue("purge", null, { paths: [] })));
    const claimLoop = async (worker: string) => {
      const mine: string[] = [];
      for (;;) {
        const got = await claimJobs(db, worker, 3, 60);
        if (!got.length) break;
        mine.push(...got.map((j) => j.id));
      }
      return mine;
    };
    const [a, b, c] = await Promise.all([claimLoop("w-a"), claimLoop("w-b"), claimLoop("w-c")]);
    const all = [...a, ...b, ...c];
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(ids));
  });

  it("lease expirado volta para a fila; tentativas esgotadas viram falha", async () => {
    const j1 = await enqueue("purge", null);
    const j2 = await enqueue("purge", null);
    await db.query("update public.media_jobs set status='running', lease_owner='morto', lease_expires_at=now()-interval '1 min', attempts=1 where id=$1", [j1]);
    await db.query("update public.media_jobs set status='running', lease_owner='morto', lease_expires_at=now()-interval '1 min', attempts=5 where id=$1", [j2]);
    expect(await reapExpiredLeases(db)).toBeGreaterThanOrEqual(2);
    expect((await job(j1)).status).toBe("queued");
    expect((await job(j2)).status).toBe("failed");
  });

  it("falha reagenda com backoff e encerra na última tentativa", async () => {
    await enqueue("purge", null);
    const [claimed] = await claimJobs(db, "w", 1, 60);
    expect(await failJob(db, claimed!, "w", "boom")).toBe(false);
    const row = await job(claimed!.id);
    expect(row.status).toBe("queued");
    expect(new Date(row.run_after).getTime()).toBeGreaterThan(Date.now() + 20_000);

    await db.query("update public.media_jobs set run_after = now(), attempts = 4 where id = $1", [claimed!.id]);
    const [again] = await claimJobs(db, "w", 1, 60);
    expect(again!.attempts).toBe(5);
    expect(await failJob(db, again!, "w", "boom")).toBe(true);
    expect((await job(claimed!.id)).status).toBe("failed");
  });

  it("backoff cresce e é limitado a 1h", () => {
    const mid = () => 0.5;
    expect(backoffSeconds(1, mid)).toBe(30);
    expect(backoffSeconds(2, mid)).toBe(60);
    expect(backoffSeconds(3, mid)).toBe(120);
    expect(backoffSeconds(20, mid)).toBe(3600);
  });

  it("heartbeat de job alheio é recusado", async () => {
    const { heartbeat } = await import("../src/queue");
    await enqueue("purge", null);
    const [j] = await claimJobs(db, "dono", 1, 60);
    expect(await heartbeat(db, j!.id, "outro", 60)).toBe(false);
    expect(await heartbeat(db, j!.id, "dono", 60)).toBe(true);
  });
});

describe("probe", () => {
  it("extrai metadados, gera thumbnail, avalia compatibilidade e notifica o lote", async () => {
    const m = await newMedia({ status: "uploaded" });
    await storage.upload(m.storagePath, videoFile);
    const j = await enqueue("probe", m.id);
    await tick(deps, opts, { lastMaintenance: Date.now() });

    const row = await media(m.id);
    expect(row.status).toBe("ready");
    expect(row).toMatchObject({ width: 360, height: 640, video_codec: "h264", audio_codec: "aac", has_audio: true });
    expect(row.duration_ms).toBeGreaterThan(3500);
    expect(row.thumbnail_path).toBe(`${ws}/${m.id}/thumb.jpg`);
    expect(existsSync(path.join(root, row.thumbnail_path))).toBe(true);
    expect(row.compatibility.platforms.instagram_reels.status).toBe("ok");
    expect((await job(j)).status).toBe("succeeded");

    const notes = await db.query("select type, payload from public.notifications where workspace_id = $1 and type = 'upload.completed'", [ws]);
    expect(notes.rows.at(-1)?.payload.count).toBeGreaterThanOrEqual(1);
  });

  it("arquivo que não é vídeo falha de forma permanente, sem retry", async () => {
    const m = await newMedia({ status: "uploaded" });
    await storage.put(m.storagePath, "isto não é um vídeo");
    const j = await enqueue("probe", m.id);
    await tick(deps, opts, { lastMaintenance: Date.now() });
    expect(await media(m.id)).toMatchObject({ status: "failed", failure_reason: "invalid_video" });
    expect((await job(j)).status).toBe("succeeded");
    const n = await db.query("select payload from public.notifications where type = 'upload.failed' and payload->>'media_id' = $1", [m.id]);
    expect(n.rowCount).toBe(1);
  });

  describe("modo remoto (Edge Function: sem ffmpeg, leitura por faixas)", () => {
    let served = 0;
    // fetch que atende Range a partir do LocalStorage, como o Storage do Supabase.
    const rangeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const file = path.join(root, decodeURIComponent(url.pathname.slice(1)));
      if (!existsSync(file)) return new Response("not found", { status: 404 });
      const buf = readFileSync(file);
      const range = new Headers(init?.headers).get("range");
      const m = range?.match(/^bytes=(\d+)-(\d+)$/);
      if (!m) { served += buf.length; return new Response(buf, { status: 200 }); }
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), buf.length - 1);
      served += end - start + 1;
      return new Response(buf.subarray(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${buf.length}` },
      });
    }) as typeof fetch;
    const remote: HandlerDeps = { ...deps, probeMode: "remote", fetchImpl: rangeFetch, tmpDir: "/nao-existe" };

    it("usa a miniatura enviada pelo navegador e lê só o índice do arquivo", async () => {
      const m = await newMedia({ status: "uploaded" });
      await storage.upload(m.storagePath, videoFile);
      await storage.put(`${ws}/${m.id}/thumb.jpg`, "jpeg");
      served = 0;
      const j = await enqueue("probe", m.id);
      await tick(remote, opts, { lastMaintenance: Date.now() });
      const row = await media(m.id);
      expect(row).toMatchObject({ status: "ready", width: 360, height: 640, video_codec: "h264", audio_codec: "aac", has_audio: true });
      expect(row.thumbnail_path).toBe(`${ws}/${m.id}/thumb.jpg`);
      expect(row.compatibility.platforms.instagram_reels.status).toBe("ok");
      expect((await job(j)).status).toBe("succeeded");
      expect(served).toBeLessThan(statSync(videoFile).size);
    });

    it("sem miniatura do navegador o vídeo fica pronto sem thumbnail", async () => {
      const m = await newMedia({ status: "uploaded" });
      await storage.upload(m.storagePath, videoFile);
      await enqueue("probe", m.id);
      await tick(remote, opts, { lastMaintenance: Date.now() });
      expect(await media(m.id)).toMatchObject({ status: "ready", thumbnail_path: null });
    });

    it("arquivo inválido falha de forma permanente", async () => {
      const m = await newMedia({ status: "uploaded" });
      await storage.put(m.storagePath, "isto não é um vídeo, mas tem bytes suficientes para ler caixas");
      await enqueue("probe", m.id);
      await tick(remote, opts, { lastMaintenance: Date.now() });
      expect(await media(m.id)).toMatchObject({ status: "failed", failure_reason: "invalid_video" });
    });
  });

  it("erro transitório reagenda; na última tentativa marca o vídeo como falho", async () => {
    const m = await newMedia({ status: "uploaded" }); // arquivo ausente → download falha
    const j = await enqueue("probe", m.id);
    await tick(deps, opts, { lastMaintenance: Date.now() });
    expect((await job(j)).status).toBe("queued");
    expect((await media(m.id)).status).toBe("processing");

    await db.query("update public.media_jobs set run_after = now(), attempts = 4 where id = $1", [j]);
    await tick(deps, opts, { lastMaintenance: Date.now() });
    expect((await job(j)).status).toBe("failed");
    expect(await media(m.id)).toMatchObject({ status: "failed", failure_reason: "processing_error" });
  });

  it("recupera job de worker que morreu no meio do processamento", async () => {
    const m = await newMedia({ status: "uploaded" });
    await storage.upload(m.storagePath, videoFile);
    const j = await enqueue("probe", m.id);
    const [claimed] = await claimJobs(db, "worker-que-morreu", 1, 60);
    expect(claimed!.id).toBe(j);
    await db.query("update public.media_assets set status = 'processing' where id = $1", [m.id]); // morreu aqui
    await db.query("update public.media_jobs set lease_expires_at = now() - interval '1 s' where id = $1", [j]);

    await tick(deps, opts, { lastMaintenance: 0 }); // manutenção roda o reaper e o job é reprocessado
    expect((await media(m.id)).status).toBe("ready");
    expect((await job(j)).status).toBe("succeeded");
  });

  it("vídeo excluído antes do processamento é ignorado", async () => {
    const m = await newMedia({ status: "uploaded", deleted: true });
    const j = await enqueue("probe", m.id);
    await tick(deps, opts, { lastMaintenance: Date.now() });
    expect((await job(j)).status).toBe("succeeded");
    expect((await media(m.id)).status).toBe("uploaded");
  });
});

describe("limpeza", () => {
  it("purge remove arquivos e o registro do vídeo excluído", async () => {
    const m = await newMedia({ status: "uploaded" });
    await storage.upload(m.storagePath, videoFile);
    await storage.put(`${ws}/${m.id}/thumb.jpg`, "x");
    await db.query("update public.media_assets set thumbnail_path = $2, deleted_at = now() where id = $1", [m.id, `${ws}/${m.id}/thumb.jpg`]);
    const j = await enqueue("purge", m.id, { paths: [m.storagePath] });
    const [claimed] = await claimJobs(db, "w", 1, 60);
    expect(claimed!.id).toBe(j);
    await runJob(claimed!, deps, opts);
    expect(await storage.exists(m.storagePath)).toBe(false);
    expect(await storage.exists(`${ws}/${m.id}/thumb.jpg`)).toBe(false);
    expect(await media(m.id)).toBeUndefined();
  });

  it("purge de vídeo restaurado não apaga nada", async () => {
    const m = await newMedia({ status: "uploaded" });
    await storage.upload(m.storagePath, videoFile);
    await enqueue("purge", m.id, { paths: [m.storagePath] });
    const [claimed] = await claimJobs(db, "w", 1, 60);
    await runJob(claimed!, deps, opts);
    expect(await storage.exists(m.storagePath)).toBe(true);
    expect(await media(m.id)).toBeDefined();
  });

  it("uploads abandonados expiram e o arquivo parcial é agendado para remoção", async () => {
    const m = await newMedia();
    await storage.upload(m.storagePath, videoFile);
    await db.query("update public.media_assets set upload_expires_at = now() - interval '1 min' where id = $1", [m.id]);
    expect(await expireStaleUploads(db, storage, silentLogger)).toBeGreaterThanOrEqual(1);
    expect(await media(m.id)).toBeUndefined();
    const purge = await db.query("select 1 from public.media_jobs where kind = 'purge' and payload->'paths' ? $1", [m.storagePath]);
    expect(purge.rowCount).toBe(1);
  });

  it("arquivos de workspace excluído são removidos do storage", async () => {
    const owner = (await db.query<{ id: string }>("insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id", [`gc-${Date.now()}@t.local`])).rows[0]!.id;
    const w = (await db.query<{ id: string }>("insert into public.workspaces (name, slug) values ('GC', $1) returning id", [`gc-${Date.now()}`])).rows[0]!.id;
    await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [w, owner]);
    await storage.put(`${w}/a/original.mp4`, "1");
    await storage.put(`${w}/b/thumb.jpg`, "2");
    await storage.put(`${ws}/intocado.txt`, "3");
    await db.query("delete from public.workspaces where id = $1", [w]);
    await processStorageGc(db, storage, silentLogger);
    expect(await storage.list(`${w}/`)).toEqual([]);
    expect(await storage.exists(`${ws}/intocado.txt`)).toBe(true);
    const gc = await db.query("select done_at from public.storage_gc where prefix = $1", [`${w}/`]);
    expect(gc.rows[0]?.done_at).not.toBeNull();
  });
});

describe("segurança do worker", () => {
  it("LocalStorage recusa caminhos fora da raiz", async () => {
    await expect(storage.put("../fora.txt", "x")).rejects.toThrow("escapes");
  });

  it("logger não registra segredos nem tokens de URL", () => {
    const lines: string[] = [];
    const log = createLogger({}, (l) => lines.push(l));
    log.info("x", { access_token: "abc", url: "https://s/obj?token=SECRET&x=1", note: "ok" });
    const out = JSON.parse(lines[0]!);
    expect(out.access_token).toBe("[redacted]");
    expect(out.url).toBe("https://s/obj?token=[redacted]&x=1");
    expect(JSON.stringify(out)).not.toContain("SECRET");
    writeFileSync(path.join(tmp, "ok"), "");
  });
});
