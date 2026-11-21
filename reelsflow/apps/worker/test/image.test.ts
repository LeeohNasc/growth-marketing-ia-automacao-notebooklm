import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ImageProbeError, probeJpeg } from "../src/media/image";
import { bufferReader } from "../src/media/mp4";

const dir = mkdtempSync(path.join(os.tmpdir(), "rf-img-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const make = (name: string, size: string, extra: string[] = []) => {
  const f = path.join(dir, name);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${size}`, "-frames:v", "1", ...extra, f]);
  return new Uint8Array(readFileSync(f));
};

describe("probeJpeg (cabeçalho, MIME real)", () => {
  it.each([
    ["1080x1350", 1080, 1350],
    ["1080x1080", 1080, 1080],
    ["1080x1920", 1080, 1920],
  ])("JPEG %s → dimensões exatas", async (size, w, h) => {
    expect(await probeJpeg(bufferReader(make(`c-${size}.jpg`, size)))).toEqual({ format: "jpeg", width: w, height: h });
  });

  it("JPEG progressivo (SOF2) também", async () => {
    make("base.jpg", "640x800");
    const prog = path.join(dir, "prog.jpg");
    execFileSync("convert", [path.join(dir, "base.jpg"), "-interlace", "JPEG", prog]);
    const buf = new Uint8Array(readFileSync(prog));
    // garante que o arquivo de teste é mesmo progressivo (marcador SOF2 = FF C2)
    expect(buf.some((b, i) => b === 0xff && buf[i + 1] === 0xc2)).toBe(true);
    expect(await probeJpeg(bufferReader(buf))).toEqual({ format: "jpeg", width: 640, height: 800 });
  });

  it("PNG com extensão .jpg e lixo são recusados", async () => {
    const png = make("fake.png", "100x100");
    await expect(probeJpeg(bufferReader(png))).rejects.toBeInstanceOf(ImageProbeError);
    await expect(probeJpeg(bufferReader(new TextEncoder().encode("isto não é imagem")))).rejects.toMatchObject({ code: "not_jpeg" });
    // JPEG truncado antes do SOF
    await expect(probeJpeg(bufferReader(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])))).rejects.toMatchObject({ code: "no_dimensions" });
  });
});

// ---------------------------------------------------------------------------
// Worker + banco: análise de imagem (render final de Card Editorial)
// ---------------------------------------------------------------------------
import { beforeAll } from "vitest";
import { silentLogger } from "../src/log";
import { LocalStorage } from "../src/storage";
import { tick } from "../src/worker";
import type { HandlerDeps } from "../src/handlers/types";
import { makeDb } from "./db";

const db = makeDb(4);
const root = mkdtempSync(path.join(os.tmpdir(), "rf-img-store-"));
const storage = new LocalStorage(root);
const deps: HandlerDeps = { db, storage, log: silentLogger, ffmpeg: { ffprobe: "ffprobe", ffmpeg: "ffmpeg" }, tmpDir: dir };
const opts = { workerId: "wi", concurrency: 2, leaseSeconds: 60, pollMs: 50, maintenanceEveryMs: 1e9 };
let ws = "";
let user = "";
afterAll(async () => {
  await db.end();
  rmSync(root, { recursive: true, force: true });
});
beforeAll(async () => {
  user = (await db.query("insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id", [`img-${Date.now()}@t.local`])).rows[0].id;
  ws = (await db.query("insert into public.workspaces (name, slug, created_by) values ('Imagens', $1, $2) returning id", [`img-${Date.now()}`, user])).rows[0].id;
  await db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, user]);
});

async function imageMedia(bytes: Uint8Array) {
  const id = (await db.query("select gen_random_uuid() as id")).rows[0].id as string;
  const p = `${ws}/${id}/original.jpg`;
  await storage.put(p, Buffer.from(bytes));
  await db.query(
    `insert into public.media_assets (id, workspace_id, uploaded_by, name, original_filename, storage_path, mime_type, size_bytes, sha256, status)
     values ($1, $2, $3, 'card', 'card.jpg', $4, 'image/jpeg', $5, $6, 'uploading')`,
    [id, ws, user, p, bytes.length, "a".repeat(64)],
  );
  await db.query("update public.media_assets set status = 'uploaded' where id = $1", [id]);
  await db.query("insert into public.media_jobs (workspace_id, media_asset_id, kind) values ($1, $2, 'probe')", [ws, id]);
  return { id, path: p };
}
const row = async (id: string) => (await db.query("select * from public.media_assets where id = $1", [id])).rows[0];

describe("worker: análise de imagem", () => {
  it("JPEG 4:5 → pronto, dimensões, a própria imagem como miniatura, compatível com Instagram (feed)", async () => {
    const m = await imageMedia(make("w-feed.jpg", "1080x1350"));
    await tick(deps, opts, { lastMaintenance: Date.now() });
    const r = await row(m.id);
    expect(r).toMatchObject({ status: "ready", kind: "image", width: 1080, height: 1350, container: "jpeg", thumbnail_path: m.path, has_audio: false, duration_ms: null });
    expect(r.compatibility.kind).toBe("image");
    expect(r.compatibility.platforms.instagram_reels.status).toBe("warning");
  });

  it("JPEG 9:16 → pronto, mas incompatível com o feed do Instagram", async () => {
    const m = await imageMedia(make("w-vert.jpg", "1080x1920"));
    await tick(deps, opts, { lastMaintenance: Date.now() });
    expect((await row(m.id)).compatibility.platforms.instagram_reels.status).toBe("error");
  });

  it("arquivo que não é JPEG (mesmo com MIME declarado) → falha permanente 'invalid_image'", async () => {
    const m = await imageMedia(make("w-fake.png", "64x64"));
    await tick(deps, opts, { lastMaintenance: Date.now() });
    expect(await row(m.id)).toMatchObject({ status: "failed", failure_reason: "invalid_image" });
  });

  it("modo remoto (Edge Function): lê só o cabeçalho por faixas HTTP", async () => {
    const bytes = make("w-remote.jpg", "1080x1080");
    const m = await imageMedia(bytes);
    let served = 0;
    const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("range");
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range ?? "") ?? [];
      if (!range) return new Response(bytes);
      const start = Number(a), end = Math.min(Number(b), bytes.length - 1);
      served += end - start + 1;
      return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` } });
    }) as typeof fetch;
    await tick({ ...deps, probeMode: "remote", fetchImpl }, opts, { lastMaintenance: Date.now() });
    expect(await row(m.id)).toMatchObject({ status: "ready", width: 1080, height: 1080 });
    expect(served).toBeLessThan(bytes.length);
  });
});
