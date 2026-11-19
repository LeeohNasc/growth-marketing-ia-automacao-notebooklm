import pg from "pg";
import { ConnectorRegistry, MockConnector } from "@reelsflow/connectors";
import { PgMockStore } from "./publishing/store";
import { loadConfig } from "./config";
import { createLogger } from "./log";
import { SupabaseStorage } from "./storage";
import { runLoop } from "./worker";

const config = loadConfig();
const log = createLogger({ service: "reelsflow-worker", worker_id: config.WORKER_ID });
const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: config.WORKER_CONCURRENCY + 2 });
const storage = new SupabaseStorage(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
const controller = new AbortController();
// Fase 3: apenas o conector simulado. Conectores reais entram na Fase 4.
const connectors = new ConnectorRegistry().register(new MockConnector(new PgMockStore(db)));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("shutdown requested", { signal: sig });
    controller.abort();
  });
}

log.info("worker started", { concurrency: config.WORKER_CONCURRENCY });
await runLoop(
  { db, storage, log, connectors, ffmpeg: { ffprobe: config.FFPROBE_PATH, ffmpeg: config.FFMPEG_PATH }, tmpDir: config.WORKER_TMP_DIR },
  { workerId: config.WORKER_ID, concurrency: config.WORKER_CONCURRENCY, leaseSeconds: config.WORKER_LEASE_SECONDS, pollMs: config.WORKER_POLL_MS },
  controller.signal,
);
await db.end();
log.info("worker stopped");
