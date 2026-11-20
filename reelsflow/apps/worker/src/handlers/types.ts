import type { Db } from "../db";
import type { FfmpegPaths } from "../ffmpeg";
import type { Logger } from "../log";
import type { MediaJob } from "../queue";
import type { StorageAdapter } from "../storage";

export type HandlerDeps = {
  db: Db;
  storage: StorageAdapter;
  ffmpeg: FfmpegPaths;
  tmpDir: string;
  log: Logger;
  /**
   * "ffmpeg" (padrão): baixa o vídeo, ffprobe + miniatura com ffmpeg.
   * "remote": lê só o índice do MP4/MOV por faixas HTTP e usa a miniatura
   * gerada no navegador durante o upload (Edge Function, sem binários).
   */
  probeMode?: "ffmpeg" | "remote";
  fetchImpl?: typeof fetch;
};

export type Handler = (job: MediaJob, deps: HandlerDeps, ctx: { isFinalAttempt: boolean }) => Promise<void>;
