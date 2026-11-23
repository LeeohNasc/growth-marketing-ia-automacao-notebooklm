import type { Db } from "../db";
import { ConnectorError, toConnectorError, type ConnectorRegistry, type Phase, type PublishConnector } from "@reelsflow/connectors";
import { RECONCILE_MAX_ATTEMPTS, composeCaption, publicationBackoffSeconds, reconcileDelaySeconds, resolveContent } from "@reelsflow/domain";
import type { Logger } from "../log";
import type { CredentialProvider } from "./credentials";
import type { ClaimedPublication } from "./scheduler";
import { getRule, notify, recordRun, workspaceAdmins } from "./rules";

export type PublishDeps = {
  db: Db;
  connectors: ConnectorRegistry;
  log: Logger;
  workerId: string;
  leaseSeconds: number;
  credentials?: CredentialProvider;
  /** URL temporária e pública do vídeo (a plataforma baixa o arquivo por ela). */
  mediaUrl?: (storagePath: string, ttlSeconds?: number) => Promise<string | null>;
};

class LeaseLost extends Error {}

/**
 * Esperas que NÃO gastam tentativa: a plataforma ainda processa (o conector impõe o prazo total) ou
 * falta configuração do servidor (chave da Zernio ausente/inválida) — nada a ver com a publicação.
 */
const NO_ATTEMPT_WAIT_CODES = new Set(["ig_processing", "zernio_processing", "zernio_not_configured", "zernio_api_key", "zernio_payment_required"]);
/** Problemas de CONFIGURAÇÃO do servidor (não da conta do cliente): viram alerta operacional. */
const SERVER_CONFIG_CODES: Record<string, string> = {
  zernio_not_configured: "A chave da Zernio não está configurada no worker; publicações via Zernio estão em espera.",
  zernio_api_key: "A Zernio recusou a chave do servidor (inválida ou revogada); publicações via Zernio estão em espera.",
  zernio_payment_required: "A Zernio exige pagamento/upgrade do plano; publicações via Zernio estão em espera.",
};
/** Validade da URL do vídeo: a Zernio pode segurar o post (limites da rede) antes de baixar o arquivo. */
const ZERNIO_MEDIA_URL_TTL = 24 * 3600;

const accountInput = (a: Context["account"]) => ({
  id: a.id,
  platform: a.platform,
  externalAccountId: a.external_account_id,
  settings: a.settings,
  providerProfileId: a.provider_profile_id ?? null,
});

type Context = {
  job: { id: string; caption_override: string | null; external_checkpoint: Record<string, unknown> | null };
  account: {
    id: string;
    platform: "instagram" | "facebook" | "tiktok" | "youtube" | "mock";
    external_account_id: string;
    status: string;
    settings: Record<string, unknown>;
    display_name: string;
    provider?: "native" | "zernio";
    provider_profile_id?: string | null;
  };
  media: { storage_path: string; mime_type: string; size_bytes: number; duration_ms: number | null; status: string; deleted_at: string | null; default_caption: string | null; default_hashtags: string[]; name: string } | null;
  campaign: { id: string; name: string; caption: string | null; hashtags: string[]; created_by: string | null } | null;
  target: { caption_override: string | null; hashtags_override: string[] | null } | null;
  cm: { caption_override: string | null; hashtags_override: string[] | null } | null;
  workspaceSettings: Record<string, unknown>;
};

async function loadContext(db: Db, jobId: string): Promise<Context> {
  const { rows } = await db.query(
    `select row_to_json(j.*) as job, row_to_json(a.*) as account, row_to_json(m.*) as media, row_to_json(c.*) as campaign,
            row_to_json(t.*) as target, row_to_json(cm.*) as cm, w.settings as workspace_settings
       from public.publication_jobs j
       join public.workspaces w on w.id = j.workspace_id
       join public.social_accounts a on a.id = j.social_account_id
       left join public.media_assets m on m.id = j.media_asset_id
       left join public.campaigns c on c.id = j.campaign_id
       left join public.campaign_targets t on t.id = j.target_id
       left join public.campaign_media cm on cm.id = j.campaign_media_id
      where j.id = $1`,
    [jobId],
  );
  const r = rows[0];
  return { job: r.job, account: r.account, media: r.media, campaign: r.campaign, target: r.target, cm: r.cm, workspaceSettings: r.workspace_settings ?? {} };
}

/**
 * Conteúdo efetivo com precedência vídeo > campanha > conta > global.
 * Camada "vídeo": override da publicação > override do item na campanha > padrão do vídeo.
 * Camada "campanha": override do alvo (conta dentro da campanha) > campanha.
 */
export function effectiveContent(ctx: Context) {
  const pickStr = (...v: (string | null | undefined)[]) => v.find((x) => typeof x === "string" && x.trim()) ?? null;
  const pickArr = (...v: (string[] | null | undefined)[]) => v.find((x) => Array.isArray(x) && x.length) ?? null;
  const ws = ctx.workspaceSettings as { default_caption?: string; default_hashtags?: string[] };
  const acc = ctx.account.settings as { default_caption?: string; default_hashtags?: string[] };
  const resolved = resolveContent({
    media: {
      caption: pickStr(ctx.job.caption_override, ctx.cm?.caption_override, ctx.media?.default_caption),
      hashtags: pickArr(ctx.cm?.hashtags_override, ctx.media?.default_hashtags),
    },
    campaign: { caption: pickStr(ctx.target?.caption_override, ctx.campaign?.caption), hashtags: pickArr(ctx.target?.hashtags_override, ctx.campaign?.hashtags) },
    account: { caption: acc.default_caption ?? null, hashtags: acc.default_hashtags ?? null },
    global: { caption: ws.default_caption ?? null, hashtags: ws.default_hashtags ?? null },
  });
  const composed = composeCaption({ caption: resolved.caption.value, hashtags: resolved.hashtags.value });
  return { resolved, composed };
}

async function transition(db: Db, jobId: string, workerId: string, set: string, params: unknown[]) {
  const r = await db.query(`update public.publication_jobs set ${set} where id = $1 and lease_owner = $2`, [jobId, workerId, ...params]);
  if (r.rowCount !== 1) throw new LeaseLost(`lease lost for job ${jobId}`);
}

async function finishAttempt(db: Db, attemptId: string, fields: { outcome: string; phase?: string | null; err?: ConnectorError | null; checkpoint?: unknown }) {
  await db.query(
    `update public.publication_attempts
        set finished_at = now(), outcome = $2, phase_reached = coalesce($3, phase_reached), error_class = $4, error_code = $5,
            error_message = left($6, 1000), retry_after_seconds = $7, checkpoint = coalesce($8, checkpoint)
      where id = $1`,
    [
      attemptId,
      fields.outcome,
      fields.phase ?? null,
      fields.err?.errorClass ?? null,
      fields.err?.code ?? null,
      fields.err?.message ?? null,
      fields.err?.retryAfterSeconds ?? null,
      fields.checkpoint ? JSON.stringify(fields.checkpoint) : null,
    ],
  );
}

/** Executa uma publicação reivindicada. Nunca lança: todo desfecho vira estado persistido. */
export async function executePublication(claimed: ClaimedPublication, deps: PublishDeps): Promise<string> {
  try {
    return await executeInner(claimed, deps);
  } catch (err) {
    deps.log.error(err instanceof LeaseLost ? "lease lost" : "publication crashed", { job_id: claimed.id, error: String(err) });
    // Sem lease, nada é alterado: o reaper resolve (fila ou incerto conforme o checkpoint).
    return "aborted";
  }
}

async function executeInner(claimed: ClaimedPublication, deps: PublishDeps): Promise<string> {
  const { db, log, workerId } = deps;
  const ctx = await loadContext(db, claimed.id);
  const attempt = await db.query<{ id: string }>(
    "insert into public.publication_attempts (job_id, workspace_id, attempt_no, worker_id) values ($1, $2, $3, $4) returning id::text",
    [claimed.id, claimed.workspace_id, claimed.attempt_count, workerId],
  );
  const attemptId = attempt.rows[0]!.id;
  const owners = [ctx.campaign?.created_by];

  // Pré-condições que não se resolvem com retry.
  if (!ctx.media || ctx.media.deleted_at || ctx.media.status !== "ready") {
    await transition(db, claimed.id, workerId, "status = 'failed_permanent', lease_owner = null, lease_expires_at = null, last_error_class = 'media_unavailable', last_error_message = 'Vídeo excluído ou indisponível.'", []);
    await finishAttempt(db, attemptId, { outcome: "permanent", err: new ConnectorError("permanent", "Vídeo excluído ou indisponível.", { code: "media_unavailable" }) });
    await notify(db, claimed.workspace_id, owners, "publication.failed", { job_id: claimed.id, reason: "media_unavailable" });
    return "failed_permanent";
  }

  const { resolved, composed } = effectiveContent(ctx);
  await transition(db, claimed.id, workerId, "effective_config = $3", [
    JSON.stringify({ caption: composed.text, truncated: composed.truncated, sources: { caption: resolved.caption.source, hashtags: resolved.hashtags.source } }),
  ]);

  // Heartbeat: estende o lease enquanto a publicação está em andamento.
  const beat = setInterval(() => {
    db.query("update public.publication_jobs set lease_expires_at = now() + make_interval(secs => $3) where id = $1 and lease_owner = $2", [claimed.id, workerId, deps.leaseSeconds]).catch(() => undefined);
  }, Math.max(1000, (deps.leaseSeconds * 1000) / 3));

  let checkpoint: Record<string, unknown> | null = ctx.job.external_checkpoint;
  let phase: Phase | null = null;
  let connector: PublishConnector | undefined;
  try {
    connector = deps.connectors.forAccount(ctx.account);
    const viaZernio = ctx.account.provider === "zernio";
    // Contas via Zernio não têm token no ReelsFlow (a chave da Zernio fica no conector).
    const credentials = viaZernio ? null : ((await deps.credentials?.get(ctx.account)) ?? null);
    const mediaUrl = ctx.account.platform === "mock" ? null : ((await deps.mediaUrl?.(ctx.media.storage_path, viaZernio ? ZERNIO_MEDIA_URL_TTL : undefined)) ?? null);
    const io = {
      save: async (p: Phase, cp: Record<string, unknown>) => {
        // Persistido ANTES do efeito externo correspondente.
        await transition(db, claimed.id, workerId, "status = $3, external_checkpoint = $4", [p, JSON.stringify(cp)]);
        checkpoint = cp;
        phase = p;
      },
    };
    const result = await connector.publish(
      {
        jobId: claimed.id,
        attemptNo: claimed.attempt_count,
        account: accountInput(ctx.account),
        media: { storagePath: ctx.media.storage_path, mimeType: ctx.media.mime_type, sizeBytes: ctx.media.size_bytes, durationMs: ctx.media.duration_ms, url: mediaUrl },
        caption: composed.text,
        checkpoint,
        credentials,
      },
      io,
    );
    await markPublished(db, claimed, ctx, result.externalId, result.permalink, "api", workerId);
    await finishAttempt(db, attemptId, { outcome: "published", phase, checkpoint });
    if (ctx.account.provider === "zernio") {
      // Publicou pela Zernio: problemas de configuração anteriores estão resolvidos.
      await db.query("select app.resolve_ops_alert(k) from unnest($1::text[]) k", [Object.keys(SERVER_CONFIG_CODES)]);
    }
    log.info("published", { job_id: claimed.id, attempt: claimed.attempt_count });
    return "published";
  } catch (raw) {
    if (raw instanceof LeaseLost) {
      log.warn("lease lost; abandoning attempt", { job_id: claimed.id });
      await finishAttempt(db, attemptId, { outcome: "aborted", phase, checkpoint });
      return "aborted";
    }
    const err = toConnectorError(raw, checkpoint !== null);
    return await handleFailure(claimed, ctx, err, { attemptId, phase, checkpoint }, deps);
  } finally {
    clearInterval(beat);
  }
}

async function markPublished(
  db: Db,
  claimed: Pick<ClaimedPublication, "id" | "workspace_id">,
  ctx: Context,
  externalId: string | null,
  permalink: string | null,
  source: "api" | "reconciled",
  workerId: string,
) {
  const r = await db.query(
    `update public.publication_jobs set status = 'published', published_at = now(), lease_owner = null, lease_expires_at = null,
            last_error_class = null, last_error_message = null
      where id = $1 and lease_owner = $2`,
    [claimed.id, workerId],
  );
  if (r.rowCount !== 1) throw new LeaseLost(`lease lost for job ${claimed.id}`);
  await db.query(
    `insert into public.external_publications (job_id, workspace_id, social_account_id, platform, external_id, permalink, source)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (job_id) do nothing`,
    [claimed.id, claimed.workspace_id, ctx.account.id, ctx.account.platform, externalId, permalink, source],
  );
  await notify(db, claimed.workspace_id, [ctx.campaign?.created_by], "publication.published", {
    job_id: claimed.id,
    media: ctx.media?.name,
    account: ctx.account.display_name,
    permalink,
  });
}

async function handleFailure(
  claimed: ClaimedPublication,
  ctx: Context,
  err: ConnectorError,
  a: { attemptId: string; phase: Phase | null; checkpoint: Record<string, unknown> | null },
  deps: PublishDeps,
): Promise<string> {
  const { db, workerId, log } = deps;
  const owners = [ctx.campaign?.created_by];
  const clear = "lease_owner = null, lease_expires_at = null, last_error_class = $3, last_error_message = left($4, 1000)";
  const base = [err.errorClass, err.message];

  // Efeito externo pode ter acontecido: NUNCA repetir às cegas.
  if ((err.errorClass === "timeout" || err.errorClass === "unknown") && err.sideEffectStarted) {
    await transition(db, claimed.id, workerId, `status = 'uncertain', ${clear}`, base);
    await finishAttempt(db, a.attemptId, { outcome: "uncertain", phase: a.phase, err, checkpoint: a.checkpoint });
    log.warn("publication uncertain", { job_id: claimed.id, error: err.message });
    return "uncertain";
  }

  if (err.errorClass === "auth") {
    const rule = await getRule(db, claimed.workspace_id, "pause_on_auth_loss");
    await db.query("update public.social_accounts set status = 'needs_reauth' where id = $1", [ctx.account.id]);
    if (rule.enabled) {
      // A publicação aguarda a reconexão (a fila ignora contas sem autorização).
      await transition(db, claimed.id, workerId, `status = 'failed_retryable', next_attempt_at = now(), attempt_count = greatest(attempt_count - 1, 0), ${clear}`, base);
      await recordRun(db, {
        workspaceId: claimed.workspace_id,
        rule: "pause_on_auth_loss",
        subjectType: "social_account",
        subjectId: ctx.account.id,
        outcome: "account_paused",
        dedupeKey: `auth_loss:${ctx.account.id}:${new Date().toISOString().slice(0, 13)}`,
      });
    } else {
      await transition(db, claimed.id, workerId, `status = 'failed_permanent', ${clear}`, base);
    }
    await finishAttempt(db, a.attemptId, { outcome: rule.enabled ? "retry" : "permanent", phase: a.phase, err, checkpoint: a.checkpoint });
    await notify(db, claimed.workspace_id, await workspaceAdmins(db, claimed.workspace_id), "account.disconnected", {
      account_id: ctx.account.id,
      account: ctx.account.display_name,
    });
    return rule.enabled ? "failed_retryable" : "failed_permanent";
  }

  // A plataforma ainda processa o vídeo (container criado e salvo no checkpoint): volta em
  // ~1 min para o MESMO container sem gastar tentativa. O conector impõe o prazo total.
  if (err.code && NO_ATTEMPT_WAIT_CODES.has(err.code)) {
    const delay = Math.max(30, err.retryAfterSeconds ?? 60);
    if (SERVER_CONFIG_CODES[err.code]) {
      // Um alerta por problema (repetições só incrementam o contador); o cliente não é culpado.
      await db.query("select app.raise_ops_alert($1, 'critical', null, $2, $3::jsonb, $1)", [
        err.code,
        SERVER_CONFIG_CODES[err.code],
        JSON.stringify({ last_job_id: claimed.id, provider_message: err.message.slice(0, 200) }),
      ]);
      log.error("server configuration problem; publication waiting", { job_id: claimed.id, code: err.code });
    }
    await transition(db, claimed.id, workerId, `status = 'failed_retryable', next_attempt_at = now() + make_interval(secs => $5), attempt_count = greatest(attempt_count - 1, 0), ${clear}`, [...base, delay]);
    await finishAttempt(db, a.attemptId, { outcome: "retry", phase: a.phase, err, checkpoint: a.checkpoint });
    log.info("publication waiting for remote processing", { job_id: claimed.id, delay_s: delay });
    return "failed_retryable";
  }

  const retryable = err.errorClass === "transient" || err.errorClass === "rate_limited" || err.errorClass === "timeout" || err.errorClass === "unknown";
  const rule = await getRule(db, claimed.workspace_id, "retry_transient");
  const maxAttempts = rule.enabled ? Math.min(claimed.max_attempts, Number(rule.params.max_attempts) || claimed.max_attempts) : 1;

  if (retryable && claimed.attempt_count < maxAttempts) {
    const delay = publicationBackoffSeconds(claimed.attempt_count, { retryAfterSeconds: err.retryAfterSeconds });
    await transition(db, claimed.id, workerId, `status = 'failed_retryable', next_attempt_at = now() + make_interval(secs => $5), ${clear}`, [...base, delay]);
    await finishAttempt(db, a.attemptId, { outcome: "retry", phase: a.phase, err, checkpoint: a.checkpoint });
    log.warn("publication retry scheduled", { job_id: claimed.id, attempt: claimed.attempt_count, delay_s: delay, error_class: err.errorClass });
    return "failed_retryable";
  }

  // Erro permanente ou tentativas esgotadas: "dead-letter" (failed_permanent), revisável pelo usuário.
  await transition(db, claimed.id, workerId, `status = 'failed_permanent', ${clear}`, base);
  await finishAttempt(db, a.attemptId, { outcome: "permanent", phase: a.phase, err, checkpoint: a.checkpoint });
  await notify(db, claimed.workspace_id, owners, "publication.failed", { job_id: claimed.id, reason: err.code ?? err.errorClass, message: err.message });
  log.error("publication failed permanently", { job_id: claimed.id, error_class: err.errorClass, attempts: claimed.attempt_count });
  return "failed_permanent";
}

/**
 * Reconciliação de estados incertos: consulta a plataforma pelo checkpoint.
 * publicado → published; não recebido → retry seguro; ainda processando/indeterminado →
 * nova consulta espaçada (`reconcileDelaySeconds`); sem confirmação depois de ~24 h
 * (`RECONCILE_MAX_ATTEMPTS` consultas) → revisão humana. Nunca reenvia às cegas.
 */
export async function reconcileUncertain(deps: Omit<PublishDeps, "leaseSeconds">, limit = 20, minAgeSeconds = 30): Promise<number> {
  const { db, log, workerId } = deps;
  // Reivindica com lease (status continua 'uncertain'): dois workers nunca reconciliam o mesmo item.
  const { rows } = await db.query<{ id: string; workspace_id: string; external_checkpoint: Record<string, unknown> | null; reconcile_attempts: number }>(
    `update public.publication_jobs j set lease_owner = $3, lease_expires_at = now() + interval '2 minutes'
      where j.id in (
        select id from public.publication_jobs
         where status = 'uncertain' and updated_at < now() - make_interval(secs => $2)
           and (reconcile_attempts = 0 or next_attempt_at <= now())
           and (lease_expires_at is null or lease_expires_at < now())
         order by updated_at limit $1 for update skip locked)
     returning j.id, j.workspace_id, j.external_checkpoint, j.reconcile_attempts`,
    [limit, minAgeSeconds, workerId],
  );
  for (const j of rows) {
    const ctx = await loadContext(db, j.id);
    const attemptNo = j.reconcile_attempts + 1;
    const att = await db.query<{ id: string }>(
      "insert into public.publication_attempts (job_id, workspace_id, attempt_no, worker_id, kind) values ($1, $2, $3, $4, 'reconcile') returning id::text",
      [j.id, j.workspace_id, attemptNo, workerId],
    );
    // Próxima consulta espaçada (o status continua "incerto" até a plataforma responder).
    const unlock = "lease_owner = null, lease_expires_at = null, reconcile_attempts = $3";
    const release = `${unlock}, next_attempt_at = now() + make_interval(secs => ${reconcileDelaySeconds(attemptNo)})`;
    let state: string;
    try {
      const status = j.external_checkpoint
        ? await deps.connectors.forAccount(ctx.account).getStatus(
            accountInput(ctx.account),
            j.external_checkpoint,
            ctx.account.provider === "zernio" ? null : ((await deps.credentials?.get(ctx.account)) ?? null),
          )
        : ({ state: "not_found" } as const);
      state = status.state;
      if (status.state === "published") {
        await db.query("update public.publication_jobs set reconcile_attempts = $3 where id = $1 and lease_owner = $2", [j.id, workerId, attemptNo]);
        await markPublished(db, { id: j.id, workspace_id: j.workspace_id }, ctx, status.externalId, status.permalink, "reconciled", workerId);
      } else if (status.state === "not_found") {
        // A plataforma não recebeu: repetir é seguro.
        await db.query(
          `update public.publication_jobs set status = 'failed_retryable', external_checkpoint = null, ${unlock}, next_attempt_at = now()
            where id = $1 and lease_owner = $2`,
          [j.id, workerId, attemptNo],
        );
      } else if (attemptNo >= RECONCILE_MAX_ATTEMPTS) {
        await db.query(
          `update public.publication_jobs set status = 'needs_review', review_reason = 'uncertain_unresolved', ${release}
            where id = $1 and lease_owner = $2`,
          [j.id, workerId, attemptNo],
        );
        await notify(db, j.workspace_id, [ctx.campaign?.created_by], "publication.needs_review", { job_id: j.id, reason: "uncertain_unresolved" });
      } else {
        await db.query(`update public.publication_jobs set ${release} where id = $1 and lease_owner = $2`, [j.id, workerId, attemptNo]);
        log.info("publication still unconfirmed", { job_id: j.id, check: attemptNo, remote_state: state, next_check_s: reconcileDelaySeconds(attemptNo) });
      }
    } catch (e) {
      state = "error";
      await db.query(`update public.publication_jobs set ${release} where id = $1 and lease_owner = $2`, [j.id, workerId, attemptNo]);
      log.warn("reconcile failed", { job_id: j.id, error: String(e) });
    }
    await db.query("update public.publication_attempts set finished_at = now(), outcome = $2 where id = $1", [
      att.rows[0]!.id,
      state === "published" ? "published" : state === "not_found" ? "not_found" : "unknown",
    ]);
  }
  return rows.length;
}
