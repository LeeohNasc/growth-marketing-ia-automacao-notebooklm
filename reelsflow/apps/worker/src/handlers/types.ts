import type pg from "pg";
import type { FfmpegPaths } from "../ffmpeg";
import type { Logger } from "../log";
import type { MediaJob } from "../queue";
import type { StorageAdapter } from "../storage";

export type HandlerDeps = {
  db: pg.Pool;
  storage: StorageAdapter;
  ffmpeg: FfmpegPaths;
  tmpDir: string;
  log: Logger;
};

export type Handler = (job: MediaJob, deps: HandlerDeps, ctx: { isFinalAttempt: boolean }) => Promise<void>;
