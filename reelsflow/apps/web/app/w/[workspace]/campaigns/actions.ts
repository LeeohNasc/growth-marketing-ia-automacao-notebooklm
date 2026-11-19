"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fieldErrors, normalizeHashtags, scheduleRuleSchema } from "@reelsflow/domain";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { readScheduleForm } from "@/lib/forms";
import { planCampaign } from "@/lib/planning";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const campaignSchema = z.object({
  name: z.string().trim().min(1, { message: "Informe um nome." }).max(120),
  mode: z.enum(["mirrored", "independent"]),
  orderStrategy: z.enum(["upload", "oldest", "newest", "manual", "random"]),
  maxLatenessMinutes: z.number().int().min(5).max(10080),
  caption: z.string().max(2200),
  hashtags: z.array(z.string()).max(30),
});

function readCampaign(formData: FormData) {
  const f = readScheduleForm(formData);
  const startDate = String(formData.get("start_date") ?? "");
  const endDate = String(formData.get("end_date") ?? "") || null;
  const rule = scheduleRuleSchema.safeParse({ timezone: f.timezone, weekdays: f.weekdays, times: f.times, startDate, endDate });
  const base = campaignSchema.safeParse({ ...f, name: formData.get("name"), mode: formData.get("mode") });
  const errors: Record<string, string> = {};
  if (!rule.success) Object.assign(errors, fieldErrors(rule.error));
  if (!base.success) Object.assign(errors, fieldErrors(base.error));
  if (!DATE.test(startDate)) errors.startDate = "Informe a data inicial.";
  return { ok: rule.success && base.success && !Object.keys(errors).length, errors, rule: rule.data, base: base.data };
}

function planMessage(r: { inserted: number; skipped: { reason: string }[]; truncated: boolean }) {
  const incompatible = r.skipped.filter((s) => s.reason === "incompatible").length;
  const noSlot = r.skipped.filter((s) => s.reason === "no_slot").length;
  return [
    `${r.inserted} publicação(ões) planejada(s).`,
    incompatible ? `${incompatible} combinação(ões) vídeo/rede pulada(s) por incompatibilidade.` : "",
    noSlot ? `${noSlot} sem horário disponível até a data final.` : "",
    r.truncated ? "Plano limitado a 5.000 publicações." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export async function createCampaignAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const slug = String(formData.get("slug"));
  const { workspace, user } = await requireWorkspace(slug);
  const parsed = readCampaign(formData);
  const accountIds = formData.getAll("accounts").map(String);
  const source = String(formData.get("source") ?? "videos");
  const collectionId = String(formData.get("collection") ?? "") || null;
  let mediaIds = formData.getAll("media").map(String);
  if (!parsed.ok || !parsed.rule || !parsed.base) return { fieldErrors: parsed.errors, message: "Revise os campos destacados." };
  if (!accountIds.length) return { fieldErrors: { accounts: "Escolha ao menos uma conta." }, message: "Revise os campos destacados." };

  const supabase = await createClient();
  if (source === "collection") {
    if (!collectionId) return { fieldErrors: { collection: "Escolha uma coleção." } };
    const { data } = await supabase.from("collection_items").select("media_asset_id").eq("collection_id", collectionId).order("position");
    mediaIds = (data ?? []).map((r) => r.media_asset_id);
  }
  if (!mediaIds.length && !(source === "collection" && formData.get("follow_collection") === "on")) {
    return { fieldErrors: { media: "Escolha ao menos um vídeo." }, message: "Revise os campos destacados." };
  }

  const { rule, base } = parsed;
  const { data: campaign, error } = await supabase
    .from("campaigns")
    .insert({
      workspace_id: workspace.id,
      created_by: user.id,
      template_id: String(formData.get("template") ?? "") || null,
      source_collection_id: source === "collection" && formData.get("follow_collection") === "on" ? collectionId : null,
      name: base.name,
      mode: base.mode,
      timezone: rule.timezone,
      weekdays: rule.weekdays,
      times: rule.times,
      start_date: rule.startDate,
      end_date: rule.endDate ?? null,
      order_strategy: base.orderStrategy,
      max_lateness_minutes: base.maxLatenessMinutes,
      caption: base.caption || null,
      hashtags: base.hashtags,
    })
    .select("id")
    .single();
  if (error || !campaign) return { message: "Não foi possível criar a campanha (permissão de editor necessária)." };

  const { data: targets, error: tErr } = await supabase
    .from("campaign_targets")
    .insert(accountIds.map((a) => ({ campaign_id: campaign.id, workspace_id: workspace.id, social_account_id: a, offset_minutes: Number(formData.get(`offset_${a}`) ?? 0) || 0 })))
    .select("id");
  if (tErr || !targets) return { message: "Conta inválida para este workspace." };

  const rows = base.mode === "independent"
    ? targets.flatMap((t) => mediaIds.map((m, i) => ({ campaign_id: campaign.id, workspace_id: workspace.id, media_asset_id: m, target_id: t.id, position: i })))
    : mediaIds.map((m, i) => ({ campaign_id: campaign.id, workspace_id: workspace.id, media_asset_id: m, position: i }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error: mErr } = await supabase.from("campaign_media").insert(rows.slice(i, i + 500));
    if (mErr) return { message: "Um dos vídeos não pertence a este workspace." };
  }

  const planned = await guard(() => planCampaign(supabase, campaign.id, "replace"));
  redirect(`/w/${slug}/campaigns/${campaign.id}?created=1${"ok" in planned && planned.ok === false ? "&plan_error=1" : ""}`);
}

export async function updateCampaignSettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const slug = String(formData.get("slug"));
  const id = String(formData.get("id"));
  const { workspace } = await requireWorkspace(slug);
  const parsed = readCampaign(formData);
  if (!parsed.ok || !parsed.rule || !parsed.base) return { fieldErrors: parsed.errors, message: "Revise os campos destacados." };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("campaigns")
    .update({
      name: parsed.base.name,
      timezone: parsed.rule.timezone,
      weekdays: parsed.rule.weekdays,
      times: parsed.rule.times,
      start_date: parsed.rule.startDate,
      end_date: parsed.rule.endDate ?? null,
      order_strategy: parsed.base.orderStrategy,
      max_lateness_minutes: parsed.base.maxLatenessMinutes,
      caption: parsed.base.caption || null,
      hashtags: parsed.base.hashtags,
    })
    .eq("id", id)
    .eq("workspace_id", workspace.id)
    .select("id");
  if (error || !data?.length) return { message: "Não foi possível salvar (campanha concluída/arquivada ou sem permissão)." };
  const r = await planCampaign(supabase, id, "replace");
  revalidatePath(`/w/${slug}/campaigns/${id}`);
  return { ok: true, message: `Configuração salva. ${planMessage(r)}` };
}

type Result = { ok: boolean; message?: string };

async function guard<T>(fn: () => Promise<T>): Promise<T | Result> {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Erro." };
  }
}

const STATUS_ERRORS: Record<string, string> = {
  "campaign has no targets": "Adicione ao menos uma conta.",
  "campaign has no planned publications": "Não há publicações planejadas. Adicione vídeos prontos e compatíveis.",
  "campaign has publications in progress": "Há publicações em andamento. Tente novamente em instantes.",
};

export async function campaignStatusAction(slug: string, id: string, action: "activate" | "pause" | "resume" | "archive"): Promise<Result> {
  await requireWorkspace(slug);
  const supabase = await createClient();
  if (action === "activate") {
    // Recalcula imediatamente antes de ativar: horários que passaram durante a revisão são refeitos.
    const r = await guard(() => planCampaign(supabase, id, "replace"));
    if ("ok" in r && r.ok === false) return r;
  }
  const { error } = await supabase.rpc("set_campaign_status", { p_campaign: id, p_action: action });
  revalidatePath(`/w/${slug}/campaigns/${id}`);
  if (error) {
    const key = Object.keys(STATUS_ERRORS).find((k) => error.message.includes(k));
    return { ok: false, message: key ? STATUS_ERRORS[key] : "Ação não permitida no estado atual." };
  }
  return { ok: true };
}

export async function replanAction(slug: string, id: string): Promise<Result> {
  await requireWorkspace(slug);
  const supabase = await createClient();
  const r = await guard(() => planCampaign(supabase, id, "replace"));
  revalidatePath(`/w/${slug}/campaigns/${id}`);
  return "inserted" in r ? { ok: true, message: planMessage(r) } : r;
}

export async function updateTargetAction(
  slug: string,
  campaignId: string,
  targetId: string,
  patch: { offset?: number; weekdays?: number[] | null; times?: string[] | null; caption?: string | null; enabled?: boolean },
): Promise<Result> {
  const { workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const update: { offset_minutes?: number; weekdays?: number[] | null; times?: string[] | null; caption_override?: string | null; enabled?: boolean } = {};
  if (patch.offset !== undefined) update.offset_minutes = Math.max(-720, Math.min(720, Math.round(patch.offset)));
  if (patch.weekdays !== undefined) update.weekdays = patch.weekdays?.length ? patch.weekdays : null;
  if (patch.times !== undefined) update.times = patch.times?.length ? patch.times.filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) : null;
  if (patch.caption !== undefined) update.caption_override = patch.caption?.trim() || null;
  if (patch.enabled !== undefined) update.enabled = patch.enabled;
  const { data, error } = await supabase.from("campaign_targets").update(update).eq("id", targetId).eq("workspace_id", workspace.id).select("id");
  if (error || !data?.length) return { ok: false, message: "Não foi possível salvar." };
  const r = await guard(() => planCampaign(supabase, campaignId, "replace"));
  revalidatePath(`/w/${slug}/campaigns/${campaignId}`);
  return "inserted" in r ? { ok: true, message: planMessage(r) } : r;
}

export async function removeCampaignMediaAction(slug: string, campaignId: string, campaignMediaIds: string[]): Promise<Result> {
  const { workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data: jobs } = await supabase.from("publication_jobs").select("id").in("campaign_media_id", campaignMediaIds).eq("workspace_id", workspace.id);
  if (jobs?.length) await supabase.rpc("cancel_jobs", { p_ids: jobs.map((j) => j.id) });
  const { error } = await supabase.from("campaign_media").delete().in("id", campaignMediaIds).eq("workspace_id", workspace.id);
  const r = await guard(() => planCampaign(supabase, campaignId, "replace"));
  revalidatePath(`/w/${slug}/campaigns/${campaignId}`);
  if (error) return { ok: false, message: "Não foi possível remover." };
  return "inserted" in r ? { ok: true, message: "Vídeo removido; publicações futuras canceladas e calendário recalculado." } : r;
}

export async function moveCampaignMediaAction(slug: string, campaignId: string, campaignMediaId: string, direction: -1 | 1): Promise<Result> {
  const { workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data: cm } = await supabase.from("campaign_media").select("id, target_id, position").eq("id", campaignMediaId).single();
  if (!cm) return { ok: false };
  let q = supabase.from("campaign_media").select("id, position").eq("campaign_id", campaignId).eq("workspace_id", workspace.id);
  q = cm.target_id ? q.eq("target_id", cm.target_id) : q.is("target_id", null);
  const { data: list } = await q.order("position").order("added_at");
  const order = (list ?? []).map((r) => r.id);
  const i = order.indexOf(campaignMediaId);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= order.length) return { ok: false };
  [order[i], order[j]] = [order[j]!, order[i]!];
  for (const [pos, rowId] of order.entries()) await supabase.from("campaign_media").update({ position: pos }).eq("id", rowId);
  const r = await guard(() => planCampaign(supabase, campaignId, "replace"));
  revalidatePath(`/w/${slug}/campaigns/${campaignId}`);
  return "inserted" in r ? { ok: true } : r;
}

export async function setMediaCaptionAction(slug: string, campaignId: string, campaignMediaId: string, caption: string, hashtags: string): Promise<Result> {
  const { workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const tags = normalizeHashtags(hashtags);
  const { data, error } = await supabase
    .from("campaign_media")
    .update({ caption_override: caption.trim().slice(0, 2200) || null, hashtags_override: tags.length ? tags : null })
    .eq("id", campaignMediaId)
    .eq("workspace_id", workspace.id)
    .select("id");
  revalidatePath(`/w/${slug}/campaigns/${campaignId}`);
  return error || !data?.length ? { ok: false, message: "Não foi possível salvar." } : { ok: true, message: "Exceção do vídeo salva." };
}

export async function addVideosAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const slug = String(formData.get("slug"));
  const campaignId = String(formData.get("campaign"));
  const { workspace } = await requireWorkspace(slug);
  const mediaIds = formData.getAll("media").map(String);
  if (!mediaIds.length) return { fieldErrors: { media: "Escolha ao menos um vídeo." } };
  const supabase = await createClient();
  const { data: c } = await supabase.from("campaigns").select("mode").eq("id", campaignId).single();
  const [{ data: targets }, { data: existing }] = await Promise.all([
    supabase.from("campaign_targets").select("id").eq("campaign_id", campaignId),
    supabase.from("campaign_media").select("media_asset_id, target_id, position").eq("campaign_id", campaignId),
  ]);
  let pos = Math.max(-1, ...(existing ?? []).map((e) => e.position)) + 1;
  const have = new Set((existing ?? []).map((e) => `${e.media_asset_id}:${e.target_id ?? ""}`));
  const rows: { campaign_id: string; workspace_id: string; media_asset_id: string; target_id?: string; position: number }[] = [];
  for (const m of mediaIds) {
    const targetIds = c?.mode === "independent" ? (targets ?? []).map((t) => t.id) : [null];
    for (const t of targetIds) {
      if (have.has(`${m}:${t ?? ""}`)) continue;
      rows.push({ campaign_id: campaignId, workspace_id: workspace.id, media_asset_id: m, ...(t ? { target_id: t } : {}), position: pos });
    }
    pos++;
  }
  if (rows.length) {
    const { error } = await supabase.from("campaign_media").insert(rows);
    if (error) return { message: "Não foi possível adicionar os vídeos." };
  }
  // Anexa ao fim da fila sem mexer no que já está agendado.
  await guard(() => planCampaign(supabase, campaignId, "append"));
  redirect(`/w/${slug}/campaigns/${campaignId}?added=${mediaIds.length}`);
}
