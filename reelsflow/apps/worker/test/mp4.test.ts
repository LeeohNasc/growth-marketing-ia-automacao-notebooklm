import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProbeError, parseFfprobe } from "@reelsflow/domain";
import { afterAll, describe, expect, it } from "vitest";
import { bufferReader, httpRangeReader, probeMp4 } from "../src/media/mp4";

const dir = mkdtempSync(path.join(os.tmpdir(), "rf-mp4-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function make(name: string, args: string[]) {
  const out = path.join(dir, name);
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args, out]);
  return out;
}
const ffprobe = (file: string) =>
  parseFfprobe(JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]).toString()));
const probe = (file: string) => probeMp4(bufferReader(new Uint8Array(readFileSync(file))));

const src = ["-f", "lavfi", "-i", "testsrc=size=360x640:rate=30", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "4", "-pix_fmt", "yuv420p"];

describe("probeMp4 × ffprobe (arquivos reais)", () => {
  const cases: [string, string[]][] = [
    ["faststart.mp4", [...src, "-c:v", "libx264", "-c:a", "aac", "-shortest", "-movflags", "+faststart"]],
    ["moov-no-fim.mp4", [...src, "-c:v", "libx264", "-c:a", "aac", "-shortest"]],
    ["sem-audio.mov", ["-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=30000/1001", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p"]],
    ["hevc.mp4", ["-f", "lavfi", "-i", "testsrc=size=720x1280:rate=25", "-t", "3", "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p"]],
  ];
  for (const [name, args] of cases) {
    it(name, async () => {
      const file = make(name, args);
      const mine = await probe(file);
      const ref = ffprobe(file);
      expect({ w: mine.width, h: mine.height, v: mine.videoCodec, a: mine.audioCodec, au: mine.hasAudio }).toEqual({
        w: ref.width,
        h: ref.height,
        v: ref.videoCodec,
        a: ref.audioCodec,
        au: ref.hasAudio,
      });
      expect(Math.abs(mine.durationMs - ref.durationMs)).toBeLessThan(100);
      expect(Math.abs((mine.fps ?? 0) - (ref.fps ?? 0))).toBeLessThan(0.05);
    });
  }

  it("rotação de 90° troca as dimensões de exibição", async () => {
    const base = make("base.mp4", ["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
    const rotated = path.join(dir, "rot.mov");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-display_rotation", "90", "-i", base, "-c", "copy", rotated]);
    const mine = await probe(rotated);
    const ref = ffprobe(rotated);
    expect(mine.rotation % 180).toBe(90);
    expect([mine.width, mine.height]).toEqual([ref.width, ref.height]);
  });

  it("áudio sem vídeo e arquivo que não é mídia são recusados", async () => {
    const audio = make("audio.m4a", ["-f", "lavfi", "-i", "sine", "-t", "2", "-c:a", "aac"]);
    await expect(probe(audio)).rejects.toMatchObject({ code: "no_video_stream" });
    const junk = path.join(dir, "junk.mp4");
    writeFileSync(junk, "isto não é um vídeo, só texto qualquer com mais de dezesseis bytes");
    await expect(probe(junk)).rejects.toBeInstanceOf(ProbeError);
  });

  it("lê só o índice por faixas HTTP (não baixa o vídeo inteiro)", async () => {
    const file = make("grande.mp4", ["-f", "lavfi", "-i", "testsrc=size=720x1280:rate=30", "-t", "20", "-c:v", "libx264", "-b:v", "4M", "-pix_fmt", "yuv420p"]);
    const bytes = new Uint8Array(readFileSync(file));
    let transferred = 0;
    const fakeFetch: typeof fetch = async (_url, init) => {
      const m = String((init?.headers as Record<string, string>).Range).match(/bytes=(\d+)-(\d+)/)!;
      const [a, b] = [Number(m[1]), Math.min(Number(m[2]), bytes.byteLength - 1)];
      transferred += b - a + 1;
      return new Response(bytes.slice(a, b + 1), { status: 206, headers: { "content-range": `bytes ${a}-${b}/${bytes.byteLength}` } });
    };
    const res = await probeMp4(await httpRangeReader("https://storage.test/v.mp4", fakeFetch));
    expect(res).toMatchObject({ width: 720, height: 1280, videoCodec: "h264" });
    expect(transferred).toBeLessThan(bytes.byteLength / 10);
  });
});
