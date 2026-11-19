import type pg from "pg";
import { handlePurge } from "./handlers/purge";
import { handleProbe } from "./handlers/probe";
import type { Handler, HandlerDeps } from "./handlers/types";
import { expireStaleUploads, processStorageGc } from "./maintenance";
import { claimJobs, completeJob, failJob, heartbeat, reapExpiredLeases, type MediaJob } from "./queue";

const HANDLERS: Record<MediaJob["kind"], Handler> = { probe: handleProbe, purge: handlePurge };

export type WorkerOptions = {
  workerId: string;
  concurrency: number;
  leaseSeconds: number;
  pollMs: number;
  maintenanceEveryMs?: number;
};

/** Processa um job com heartbeat; nunca lança (falhas viram retry/failed). */
export async function runJob(job: MediaJob, deps: HandlerDeps, opts: Pick<WorkerOptions, "workerId" | "leaseSeconds">) {
  const log = deps.log;
  const beat = setInterval(() => {
    heartbeat(deps.db, job.id, opts.workerId, opts.leaseSeconds).catch((e) => log.warn("heartbeat failed", { job_id: job.id, error: String(e) }));
  }, Math.max(1000, (opts.leaseSeconds * 1000) / 3));
  try {
    await HANDLERS[job.kind](job, deps, { isFinalAttempt: job.attempts >= job.max_attempts });
    await completeJob(deps.db, job.id, opts.workerId);
  } catch (err) {
    const final = await failJob(deps.db, job, opts.workerId, err instanceof Error ? err.message : String(err));
    log[final ? "error" : "warn"]("job failed", { job_id: job.id, kind: job.kind, attempt: job.attempts, final, error: String(err) });
  } finally {
    clearInterval(beat);
  }
}

/** Um ciclo: manutenção (se devida) + reivindicar e processar jobs. Retorna quantos jobs processou. */
export async function tick(deps: HandlerDeps, opts: WorkerOptions, state: { lastMaintenance: number }): Promise<number> {
  const now = Date.now();
  if (now - state.lastMaintenance >= (opts.maintenanceEveryMs ?? 60_000)) {
    state.lastMaintenance = now;
    await reapExpiredLeases(deps.db);
    await expireStaleUploads(deps.db, deps.storage, deps.log);
    await processStorageGc(deps.db, deps.storage, deps.log);
  }
  const jobs = await claimJobs(deps.db, opts.workerId, opts.concurrency, opts.leaseSeconds);
  await Promise.all(jobs.map((j) => runJob(j, deps, opts)));
  return jobs.length;
}

/** Loop principal com parada graciosa: termina os jobs em andamento antes de sair. */
export async function runLoop(deps: HandlerDeps & { db: pg.Pool }, opts: WorkerOptions, signal: AbortSignal) {
  const state = { lastMaintenance: 0 };
  while (!signal.aborted) {
    let processed = 0;
    try {
      processed = await tick(deps, opts, state);
    } catch (err) {
      deps.log.error("tick failed", { error: String(err) });
    }
    if (processed === 0 && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, opts.pollMs);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
    }
  }
}
