import type pg from "pg";
import type { ConnectorRegistry } from "@reelsflow/connectors";
import { appendFromCollections, completeCampaigns, lowContentAlerts } from "./publishing/automations";
import { executePublication, reconcileUncertain } from "./publishing/execute";
import { claimPublications, promoteDue, reapPublicationLeases } from "./publishing/scheduler";
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
  reconcileMinAgeSeconds?: number;
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

export type WorkerDeps = HandlerDeps & { connectors?: ConnectorRegistry };

/**
 * Um ciclo do worker:
 * 1. manutenção periódica (leases expirados, uploads abandonados, limpeza, automações);
 * 2. fila de mídia (análise/limpeza);
 * 3. publicações: promover vencidas → reivindicar → publicar; reconciliar incertas.
 * Retorna quantos itens processou.
 */
export async function tick(deps: WorkerDeps, opts: WorkerOptions, state: { lastMaintenance: number }): Promise<number> {
  const now = Date.now();
  if (now - state.lastMaintenance >= (opts.maintenanceEveryMs ?? 60_000)) {
    state.lastMaintenance = now;
    await reapExpiredLeases(deps.db);
    await reapPublicationLeases(deps.db);
    await expireStaleUploads(deps.db, deps.storage, deps.log);
    await processStorageGc(deps.db, deps.storage, deps.log);
    if (deps.connectors) {
      await appendFromCollections(deps.db, deps.log);
      await lowContentAlerts(deps.db);
      await completeCampaigns(deps.db);
    }
    await deps.db.query(
      `insert into public.worker_heartbeats (worker_id, kind, last_seen_at) values ($1, 'worker', now())
       on conflict (worker_id) do update set last_seen_at = now()`,
      [opts.workerId],
    );
  }
  const jobs = await claimJobs(deps.db, opts.workerId, opts.concurrency, opts.leaseSeconds);
  await Promise.all(jobs.map((j) => runJob(j, deps, opts)));
  let processed = jobs.length;

  if (deps.connectors) {
    const pub = { db: deps.db, connectors: deps.connectors, log: deps.log, workerId: opts.workerId, leaseSeconds: opts.leaseSeconds };
    await promoteDue(deps.db);
    const claimed = await claimPublications(deps.db, opts.workerId, opts.concurrency, opts.leaseSeconds);
    await Promise.all(claimed.map((c) => executePublication(c, pub)));
    processed += claimed.length;
    processed += await reconcileUncertain(pub, 20, opts.reconcileMinAgeSeconds ?? 30);
  }
  return processed;
}

/** Loop principal com parada graciosa: termina os jobs em andamento antes de sair. */
export async function runLoop(deps: WorkerDeps & { db: pg.Pool }, opts: WorkerOptions, signal: AbortSignal) {
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
