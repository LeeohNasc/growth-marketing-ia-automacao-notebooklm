import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { expect, test, type Page } from "@playwright/test";
import type { CardContent, CardLayout } from "@reelsflow/domain";

/**
 * Prova de que o ARQUIVO FINAL contém avatar, nome, @, manchete e mídia (não só a prévia):
 * gera PNG/JPEG/MP4 reais com o renderizador do app e os inspeciona por pixel e com ffprobe.
 */
const OUT = path.join(__dirname, "samples");
mkdirSync(OUT, { recursive: true });
const FX = "/fixtures";

type Rect = { x: number; y: number; w: number; h: number };
type RF = {
  layout(c: unknown): Promise<CardLayout>;
  image(c: unknown, t?: string): Promise<{ data?: string; error?: string; message?: string }>;
  video(c: unknown, src: string): Promise<{ data?: string; error?: string; message?: string; durationS?: number; hasAudio?: boolean }>;
  previewPng(c: unknown, showSafeArea: boolean): Promise<{ data: string }>;
  previewVsExport(c: unknown): Promise<{ width: number; height: number; exportW: number; exportH: number; maxDiff: number; differing: number }>;
  stats(d: string, t: string, r: Rect): Promise<{ w: number; h: number; nonWhite: number; dark: number; colored: number }>;
  diff(a: string, at: string, b: string, bt: string, r: Rect): Promise<number>;
};
const rf = <K extends keyof RF>(page: Page, fn: K, ...args: Parameters<RF[K]>) =>
  page.evaluate(([f, a]) => (window as unknown as { rf: Record<string, (...x: unknown[]) => unknown> }).rf[f as string]!(...(a as unknown[])), [fn, args] as const) as ReturnType<RF[K]>;

const content = (over: Partial<CardContent> = {}): CardContent => ({
  format: "feed",
  pageName: "Pipocou",
  username: "pipocoumemes",
  headline: "🚨 VEJA | Câmara aprova projeto e votação vira assunto nas redes; ação começa já",
  mediaKind: "image",
  fit: "cover",
  ...over,
});
const save = (name: string, b64: string) => {
  const f = path.join(OUT, name);
  writeFileSync(f, Buffer.from(b64, "base64"));
  return f;
};
const ffprobe = (f: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", f]).toString());
/** Região do texto do cabeçalho (nome + @ + manchete) e do avatar. */
const textRect = (l: CardLayout): Rect => ({ x: l.name.x, y: l.avatar.y, w: l.width - l.name.x - 48 * l.u, h: l.media.y - l.avatar.y - 10 });
const inner = (r: Rect, pad = 12): Rect => ({ x: r.x + pad, y: r.y + pad, w: r.w - 2 * pad, h: r.h - 2 * pad });

test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForSelector("body[data-ready='1']", { state: "attached" });
});

test.describe("imagem — três formatos", () => {
  for (const format of ["feed", "square", "vertical"] as const) {
    test(`${format}: dimensões exatas; avatar, nome/@, manchete e foto DENTRO do arquivo`, async ({ page }) => {
      const cfg = { content: content({ format }), avatar: `${FX}/avatar.png`, media: [`${FX}/photo1.jpg`], style: { bottomPadding: 64 } };
      const r = await rf(page, "image", cfg, "image/png");
      expect(r.error, r.message).toBeUndefined();
      save(`card-${format}.png`, r.data!);
      const l = await rf(page, "layout", cfg);
      const dims = { feed: [1080, 1350], square: [1080, 1080], vertical: [1080, 1920] }[format];
      const avatar = await rf(page, "stats", r.data!, "image/png", inner(l.avatar, l.avatar.w * 0.2));
      expect([avatar.w, avatar.h]).toEqual(dims);
      expect(avatar.colored).toBeGreaterThan(0.9); // avatar (vermelho/amarelo) presente
      const text = await rf(page, "stats", r.data!, "image/png", textRect(l));
      expect(text.dark).toBeGreaterThan(0.02); // texto preto (nome, manchete)
      const media = await rf(page, "stats", r.data!, "image/png", inner(l.media));
      expect(media.colored).toBeGreaterThan(0.3); // foto presente
      const bottom = await rf(page, "stats", r.data!, "image/png", { x: 0, y: l.media.y + l.media.h + 2, w: l.width, h: Math.max(4, l.height - l.media.y - l.media.h - 4) });
      expect(bottom.nonWhite).toBeLessThan(0.01); // respiro branco, sem barras
      // JPEG para publicação também sai na resolução exata
      const j = await rf(page, "image", cfg, "image/jpeg");
      const jf = save(`card-${format}.jpg`, j.data!);
      const s = ffprobe(jf).streams[0];
      expect([s.codec_name, s.width, s.height]).toEqual(["mjpeg", dims[0], dims[1]]);
    });
  }

  test("prévia do editor == arquivo exportado (pixel a pixel)", async ({ page }) => {
    for (const format of ["feed", "square", "vertical"] as const) {
      const cmp = await rf(page, "previewVsExport", { content: content({ format }), avatar: `${FX}/avatar.png`, media: [`${FX}/photo1.jpg`] });
      expect([cmp.width, cmp.height]).toEqual([cmp.exportW, cmp.exportH]);
      expect(cmp.maxDiff, `${format}: ${cmp.differing} valores diferentes em ${JSON.stringify((cmp as { bbox?: unknown }).bbox)}`).toBe(0);
    }
  });
});

test("duas imagens lado a lado: ambas no arquivo, divisória branca, recorte proporcional", async ({ page }) => {
  const cfg = { content: content({ mediaKind: "image_pair" }), avatar: `${FX}/avatar.png`, media: [`${FX}/photo1.jpg`, `${FX}/photo2.jpg`] };
  const r = await rf(page, "image", cfg);
  expect(r.error, r.message).toBeUndefined();
  save("card-pair.png", r.data!);
  const l = await rf(page, "layout", cfg);
  for (const slot of l.slots) expect((await rf(page, "stats", r.data!, "image/png", inner(slot))).colored).toBeGreaterThan(0.3);
  const div = await rf(page, "stats", r.data!, "image/png", { x: l.divider!.x + 1, y: l.divider!.y + 10, w: Math.max(1, l.divider!.w - 2), h: l.divider!.h - 20 });
  expect(div.nonWhite).toBeLessThan(0.02);
  // falta a 2ª imagem → não exporta
  expect((await rf(page, "image", { ...cfg, media: [`${FX}/photo1.jpg`, null] })).error).toBe("media_missing");
});

test("nome/@ longos, emoji e acentos; overflow bloqueia (sem truncar) e redução explícita resolve", async ({ page }) => {
  const long = content({ pageName: "Portal Nacional de Notícias e Entretenimento do Brasil", username: "portal_nacional_noticias_br", headline: "😂🔥 É ação! Ônibus, pão e coração 💥" });
  const r = await rf(page, "image", { content: long, avatar: `${FX}/avatar.png`, media: [`${FX}/photo1.jpg`] });
  expect(r.error, r.message).toBeUndefined();
  save("card-long-emoji.png", r.data!);
  const l = await rf(page, "layout", { content: long });
  expect(l.username.y).toBeGreaterThan(l.name.y); // @ desceu, sem sobrepor
  expect(l.headline.lines[0]!.y - l.headline.lineHeight).toBeGreaterThanOrEqual(l.username.y);
  // emoji colorido renderizado na linha da manchete
  const h = l.headline.lines[0]!;
  const hl = await rf(page, "stats", r.data!, "image/png", { x: h.x, y: h.y - l.headline.lineHeight * 0.9, w: 140 * l.u, h: l.headline.lineHeight });
  expect(hl.colored).toBeGreaterThan(0.05);

  const huge = content({ format: "square", headline: Array.from({ length: 11 }, () => "Linha longa de manchete").join("\n") });
  const blocked = await rf(page, "image", { content: huge, media: [`${FX}/photo1.jpg`] });
  expect(blocked.error).toBe("blocked");
  expect(blocked.message).toContain("reduza a fonte");
  const reduced = await rf(page, "image", { content: huge, media: [`${FX}/photo1.jpg`], style: { headlineScale: 0.7 } });
  expect(reduced.error).toBeUndefined();
});

test("marca-d'água do próprio usuário (@ e logo) aparece no respiro", async ({ page }) => {
  for (const kind of ["username", "logo"] as const) {
    const cfg = { content: content(), media: [`${FX}/photo1.jpg`], logo: `${FX}/logo.png`, style: { bottomPadding: 120, watermark: { kind, position: "bottom-right", opacity: 0.9 } } };
    const r = await rf(page, "image", cfg);
    save(`card-watermark-${kind}.png`, r.data!);
    const l = await rf(page, "layout", cfg);
    const w = l.watermarkAnchor!;
    const s = await rf(page, "stats", r.data!, "image/png", { x: w.x - 400, y: w.y - w.size, w: 400, h: w.size * 2 });
    expect(s.nonWhite).toBeGreaterThan(0.01);
  }
});

test.describe("vídeo MP4", () => {
  test("H.264 yuv420p, 1080×1350, mesma duração, áudio AAC preservado, faststart; cabeçalho estático e mídia em movimento", async ({ page }) => {
    const cfg = { content: content({ mediaKind: "video" }), avatar: `${FX}/avatar.png`, style: { bottomPadding: 64 } };
    const r = await rf(page, "video", cfg, `${FX}/source.mp4`);
    expect(r.error, r.message).toBeUndefined();
    expect(r.hasAudio).toBe(true);
    const file = save("card-video-feed.mp4", r.data!);
    const info = ffprobe(file);
    const v = info.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    const a = info.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
    expect([v.codec_name, v.pix_fmt, v.width, v.height]).toEqual(["h264", "yuv420p", 1080, 1350]);
    expect(a).toBeTruthy();
    expect([a.codec_name, a.sample_rate, a.channels]).toEqual(["aac", "48000", 2]);
    const src = ffprobe(path.join(__dirname, "site", "fixtures", "source.mp4"));
    expect(Math.abs(Number(info.format.duration) - Number(src.format.duration))).toBeLessThan(0.1);
    expect(Math.abs(Number(v.duration) - Number(a.duration))).toBeLessThan(0.1); // sincronia
    // faststart: 'moov' antes de 'mdat'
    const bytes = readFileSync(file);
    expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));

    // Quadros reais do MP4: cabeçalho (avatar+texto) igual ao PNG do mesmo card; mídia muda no tempo.
    const frame = (t: number) => {
      const f = path.join(OUT, `frame-${t}.png`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", file, "-frames:v", "1", f]);
      return readFileSync(f).toString("base64");
    };
    const f1 = frame(0.5);
    const f2 = frame(3);
    const l = await rf(page, "layout", cfg);
    const still = await rf(page, "image", { ...cfg, content: content({ mediaKind: "image" }), media: [`${FX}/photo1.jpg`] });
    const header: Rect = { x: 0, y: 0, w: l.width, h: l.media.y - 4 };
    expect(await rf(page, "diff", f1, "image/png", still.data!, "image/png", header)).toBeLessThan(4);
    expect(await rf(page, "diff", f1, "image/png", f2, "image/png", header)).toBeLessThan(2);
    expect(await rf(page, "diff", f1, "image/png", f2, "image/png", inner(l.media, 40))).toBeGreaterThan(3);
    expect((await rf(page, "stats", f1, "image/png", inner(l.avatar, l.avatar.w * 0.2))).colored).toBeGreaterThan(0.85);
    expect((await rf(page, "stats", f1, "image/png", textRect(l))).dark).toBeGreaterThan(0.02);
  });

  test("9:16 com 'mostrar tudo' e vídeo sem áudio: arquivo válido, sem faixa de áudio inventada", async ({ page }) => {
    const r = await rf(page, "video", { content: content({ format: "vertical", mediaKind: "video", fit: "contain" }) }, `${FX}/vertical-noaudio.mp4`);
    expect(r.error, r.message).toBeUndefined();
    expect(r.hasAudio).toBe(false);
    const info = ffprobe(save("card-video-vertical.mp4", r.data!));
    const v = info.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    expect([v.codec_name, v.pix_fmt, v.width, v.height]).toEqual(["h264", "yuv420p", 1080, 1920]);
    expect(info.streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(false);
    expect(Math.abs(Number(info.format.duration) - 3)).toBeLessThan(0.1);
  });

  test("arquivo corrompido e codec não decodificável: erro claro, nada é gerado", async ({ page }) => {
    const bad = await rf(page, "video", { content: content({ mediaKind: "video" }) }, `${FX}/corrupt.mp4`);
    expect(bad.data).toBeUndefined();
    expect(["no_video", "invalid_conversion", "encode_failed"]).toContain(bad.error);
    const hevc = await rf(page, "video", { content: content({ mediaKind: "video" }) }, `${FX}/hevc.mov`);
    // Navegadores sem decodificador HEVC (ex.: Chromium no Linux) recusam com mensagem acionável.
    if (hevc.error) expect(hevc.error).toBe("video_codec");
    else expect(hevc.data).toBeTruthy();
  });

  test("imagem corrompida: erro claro", async ({ page }) => {
    const r = await rf(page, "image", { content: content(), media: [`${FX}/corrupt.mp4`] });
    expect(r.error).toBe("image_decode");
  });
});

test.describe("vertical v2 — área segura dos Reels", () => {
  const v2 = (over: Partial<CardContent> = {}) =>
    content({ format: "vertical", mediaKind: "video", pageName: "🍿 Pipocou | Humor e Memes", headline: "EU NA REUNIÃO DE SEGUNDA:", templateVersion: 2, ...over });
  const style = { watermark: { kind: "username", position: "bottom-right", opacity: 0.9 }, badge: { enabled: true } };

  test("prévia == arquivo final (com selo e marca-d'água) e a simulação do Instagram NÃO vai para o arquivo", async ({ page }) => {
    const cfg = { content: v2({ mediaKind: "image" }), avatar: `${FX}/avatar.png`, media: [`${FX}/photo1.jpg`], style };
    const cmp = await rf(page, "previewVsExport", cfg);
    expect(cmp.maxDiff).toBe(0);
    const exp = await rf(page, "image", cfg);
    const plain = await rf(page, "previewPng", cfg, false);
    const overlay = await rf(page, "previewPng", cfg, true);
    save("v2-preview-overlay.png", overlay.data);
    const full = { x: 0, y: 0, w: 1080, h: 1920 };
    expect(await rf(page, "diff", plain.data, "image/png", exp.data!, "image/png", full)).toBe(0);
    expect(await rf(page, "diff", overlay.data, "image/png", exp.data!, "image/png", full)).toBeGreaterThan(0);
  });

  test("vídeo 9:16: avatar, nome, selo, @ e marca-d'água dentro da área segura e visíveis no MP4", async ({ page }) => {
    const cfg = { content: v2(), avatar: `${FX}/avatar.png`, style };
    const r = await rf(page, "video", cfg, `${FX}/vertical-noaudio.mp4`);
    expect(r.error, r.message).toBeUndefined();
    const f = save("v2-reels.mp4", r.data!);
    const v = ffprobe(f).streams.find((s: { codec_type: string }) => s.codec_type === "video");
    expect([v.width, v.height]).toEqual([1080, 1920]);
    const frame = path.join(OUT, "v2-reels-frame.png");
    execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", "0.5", "-i", f, "-frames:v", "1", frame]);
    const png = readFileSync(frame).toString("base64");
    const l = await rf(page, "layout", cfg);
    const S = { x0: 120, y0: 285, x1: 960, y1: 1520 };
    const within = (r: Rect) => r.x >= S.x0 && r.x + r.w <= S.x1 && r.y >= S.y0 && r.y + r.h <= S.y1;
    expect(within(l.avatar)).toBe(true);
    expect(within(l.badge!)).toBe(true);
    for (const r of [l.avatar, l.badge!]) expect((await rf(page, "stats", png, "image/png", inner(r, 4))).nonWhite).toBeGreaterThan(0.3);
    const w = l.watermarkAnchor!;
    expect(w.x).toBeLessThanOrEqual(1080 - 220);
    expect(w.y + w.size).toBeLessThanOrEqual(1920 - 400);
    expect((await rf(page, "stats", png, "image/png", { x: w.x - 300, y: w.y - w.size / 2, w: 300, h: w.size })).nonWhite).toBeGreaterThan(0.01);
  });
});
