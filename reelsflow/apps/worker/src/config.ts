import os from "node:os";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  WORKER_ID: z.string().default(`${os.hostname()}-${process.pid}`),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  WORKER_POLL_MS: z.coerce.number().int().min(250).default(2000),
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(30).default(300),
  FFPROBE_PATH: z.string().default("ffprobe"),
  FFMPEG_PATH: z.string().default("ffmpeg"),
  WORKER_TMP_DIR: z.string().default(os.tmpdir()),
});

export type WorkerConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Configuração do worker inválida: ${missing}`);
  }
  return parsed.data;
}
