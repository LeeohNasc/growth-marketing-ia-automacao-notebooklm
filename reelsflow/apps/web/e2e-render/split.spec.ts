import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * Tela Dividida — renderização REAL no Chromium (WebCodecs) com vídeos reais gerados pelo ffmpeg.
 * Confere o arquivo final com ffprobe (codec, tamanho, fps, duração, áudio), por pixel (posição de
 * cada vídeo) e pela energia em cada frequência do áudio (qual faixa entrou: 440 Hz = superior, 880 Hz = inferior).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "test-results", "split-samples");
mkdirSync(OUT, { recursive: true });
const FX = "/fixtures";
const save = (name: string, b64: string) => {
  const f = path.join(OUT, name);
  writeFileSync(f, Buffer.from(b64, "base64"));
  return f;
};
const ffprobe = (f: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", f]).toString());
/** Cor média de um bloco 20×20 no quadro do instante t. */
function pixel(f: string, t: number, x: number, y: number): [number, number, number] {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", f, "-frames:v", "1", "-vf", `crop=20:20:${x - 10}:${y - 10}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const sum = [0, 0, 0];
  for (let i = 0; i < raw.length; i += 3) for (let c = 0; c < 3; c++) sum[c]! += raw[i + c]!;
  const n = raw.length / 3;
  return sum.map((v) => Math.round(v / n)) as [number, number, number];
}
/** Energia (dB) numa frequência: filtro passa-banda estreito + volumedetect. */
function band(f: string, hz: number): number {
  const r = spawnSync("ffmpeg", ["-nostats", "-ss", "1", "-t", "2", "-i", f, "-af", `bandpass=f=${hz}:width_type=q:w=30,volumedetect`, "-f", "null", "-"], { encoding: "utf8" });
  return Number(/mean_volume: (-?[\d.]+)/.exec(r.stderr)?.[1] ?? -99);
}
type Stream = { codec_type: string; [k: string]: unknown };
type RFWin = { rf: { split: (...a: unknown[]) => Promise<unknown>; splitProbe: (u: string) => Promise<{ error?: string }>; canMixAudio: () => Promise<boolean> } };
const streams = (f: string) => ffprobe(f).streams as Stream[];
const near = (a: number[], b: number[], tol = 40) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const RED = [214, 40, 40], BLUE = [29, 78, 216], GREEN = [21, 128, 61];

async function render(page: Page, cfg: unknown, top: string, bottom: string) {
  return page.evaluate(([c, t, b]) => (window as unknown as RFWin).rf.split(c, t, b), [cfg, `${FX}/${top}`, `${FX}/${bottom}`] as const) as Promise<{
    data?: string; thumb?: string | null; durationS?: number; hasAudio?: boolean; audioPath?: string; ms?: number; error?: string; message?: string;
  }>;
}

test.describe("Tela Dividida — arquivo final", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean((window as unknown as Partial<RFWin>).rf));
  });

  test("50/50 padrão: H.264 1080×1920 30 fps yuv420p, superior em cima, inferior embaixo, áudio do superior copiado", async ({ page }) => {
    const r = await render(page, {}, "split-top.mp4", "split-bottom.mp4");
    expect(r.error, r.message).toBeUndefined();
    expect(r.audioPath).toBe("copy");
    const f = save("split-50-50-audio-top.mp4", r.data!);
    if (r.thumb) save("split-50-50-thumb.jpg", r.thumb);
    const info = ffprobe(f);
    const v = (info.streams as Stream[]).find((s) => s.codec_type === "video");
    const a = (info.streams as Stream[]).find((s) => s.codec_type === "audio");
    expect(v).toMatchObject({ codec_name: "h264", width: 1080, height: 1920, pix_fmt: "yuv420p", r_frame_rate: "30/1" });
    expect(a).toMatchObject({ codec_name: "aac" });
    // duração = superior (principal) 6 s
    expect(Number(info.format.duration)).toBeGreaterThan(5.8);
    expect(Number(info.format.duration)).toBeLessThan(6.2);
    // posição: vermelho em cima, azul embaixo, sem faixa preta nas bordas de cada metade
    expect(near(pixel(f, 1, 540, 480), RED)).toBe(true);
    expect(near(pixel(f, 1, 540, 1440), BLUE)).toBe(true);
    expect(near(pixel(f, 1, 1060, 950), RED)).toBe(true);
    expect(near(pixel(f, 1, 20, 970), BLUE)).toBe(true);
    expect(band(f, 440)).toBeGreaterThan(-35); // tom do superior presente
    expect(band(f, 880)).toBeLessThan(-45); // tom do inferior ausente
  });

  test("60/40 e troca de posição: divisão em 1152 px; inferior fica em cima após a troca; áudio acompanha", async ({ page }) => {
    const r = await render(page, { ratio: "60/40", audio: { mode: "bottom", topVolume: 1, bottomVolume: 1 } }, "split-bottom.mp4", "split-top.mp4");
    expect(r.error, r.message).toBeUndefined();
    const f = save("split-60-40-swapped.mp4", r.data!);
    expect(near(pixel(f, 1, 540, 1130), BLUE)).toBe(true);
    expect(near(pixel(f, 1, 540, 1175), RED)).toBe(true);
    // áudio "inferior" (agora o vídeo vermelho, 440 Hz); o azul (880 Hz) não entra
    expect(band(f, 440)).toBeGreaterThan(-35);
    expect(band(f, 880)).toBeLessThan(-45);
    // duração: principal = superior (azul, 4 s)
    expect(Number(ffprobe(f).format.duration)).toBeLessThan(4.2);
  });

  test("durações diferentes: congela, repete ou termina no mais curto; trecho inicial respeitado", async ({ page }) => {
    const freeze = await render(page, { duration: "main", audio: { mode: "top" } }, "split-top.mp4", "split-bottom.mp4");
    const loop = await render(page, { duration: "loop_other", audio: { mode: "top" } }, "split-top.mp4", "split-bottom.mp4");
    const shortest = await render(page, { duration: "shortest", audio: { mode: "top" } }, "split-top.mp4", "split-bottom.mp4");
    const trimmed = await render(page, { top: { startS: 2, endS: 5 }, audio: { mode: "top" } }, "split-top.mp4", "split-bottom.mp4");
    for (const r of [freeze, loop, shortest, trimmed]) expect(r.error, r.message).toBeUndefined();
    const d = (r: { data?: string }, n: string) => Number(ffprobe(save(n, r.data!)).format.duration);
    expect(d(freeze, "split-dur-freeze.mp4")).toBeGreaterThan(5.8);
    expect(d(loop, "split-dur-loop.mp4")).toBeGreaterThan(5.8);
    expect(d(shortest, "split-dur-shortest.mp4")).toBeLessThan(4.2);
    const tr = d(trimmed, "split-dur-trim.mp4");
    expect(tr).toBeGreaterThan(2.8);
    expect(tr).toBeLessThan(3.2);
    // após 4 s o inferior continua azul (congelado ou repetindo) — nunca preto
    expect(near(pixel(path.join(OUT, "split-dur-freeze.mp4"), 5, 540, 1440), BLUE)).toBe(true);
    expect(near(pixel(path.join(OUT, "split-dur-loop.mp4"), 5, 540, 1440), BLUE)).toBe(true);
  });

  test("silenciar ambos: sem faixa de áudio; vídeo sem áudio escolhido como fonte: bloqueado com mensagem", async ({ page }) => {
    const mute = await render(page, { audio: { mode: "mute" } }, "split-top.mp4", "split-noaudio.mp4");
    expect(mute.error, mute.message).toBeUndefined();
    const info = ffprobe(save("split-mute.mp4", mute.data!));
    expect((info.streams as Stream[]).some((s) => s.codec_type === "audio")).toBe(false);
    const bad = await render(page, { audio: { mode: "bottom" } }, "split-top.mp4", "split-noaudio.mp4");
    expect(bad.error).toBe("blocked");
    expect(bad.message).toContain("inferior não tem áudio");
  });

  test("mistura com volumes e reamostragem 44,1 kHz mono: os dois tons presentes (ou erro claro se o navegador não gera AAC)", async ({ page }) => {
    const canMix = await page.evaluate(() => (window as unknown as RFWin).rf.canMixAudio());
    const r = await render(page, { audio: { mode: "mix", topVolume: 1, bottomVolume: 0.5 }, duration: "shortest" }, "split-top.mp4", "split-podcast-44k.mp4");
    test.info().annotations.push({ type: "aac-encoder", description: String(canMix) });
    if (!canMix) {
      expect(r.error).toBe("no_aac_encoder");
      expect(r.message).toContain("não gera áudio AAC");
      return;
    }
    expect(r.error, r.message).toBeUndefined();
    expect(r.audioPath).toBe("mixed");
    const f = save("split-mix.mp4", r.data!);
    const a = streams(f).find((s) => s.codec_type === "audio");
    expect(a).toMatchObject({ codec_name: "aac", sample_rate: "48000", channels: 2 });
    // 440 Hz (superior, 100%) e 660 Hz (podcast 44,1 kHz reamostrado, 50%) presentes; 880 Hz não existe
    const [a440, a660] = [band(f, 440), band(f, 660)];
    expect(a440).toBeGreaterThan(-35);
    expect(a660).toBeGreaterThan(-35);
    expect(a660).toBeLessThan(a440); // volume menor no inferior
    expect(band(f, 880)).toBeLessThan(-45);
    expect(near(pixel(f, 1, 540, 1440), GREEN)).toBe(true);
  });

  test("origem inválida: corrompido e HEVC não decodificável dão erro claro", async ({ page }) => {
    const bad = await page.evaluate(() => (window as unknown as RFWin).rf.splitProbe("/fixtures/corrupt.mp4"));
    expect(bad.error).toBe("no_video");
    const r = await render(page, {}, "split-top.mp4", "corrupt.mp4");
    expect(r.error).toBe("no_video");
  });
});
