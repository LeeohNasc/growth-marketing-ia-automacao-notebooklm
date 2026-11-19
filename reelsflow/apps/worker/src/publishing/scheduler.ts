import type pg from "pg";
import { notify } from "./rules";

/**
 * Promove publicações vencidas para a fila e aplica a política de atraso:
 * se a publicação passou do horário além de `max_lateness_minutes` da
 * campanha (ex.: worker parado), vai para revisão em vez de sair em rajada.
 */
export async function promoteDue(db: pg.Pool, prepLeadSeconds = 0): Promise<{ promoted: number; late: number }> {
  const late = await db.query<{ id: string; workspace_id: string; created_by: string | null; campaign_name: string }>(
    `update public.publication_jobs j
        set status = 'needs_review', review_reason = 'late'
       from public.campaigns c
      where j.campaign_id = c.id and j.status in ('scheduled', 'queued')
        and c.status = 'active'
        and j.scheduled_at < now() - make_interval(mins => c.max_lateness_minutes)
     returning j.id, j.workspace_id, c.created_by, c.name as campaign_name`,
  );
  for (const r of late.rows) {
    await notify(db, r.workspace_id, [r.created_by], "publication.late", { job_id: r.id, campaign: r.campaign_name });
  }

  const promoted = await db.query(
    `update public.publication_jobs j
        set status = 'queued', next_attempt_at = greatest(j.scheduled_at, now())
       from public.campaigns c, public.workspaces w, public.social_accounts a
      where j.campaign_id = c.id and w.id = j.workspace_id and a.id = j.social_account_id
        and j.status = 'scheduled'
        and j.scheduled_at <= now() + make_interval(secs => $1)
        and c.status = 'active' and not w.queue_paused and a.status = 'active' and not a.paused`,
    [prepLeadSeconds],
  );
  return { promoted: promoted.rowCount ?? 0, late: late.rowCount ?? 0 };
}

export type ClaimedPublication = {
  id: string;
  workspace_id: string;
  campaign_id: string | null;
  social_account_id: string;
  media_asset_id: string | null;
  attempt_count: number;
  max_attempts: number;
  external_checkpoint: Record<string, unknown> | null;
};

/**
 * Reivindica publicações prontas. Regras:
 * - no máximo UMA em andamento por conta (também garantido por índice único);
 * - respeita o espaçamento mínimo da conta desde a última publicada;
 * - ignora contas pausadas/sem autorização, campanhas pausadas e fila pausada;
 * - SKIP LOCKED: workers concorrentes nunca pegam a mesma publicação.
 */
export async function claimPublications(db: pg.Pool, workerId: string, limit: number, leaseSeconds: number): Promise<ClaimedPublication[]> {
  const r = await db.query<ClaimedPublication>(
    `update public.publication_jobs j
        set status = 'preparing', lease_owner = $1, lease_expires_at = now() + make_interval(secs => $3),
            attempt_count = j.attempt_count + 1
      where j.id in (
        select id from public.publication_jobs
         where id in (
           select id from (
             select j2.id, row_number() over (partition by j2.social_account_id order by j2.scheduled_at, j2.id) as rn
               from public.publication_jobs j2
               join public.social_accounts a on a.id = j2.social_account_id
               join public.workspaces w on w.id = j2.workspace_id
               left join public.campaigns c on c.id = j2.campaign_id
              where j2.status in ('queued', 'failed_retryable') and j2.next_attempt_at <= now()
                and a.status = 'active' and not a.paused and not w.queue_paused
                and (c.id is null or c.status = 'active')
                and not exists (select 1 from public.publication_jobs x
                                 where x.social_account_id = j2.social_account_id
                                   and x.status in ('preparing', 'uploading', 'processing_remote', 'publishing'))
                and not exists (select 1 from public.publication_jobs x
                                 where x.social_account_id = j2.social_account_id and x.status = 'published'
                                   and x.published_at > now() - make_interval(mins => a.min_spacing_minutes))
           ) ranked where rn = 1)
           -- Revalidado no nível do lock: se outro worker acabou de reivindicar,
           -- a nova versão da linha não passa aqui (EvalPlanQual) e é ignorada.
           and status in ('queued', 'failed_retryable') and next_attempt_at <= now()
         order by scheduled_at
         for update skip locked
         limit $2)
        and j.status in ('queued', 'failed_retryable')
     returning j.id, j.workspace_id, j.campaign_id, j.social_account_id, j.media_asset_id, j.attempt_count, j.max_attempts, j.external_checkpoint`,
    [workerId, limit, leaseSeconds],
  );
  return r.rows;
}

/**
 * Leases expirados de publicações em andamento: sem checkpoint externo, nada
 * foi enviado → volta à fila; com checkpoint → estado incerto (reconciliar).
 */
export async function reapPublicationLeases(db: pg.Pool): Promise<{ requeued: number; uncertain: number }> {
  const requeued = await db.query(
    `update public.publication_jobs set status = 'queued', lease_owner = null, lease_expires_at = null,
            last_error_class = 'lease_expired'
      where status = 'preparing' and lease_expires_at < now() and external_checkpoint is null`,
  );
  const uncertain = await db.query(
    `update public.publication_jobs set status = 'uncertain', lease_owner = null, lease_expires_at = null,
            last_error_class = 'lease_expired'
      where status in ('preparing', 'uploading', 'processing_remote', 'publishing') and lease_expires_at < now()`,
  );
  return { requeued: requeued.rowCount ?? 0, uncertain: uncertain.rowCount ?? 0 };
}
