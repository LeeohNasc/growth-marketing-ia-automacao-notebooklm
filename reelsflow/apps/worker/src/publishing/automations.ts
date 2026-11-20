import type { Db } from "../db";
import { buildPlan, type Compatibility, type PlanTarget, type ScheduleRule, type SocialPlatform } from "@reelsflow/domain";
import type { Logger } from "../log";
import { getRule, notify, recordRun } from "./rules";

type Campaign = {
  id: string;
  workspace_id: string;
  name: string;
  mode: "mirrored" | "independent";
  timezone: string;
  weekdays: number[];
  times: string[];
  start_date: string;
  end_date: string | null;
  source_collection_id: string | null;
  created_by: string | null;
};

const PENDING = "('draft','scheduled','queued','preparing','uploading','processing_remote','publishing','failed_retryable','uncertain','needs_review')";

/**
 * Regra 1 — campanha vinculada a uma coleção: vídeos novos e prontos da
 * coleção entram automaticamente no fim da fila.
 */
export async function appendFromCollections(db: Db, log: Logger, now = new Date()): Promise<number> {
  const { rows: campaigns } = await db.query<Campaign>(
    `select id, workspace_id, name, mode, timezone, weekdays, times, start_date::text, end_date::text, source_collection_id, created_by
       from public.campaigns where status = 'active' and source_collection_id is not null`,
  );
  let total = 0;
  for (const c of campaigns) {
    if (!(await getRule(db, c.workspace_id, "append_from_collection")).enabled) continue;
    const targets = (
      await db.query<{ id: string; social_account_id: string; platform: SocialPlatform; offset_minutes: number; weekdays: number[] | null; times: string[] | null }>(
        `select t.id, t.social_account_id, a.platform, t.offset_minutes, t.weekdays, t.times
           from public.campaign_targets t join public.social_accounts a on a.id = t.social_account_id
          where t.campaign_id = $1 and t.enabled`,
        [c.id],
      )
    ).rows;
    if (!targets.length) continue;

    const fresh = (
      await db.query<{ id: string; name: string; compatibility: Compatibility }>(
        `select m.id, m.name, m.compatibility from public.collection_items ci
           join public.media_assets m on m.id = ci.media_asset_id
          where ci.collection_id = $1 and m.status = 'ready' and m.deleted_at is null
            and not exists (select 1 from public.campaign_media cm where cm.campaign_id = $2 and cm.media_asset_id = m.id)
          order by ci.position, m.created_at`,
        [c.source_collection_id, c.id],
      )
    ).rows;
    if (!fresh.length) continue;

    const maxPos = (await db.query<{ p: number }>("select coalesce(max(position), -1) as p from public.campaign_media where campaign_id = $1", [c.id])).rows[0]!.p;
    const items: { campaignMediaId: string; mediaId: string; name: string; compatibility: Compatibility; targetId: string | null }[] = [];
    let pos = maxPos + 1;
    for (const m of fresh) {
      const perTarget = c.mode === "independent" ? targets.map((t) => t.id) : [null];
      for (const targetId of perTarget) {
        const r = await db.query<{ id: string }>(
          "insert into public.campaign_media (campaign_id, workspace_id, media_asset_id, target_id, position) values ($1, $2, $3, $4, $5) returning id",
          [c.id, c.workspace_id, m.id, targetId, pos],
        );
        items.push({ campaignMediaId: r.rows[0]!.id, mediaId: m.id, name: m.name, compatibility: m.compatibility, targetId });
      }
      pos++;
    }

    const last = await db.query<{ target_id: string; at: Date }>(
      `select target_id, max(scheduled_at) as at from public.publication_jobs
        where campaign_id = $1 and status <> 'cancelled' group by target_id`,
      [c.id],
    );
    const notBeforeByTarget = Object.fromEntries(last.rows.map((r) => [r.target_id, r.at]));
    const rule: ScheduleRule = { timezone: c.timezone, weekdays: c.weekdays, times: c.times, startDate: c.start_date, endDate: c.end_date };
    const planTargets: PlanTarget[] = targets.map((t) => ({
      targetId: t.id,
      accountId: t.social_account_id,
      platform: t.platform,
      offsetMinutes: t.offset_minutes,
      rule: t.weekdays && t.times ? { ...rule, weekdays: t.weekdays, times: t.times } : undefined,
    }));
    const plan = buildPlan({
      mode: c.mode,
      rule,
      targets: planTargets,
      media: items,
      notBefore: new Date(now.getTime() + 5 * 60_000),
      notBeforeByTarget,
    });
    let inserted = 0;
    for (const j of plan.jobs) {
      const r = await db.query(
        `insert into public.publication_jobs (workspace_id, campaign_id, campaign_media_id, target_id, social_account_id, media_asset_id,
                                              post_group_key, local_date, local_time, timezone, scheduled_at, dst_adjusted, status, next_attempt_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'scheduled', $11)
         on conflict (campaign_id, target_id, media_asset_id) where status <> 'cancelled' do nothing`,
        [c.workspace_id, c.id, j.campaignMediaId, j.targetId, j.accountId, j.mediaId, j.postGroupKey, j.localDate, j.localTime, j.timezone, j.scheduledAt, j.dstAdjusted],
      );
      inserted += r.rowCount ?? 0;
    }
    await recordRun(db, {
      workspaceId: c.workspace_id,
      rule: "append_from_collection",
      subjectType: "campaign",
      subjectId: c.id,
      outcome: "appended",
      details: { videos: fresh.length, publications: inserted, skipped: plan.skipped.length },
    });
    log.info("automation append", { campaign_id: c.id, videos: fresh.length, publications: inserted });
    total += inserted;
  }
  return total;
}

/** Regra 3 — aviso quando faltar conteúdo agendado para os próximos N dias (1 aviso por dia por campanha). */
export async function lowContentAlerts(db: Db, now = new Date()): Promise<number> {
  const { rows } = await db.query<{ id: string; workspace_id: string; name: string; created_by: string | null; end_date: string | null; last_at: Date | null }>(
    `select c.id, c.workspace_id, c.name, c.created_by, c.end_date::text,
            (select max(j.scheduled_at) from public.publication_jobs j where j.campaign_id = c.id and j.status in ('scheduled','queued')) as last_at
       from public.campaigns c where c.status = 'active'`,
  );
  let sent = 0;
  for (const c of rows) {
    const rule = await getRule(db, c.workspace_id, "low_content_alert");
    if (!rule.enabled) continue;
    const days = Number(rule.params.days) || 3;
    const horizon = now.getTime() + days * 86_400_000;
    if (c.end_date && Date.parse(`${c.end_date}T23:59:59Z`) < horizon) continue; // a campanha termina antes do horizonte
    if (c.last_at && c.last_at.getTime() >= horizon) continue;
    const fresh = await recordRun(db, {
      workspaceId: c.workspace_id,
      rule: "low_content_alert",
      subjectType: "campaign",
      subjectId: c.id,
      outcome: "notified",
      details: { days, last_scheduled_at: c.last_at },
      dedupeKey: `low_content:${c.id}:${now.toISOString().slice(0, 10)}`,
    });
    if (fresh) {
      await notify(db, c.workspace_id, [c.created_by], "queue.low", { campaign_id: c.id, campaign: c.name, days, last_scheduled_at: c.last_at });
      sent++;
    }
  }
  return sent;
}

/**
 * Regra 4 — conclui campanhas sem publicações pendentes e gera resumo.
 * Campanhas alimentadas por coleção sem data final continuam ativas (aguardam vídeos).
 */
export async function completeCampaigns(db: Db, now = new Date()): Promise<number> {
  const { rows } = await db.query<{ id: string; workspace_id: string; name: string; created_by: string | null }>(
    `select c.id, c.workspace_id, c.name, c.created_by from public.campaigns c
      where c.status = 'active'
        and exists (select 1 from public.publication_jobs j where j.campaign_id = c.id)
        and not exists (select 1 from public.publication_jobs j where j.campaign_id = c.id and j.status in ${PENDING})
        and (c.source_collection_id is null or (c.end_date is not null and c.end_date < ($1::timestamptz at time zone c.timezone)::date))`,
    [now.toISOString()],
  );
  let done = 0;
  for (const c of rows) {
    if (!(await getRule(db, c.workspace_id, "complete_campaign")).enabled) continue;
    const summary = (
      await db.query<{ status: string; n: number }>("select status::text, count(*)::int as n from public.publication_jobs where campaign_id = $1 group by status", [c.id])
    ).rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: r.n }), {});
    const r = await db.query("update public.campaigns set status = 'completed', completed_at = now(), summary = $2 where id = $1 and status = 'active'", [c.id, JSON.stringify(summary)]);
    if (r.rowCount !== 1) continue;
    await recordRun(db, { workspaceId: c.workspace_id, rule: "complete_campaign", subjectType: "campaign", subjectId: c.id, outcome: "completed", details: summary });
    await notify(db, c.workspace_id, [c.created_by], "campaign.completed", { campaign_id: c.id, campaign: c.name, summary });
    done++;
  }
  return done;
}
