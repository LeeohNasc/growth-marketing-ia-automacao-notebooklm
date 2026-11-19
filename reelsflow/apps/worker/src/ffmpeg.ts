import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type FfmpegPaths = { ffprobe: string; ffmpeg: string };

/** ffprobe com timeout e limite de saída; o arquivo nunca é executado, só lido. */
export async function ffprobeJson(paths: FfmpegPaths, file: string): Promise<unknown> {
  const { stdout } = await run(paths.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], {
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

/** Gera thumbnail JPEG (largura 480) a partir de ~10% do vídeo, no máximo 1s. */
export async function makeThumbnail(paths: FfmpegPaths, file: string, out: string, durationMs: number): Promise<void> {
  const seek = Math.max(0, Math.min(1, (durationMs / 1000) * 0.1));
  await run(
    paths.ffmpeg,
    ["-v", "error", "-y", "-ss", seek.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", out],
    { timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
}
