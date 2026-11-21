import "server-only";
import {
  buildPlan,
  orderMedia,
  type Compatibility,
  type OrderStrategy,
  type PlanMedia,
  type PlanTarget,
  type ScheduleRule,
  type SkippedItem,
  type SocialPlatform,
} from "@reelsflow/domain";
import { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type PlanOutcome = { inserted: number; duplicates: number; removed: number; skipped: SkippedItem[]; truncated: boolean };

/**
 * Calcula o plano da campanha com as regras puras de packages/domain e grava
 * via RPC (que revalida permissões, propriedade e horários no banco).
 * - "replace": recalcula todas as publicações futuras editáveis (preserva as fixadas manualmente);
 * - "append": agenda apenas itens ainda sem publicação, depois do último horário de cada alvo.
 */
export async function planCampaign(supabase: Supabase, campaignId: string, mode: "replace" | "append" = "replace"): Promise<PlanOutcome> {
  const { data: c, error } = await supabase.from("campaigns").select("*").eq("id", campaignId).single();
  if (error || !c) throw new Error("Campanha não encontrada.");

  const [{ data: targets }, { data: items }, { data: jobs }] = await Promise.all([
    supabase.from("campaign_targets").select("*").eq("campaign_id", campaignId).eq("enabled", true),
    supabase.from("campaign_media").select("*").eq("campaign_id", campaignId),
    supabase.from("publication_jobs").select("target_id, media_asset_id, scheduled_at, status, pinned").eq("campaign_id", campaignId).neq("status", "cancelled"),
  ]);
  const accountIds = (targets ?? []).map((t) => t.social_account_id);
  const mediaIds = [...new Set((items ?? []).map((i) => i.media_asset_id))];
  const [{ data: accounts }, { data: media }] = await Promise.all([
    accountIds.length ? supabase.from("social_accounts").select("id, platform, provider").in("id", accountIds) : Promise.resolve({ data: [] as { id: string; platform: SocialPlatform; provider: "native" | "zernio" }[] }),
    mediaIds.length
      ? supabase.from("media_assets").select("id, name, compatibility, created_at, status, deleted_at").in("id", mediaIds)
      : Promise.resolve({ data: [] as { id: string; name: string; compatibility: unknown; created_at: string; status: string; deleted_at: string | null }[] }),
  ]);
  const platformOf = new Map((accounts ?? []).map((a) => [a.id, a.platform as SocialPlatform]));
  const providerOf = new Map((accounts ?? []).map((a) => [a.id, (a as { provider?: "native" | "zernio" }).provider ?? "native"]));
  const mediaById = new Map((media ?? []).map((m) => [m.id, m]));

  // Publicações que não devem ser recriadas: já iniciadas/concluídas, fixadas, ou (no modo append) qualquer existente.
  const keep = new Set(
    (jobs ?? [])
      .filter((j) => mode === "append" || j.pinned || !["draft", "scheduled", "needs_review"].includes(j.status) || Date.parse(j.scheduled_at) <= Date.now() + 2 * 60_000)
      .map((j) => `${j.target_id}:${j.media_asset_id}`),
  );

  const rule: ScheduleRule = { timezone: c.timezone, weekdays: c.weekdays, times: c.times, startDate: c.start_date, endDate: c.end_date };
  const planTargets: PlanTarget[] = (targets ?? []).map((t) => ({
    targetId: t.id,
    accountId: t.social_account_id,
    platform: platformOf.get(t.social_account_id) ?? "mock",
    provider: providerOf.get(t.social_account_id) ?? "native",
    offsetMinutes: t.offset_minutes,
    rule: c.mode === "independent" && t.weekdays?.length && t.times?.length ? { ...rule, weekdays: t.weekdays, times: t.times } : undefined,
  }));

  const usable = (items ?? []).filter((i) => {
    const m = mediaById.get(i.media_asset_id);
    return m && m.status === "ready" && !m.deleted_at;
  });
  const ordered = orderMedia(
    usable.map((i) => ({ ...i, createdAt: mediaById.get(i.media_asset_id)!.created_at })),
    c.order_strategy as OrderStrategy,
    Number(c.random_seed),
  );

  // Remove itens já mantidos por alvo (no espelhado, o item só sai se TODOS os alvos já o têm).
  const planMedia: PlanMedia[] = [];
  for (const i of ordered) {
    const relevantTargets = c.mode === "independent" ? planTargets.filter((t) => t.targetId === i.target_id) : planTargets;
    if (relevantTargets.length && relevantTargets.every((t) => keep.has(`${t.targetId}:${i.media_asset_id}`))) continue;
    const m = mediaById.get(i.media_asset_id)!;
    planMedia.push({ campaignMediaId: i.id, mediaId: i.media_asset_id, name: m.name, compatibility: m.compatibility as Compatibility, targetId: i.target_id });
  }

  // Só no modo "append" os novos itens vão depois do último horário existente; ao
  // recalcular, publicações fixadas não empurram o restante do calendário.
  const lastByTarget: Record<string, Date> = {};
  for (const j of mode === "append" ? (jobs ?? []) : []) {
    if (!j.target_id) continue;
    const kept = keep.has(`${j.target_id}:${j.media_asset_id}`);
    if (!kept) continue;
    const at = new Date(j.scheduled_at);
    if (!lastByTarget[j.target_id] || at > lastByTarget[j.target_id]!) lastByTarget[j.target_id] = at;
  }

  const plan = buildPlan({
    mode: c.mode,
    rule,
    targets: planTargets,
    media: planMedia,
    notBefore: new Date(Date.now() + 5 * 60_000),
    notBeforeByTarget: lastByTarget,
  });
  const payload = plan.jobs
    .filter((j) => !keep.has(`${j.targetId}:${j.mediaId}`))
    .map((j) => ({
      campaign_media_id: j.campaignMediaId,
      target_id: j.targetId,
      scheduled_at: j.scheduledAt,
      local_date: j.localDate,
      local_time: j.localTime,
      timezone: j.timezone,
      dst_adjusted: j.dstAdjusted,
      post_group_key: j.postGroupKey,
    }));

  const { data: saved, error: saveError } = await supabase.rpc("save_campaign_plan", {
    p_campaign: campaignId,
    p_jobs: payload,
    p_replace: mode === "replace",
  });
  if (saveError) throw new Error(saveError.message);
  const r = saved?.[0] ?? { inserted: 0, skipped_duplicates: 0, removed: 0 };
  return { inserted: r.inserted, duplicates: r.skipped_duplicates, removed: r.removed, skipped: plan.skipped, truncated: plan.truncated };
}
