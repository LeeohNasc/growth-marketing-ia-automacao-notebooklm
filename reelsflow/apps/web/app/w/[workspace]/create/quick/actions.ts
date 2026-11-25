"use server";
import { revalidatePath } from "next/cache";
import { Temporal } from "temporal-polyfill";
import { can, extraHashtags, normalizeHashtags } from "@reelsflow/domain";
import { planCampaign } from "@/lib/planning";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { campaignStatusAction } from "../../campaigns/actions";

/** Antecedência mínima: bem acima da trava de edição do banco (2 min) e do ciclo do worker. */
const MIN_LEAD_MIN = 10;
const MAX_AHEAD_DAYS = 365;
const QUICK_PREFIX = "Publicação rápida";

export type QuickInput = { slug: string; mediaId: string; accountId: string; date: string; time: string; caption: string; hashtags: string };
export type QuickResult =
  | { ok: true; jobId: string; campaignId: string; scheduledAt: string; note?: "already_scheduled" | "resumed" }
  | { ok: false; message: string; field?: "media" | "account" | "when" | "caption"; retry?: boolean };

/**
 * Publicação Rápida = uma campanha de 1 vídeo, 1 conta e 1 horário, montada com as MESMAS peças das
 * campanhas (insert com RLS, planCampaign → RPC, campaignStatusAction → set_campaign_status). Por isso
 * valem as regras de sempre: permissão de editor, compatibilidade, trava perto do horário, chave de
 * idempotência por publicação na Zernio e índices contra duplicata.
 *
 * Falha entre criar e ativar: a campanha fica em rascunho; repetir o pedido RETOMA esse rascunho (não
 * cria outro). Pedido repetido depois de agendado: devolve a publicação existente (nada é duplicado).
 */
export async function quickScheduleAction(input: QuickInput): Promise<QuickResult> {
  const { workspace, user, role } = await requireWorkspace(input.slug);
  if (!can(role, "editContent")) return { ok: false, message: "Seu papel neste workspace é somente leitura." };
  const supabase = await createClient();
  const tz = workspace.default_timezone;

  // 1. quando (no fuso do workspace)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) {
    return { ok: false, field: "when", message: "Escolha a data e o horário." };
  }
  const local = Temporal.PlainDateTime.from(`${input.date}T${input.time}`);
  const zoned = local.toZonedDateTime(tz);
  if (!zoned.toPlainDateTime().equals(local)) return { ok: false, field: "when", message: "Esse horário não existe neste fuso (mudança de horário). Escolha outro." };
  const at = zoned.toInstant();
  const now = Temporal.Now.instant();
  if (Temporal.Instant.compare(at, now.add({ minutes: MIN_LEAD_MIN })) < 0) {
    return { ok: false, field: "when", message: `Escolha um horário a pelo menos ${MIN_LEAD_MIN} minutos de agora.` };
  }
  if (Temporal.Instant.compare(at, now.add({ hours: 24 * MAX_AHEAD_DAYS })) > 0) return { ok: false, field: "when", message: "Escolha uma data dentro dos próximos 12 meses." };

  // 2. vídeo e conta (do próprio workspace; RLS também barra)
  const [{ data: media }, { data: account }] = await Promise.all([
    supabase.from("media_assets").select("id, name, status, deleted_at").eq("id", input.mediaId).eq("workspace_id", workspace.id).maybeSingle(),
    supabase.from("social_accounts").select("id, status").eq("id", input.accountId).eq("workspace_id", workspace.id).maybeSingle(),
  ]);
  if (!media || media.deleted_at) return { ok: false, field: "media", message: "Escolha um vídeo da Biblioteca." };
  if (media.status !== "ready") return { ok: false, field: "media", message: "Este vídeo ainda está sendo analisado. Aguarde ficar pronto." };
  if (!account || account.status === "disconnected") return { ok: false, field: "account", message: "Escolha uma conta conectada." };

  const caption = input.caption.trim().slice(0, 2200);
  const tags = extraHashtags(caption, normalizeHashtags(input.hashtags));

  // 3. já agendado exatamente assim? (pedido repetido / clique duplo depois do sucesso)
  const { data: same } = await supabase
    .from("publication_jobs")
    .select("id, campaign_id, status, scheduled_at")
    .eq("workspace_id", workspace.id)
    .eq("media_asset_id", media.id)
    .eq("social_account_id", account.id)
    .eq("scheduled_at", at.toString())
    .neq("status", "cancelled")
    .limit(1);
  if (same?.[0] && same[0].status !== "draft") {
    return { ok: true, jobId: same[0].id, campaignId: same[0].campaign_id!, scheduledAt: same[0].scheduled_at, note: "already_scheduled" };
  }

  // 4. retoma um rascunho desta mesma publicação rápida (falha anterior entre criar e ativar)
  let campaignId: string | null = null;
  let resumed = false;
  {
    const { data: drafts } = await supabase
      .from("campaigns")
      .select("id")
      .eq("workspace_id", workspace.id)
      .eq("created_by", user.id)
      .eq("status", "draft")
      .like("name", `${QUICK_PREFIX}%`)
      .eq("start_date", input.date)
      .eq("end_date", input.date)
      .contains("times", [input.time]);
    const ids = (drafts ?? []).map((d) => d.id);
    const [{ data: dTargets }, { data: dMedia }] = ids.length
      ? await Promise.all([
          supabase.from("campaign_targets").select("campaign_id, social_account_id").in("campaign_id", ids).eq("social_account_id", account.id),
          supabase.from("campaign_media").select("id, campaign_id, media_asset_id").in("campaign_id", ids).eq("media_asset_id", media.id),
        ])
      : [{ data: [] as { campaign_id: string; social_account_id: string }[] }, { data: [] as { id: string; campaign_id: string; media_asset_id: string }[] }];
    const cm = (dMedia ?? []).find((m) => (dTargets ?? []).some((t) => t.campaign_id === m.campaign_id));
    if (cm) {
      campaignId = cm.campaign_id;
      resumed = true;
      await supabase.from("campaign_media").update({ caption_override: caption || null, hashtags_override: tags.length ? tags : null }).eq("id", cm.id);
    }
  }

  // 5. cria a campanha de 1 item (mesmas tabelas e permissões do assistente de campanhas)
  if (!campaignId) {
    const label = `${local.day.toString().padStart(2, "0")}/${local.month.toString().padStart(2, "0")} ${input.time}`;
    const { data: c, error } = await supabase
      .from("campaigns")
      .insert({
        workspace_id: workspace.id,
        created_by: user.id,
        name: `${QUICK_PREFIX} · ${media.name}`.slice(0, 100) + ` · ${label}`,
        mode: "mirrored",
        timezone: tz,
        weekdays: [local.dayOfWeek],
        times: [input.time],
        start_date: input.date,
        end_date: input.date,
        order_strategy: "upload",
        max_lateness_minutes: 120,
        caption: null,
        hashtags: [],
      })
      .select("id")
      .single();
    if (error || !c) return { ok: false, message: "Não foi possível preparar o agendamento (permissão de editor necessária)." };
    campaignId = c.id;
    const { error: tErr } = await supabase.from("campaign_targets").insert({ campaign_id: c.id, workspace_id: workspace.id, social_account_id: account.id, offset_minutes: 0 });
    const { error: mErr } = tErr
      ? { error: tErr }
      : await supabase.from("campaign_media").insert({ campaign_id: c.id, workspace_id: workspace.id, media_asset_id: media.id, position: 0, caption_override: caption || null, hashtags_override: tags.length ? tags : null });
    if (tErr || mErr) {
      // sem permissão de excluir campanhas: o rascunho incompleto é arquivado (não gera publicação)
      await supabase.rpc("set_campaign_status", { p_campaign: c.id, p_action: "archive" });
      return { ok: false, message: "Não foi possível preparar o agendamento. Tente de novo." };
    }
  }

  // 6. planeja e confere: exatamente 1 publicação, no horário pedido
  try {
    await planCampaign(supabase, campaignId, "replace");
  } catch {
    return { ok: false, retry: true, message: "Não foi possível montar o horário. Tente de novo; nada será duplicado." };
  }
  const { data: planned } = await supabase.from("publication_jobs").select("id, scheduled_at, status").eq("campaign_id", campaignId).neq("status", "cancelled");
  if (!planned?.length) return { ok: false, field: "media", message: "Este vídeo não é compatível com a conta escolhida (formato, duração ou tamanho)." };
  if (planned.length !== 1 || Date.parse(planned[0]!.scheduled_at) !== at.epochMilliseconds) {
    return { ok: false, retry: true, message: "O horário calculado não confere com o escolhido. Nada foi agendado; tente de novo." };
  }

  // 7. ativa com a ação de sempre (recalcula e ativa; o banco aplica as travas de horário)
  const act = await campaignStatusAction(input.slug, campaignId, "activate");
  if (!act.ok) return { ok: false, retry: true, message: `Preparado, mas não agendado: ${act.message ?? "tente de novo"}. Repetir não duplica nada.` };
  const { data: job } = await supabase.from("publication_jobs").select("id, scheduled_at, status").eq("campaign_id", campaignId).neq("status", "cancelled").single();
  if (!job || job.status !== "scheduled") return { ok: false, retry: true, message: "A publicação não ficou agendada. Confira na Lista antes de tentar de novo." };

  revalidatePath(`/w/${input.slug}/calendar`);
  revalidatePath(`/w/${input.slug}/queue`);
  revalidatePath(`/w/${input.slug}/overview`);
  return { ok: true, jobId: job.id, campaignId, scheduledAt: job.scheduled_at, note: resumed ? "resumed" : undefined };
}
