import type pg from "pg";

export type MediaJob = {
  id: string;
  workspace_id: string;
  media_asset_id: string | null;
  kind: "probe" | "purge";
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

/**
 * Reivindica até `limit` jobs prontos. `FOR UPDATE SKIP LOCKED` garante que
 * workers concorrentes nunca peguem o mesmo job; o lease define até quando o
 * job é nosso sem heartbeat.
 */
export async function claimJobs(db: pg.Pool, workerId: string, limit: number, leaseSeconds: number): Promise<MediaJob[]> {
  const { rows } = await db.query<MediaJob>(
    `update public.media_jobs j
        set status = 'running', lease_owner = $1, lease_expires_at = now() + make_interval(secs => $3),
            attempts = j.attempts + 1
      where j.id in (
        select id from public.media_jobs
         where status = 'queued' and run_after <= now()
         order by run_after, id
         for update skip locked
         limit $2)
     returning j.id::text, j.workspace_id, j.media_asset_id, j.kind, j.payload, j.attempts, j.max_attempts`,
    [workerId, limit, leaseSeconds],
  );
  return rows;
}

/** Estende o lease; retorna false se o job não é mais nosso (ex.: reaper o devolveu). */
export async function heartbeat(db: pg.Pool, jobId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
  const r = await db.query(
    `update public.media_jobs set lease_expires_at = now() + make_interval(secs => $3)
      where id = $1 and lease_owner = $2 and status = 'running'`,
    [jobId, workerId, leaseSeconds],
  );
  return r.rowCount === 1;
}

export async function completeJob(db: pg.Pool, jobId: string, workerId: string): Promise<void> {
  await db.query(
    `update public.media_jobs set status = 'succeeded', lease_owner = null, lease_expires_at = null, last_error = null
      where id = $1 and lease_owner = $2`,
    [jobId, workerId],
  );
}

/** Backoff exponencial com jitter: 30s, 60s, 120s… limitado a 1h. */
export function backoffSeconds(attempt: number, random = Math.random): number {
  const base = Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}

/** Falha: reagenda com backoff ou encerra como `failed` ao esgotar tentativas. Retorna true se foi a falha final. */
export async function failJob(db: pg.Pool, job: MediaJob, workerId: string, error: string): Promise<boolean> {
  const final = job.attempts >= job.max_attempts;
  await db.query(
    `update public.media_jobs
        set status = $3, lease_owner = null, lease_expires_at = null, last_error = left($4, 1000),
            run_after = case when $3 = 'queued' then now() + make_interval(secs => $5) else run_after end
      where id = $1 and lease_owner = $2`,
    [job.id, workerId, final ? "failed" : "queued", error, backoffSeconds(job.attempts)],
  );
  return final;
}

/**
 * Devolve à fila jobs cujo lease expirou (worker morto/travado). Os handlers
 * de mídia são idempotentes, então reexecutar é seguro.
 */
export async function reapExpiredLeases(db: pg.Pool): Promise<number> {
  const r = await db.query(
    `update public.media_jobs
        set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
            last_error = coalesce(last_error, '') || case when last_error is null then '' else ' | ' end || 'lease expired',
            lease_owner = null, lease_expires_at = null
      where status = 'running' and lease_expires_at < now()`,
  );
  return r.rowCount ?? 0;
}
