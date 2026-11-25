"use server";
import { revalidatePath } from "next/cache";
import { COMPAT_KEY, localToInstant, type Compatibility, type SocialPlatform } from "@reelsflow/domain";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

type Res = { ok: boolean; message?: string; conflict?: boolean; count?: number };

const revalidate = (slug: string) => {
  revalidatePath(`/w/${slug}/queue`);
  revalidatePath(`/w/${slug}/calendar`);
  revalidatePath(`/w/${slug}/overview`);
};

const RPC_ERRORS: [string, string][] = [
  ["too close", "Esta publicação agendada está no horário de saída (ou ele já passou) e não pode mais ser alterada."],
  ["cannot be rescheduled", "Esta publicação está em andamento ou já foi concluída."],
  ["must be in the future", "Escolha um horário no futuro."],
];
const rpcMessage = (m: string) => RPC_ERRORS.find(([k]) => m.includes(k))?.[1] ?? "Não foi possível concluir.";

/**
 * Reagenda validando antes de salvar: horário futuro, elegibilidade da conta e
 * do vídeo, e conflito de espaçamento com outras publicações da mesma conta.
 * Conflito exige confirmação (`force`).
 */
export async function rescheduleJobAction(slug: string, jobId: string, localDate: string, localTime: string, force = false): Promise<Res> {
  const { workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data: job } = await supabase.from("publication_jobs").select("*").eq("id", jobId).eq("workspace_id", workspace.id).maybeSingle();
  if (!job) return { ok: false, message: "Publicação não encontrada." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) return { ok: false, message: "Data ou horário inválido." };

  const { instant } = localToInstant(localDate, localTime, job.timezone);
  const at = new Date(Number(instant.epochMilliseconds));
  if (at.getTime() <= Date.now() + 2 * 60_000) return { ok: false, message: "Escolha um horário pelo menos 2 minutos no futuro." };

  const [{ data: acc }, { data: media }] = await Promise.all([
    supabase.from("social_accounts").select("platform, status, min_spacing_minutes, display_name").eq("id", job.social_account_id ?? "").maybeSingle(),
    supabase.from("media_assets").select("status, deleted_at, compatibility").eq("id", job.media_asset_id ?? "").maybeSingle(),
  ]);
  if (!acc) return { ok: false, message: "A conta desta publicação foi removida." };
  if (!media || media.deleted_at || media.status !== "ready") return { ok: false, message: "O vídeo foi excluído ou não está pronto." };
  const key = COMPAT_KEY[acc.platform as SocialPlatform];
  if (key && (media.compatibility as Compatibility | null)?.platforms?.[key]?.status === "error") {
    return { ok: false, message: "O vídeo é incompatível com esta rede." };
  }

  if (!force && acc.min_spacing_minutes > 0) {
    const w = acc.min_spacing_minutes * 60_000;
    const { data: near } = await supabase
      .from("publication_jobs")
      .select("id, scheduled_at")
      .eq("social_account_id", job.social_account_id!)
      .neq("id", jobId)
      .not("status", "in", "(cancelled,failed_permanent)")
      .gt("scheduled_at", new Date(at.getTime() - w).toISOString())
      .lt("scheduled_at", new Date(at.getTime() + w).toISOString())
      .limit(1);
    if (near?.length) {
      return {
        ok: false,
        conflict: true,
        message: `Há outra publicação em ${acc.display_name} a menos de ${acc.min_spacing_minutes} min deste horário. O sistema respeitará o espaçamento e poderá atrasar uma delas. Salvar mesmo assim?`,
      };
    }
  }

  const { error } = await supabase.rpc("reschedule_job", { p_job: jobId, p_at: at.toISOString() });
  revalidate(slug);
  if (error) return { ok: false, message: rpcMessage(error.message) };
  return { ok: true, message: acc.status !== "active" ? "Reagendado. Atenção: a conta precisa ser reconectada para publicar." : "Reagendado." };
}

export async function cancelJobsAction(slug: string, ids: string[]): Promise<Res> {
  await requireWorkspace(slug);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cancel_jobs", { p_ids: ids.slice(0, 500) });
  revalidate(slug);
  if (error) return { ok: false, message: "Sem permissão para cancelar." };
  return { ok: true, count: data ?? 0, message: `${data ?? 0} publicação(ões) cancelada(s). Em andamento ou concluídas não são alteradas.` };
}

/** "Tentar novamente": reagenda falhas/revisões para daqui a 3 minutos (zera as tentativas). */
export async function retryJobsAction(slug: string, ids: string[]): Promise<Res> {
  const { workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data: jobs } = await supabase
    .from("publication_jobs")
    .select("id")
    .in("id", ids.slice(0, 200))
    .eq("workspace_id", workspace.id)
    .in("status", ["failed_permanent", "failed_retryable", "needs_review"]);
  const at = new Date(Date.now() + 3 * 60_000).toISOString();
  let n = 0;
  for (const j of jobs ?? []) {
    const { error } = await supabase.rpc("reschedule_job", { p_job: j.id, p_at: at });
    if (!error) n++;
  }
  revalidate(slug);
  return { ok: true, count: n, message: `${n} publicação(ões) reagendada(s) para daqui a 3 minutos.` };
}

export async function confirmPublishedAction(slug: string, id: string, permalink: string): Promise<Res> {
  await requireWorkspace(slug);
  const supabase = await createClient();
  const link = permalink.trim();
  if (link && !/^https:\/\//.test(link)) return { ok: false, message: "Informe um link https válido ou deixe em branco." };
  const { error } = await supabase.rpc("confirm_job_published", { p_job: id, p_permalink: link });
  revalidate(slug);
  return error ? { ok: false, message: "Só é possível confirmar publicações em revisão." } : { ok: true, message: "Marcada como publicada." };
}

export async function updateJobCaptionAction(slug: string, id: string, caption: string): Promise<Res> {
  await requireWorkspace(slug);
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_job_caption", { p_job: id, p_caption: caption });
  revalidate(slug);
  return error ? { ok: false, message: "Esta publicação não pode mais ser editada." } : { ok: true, message: "Legenda desta publicação atualizada." };
}

export async function setQueuePausedAction(slug: string, paused: boolean): Promise<Res> {
  const { workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data, error } = await supabase.from("workspaces").update({ queue_paused: paused }).eq("id", workspace.id).select("id");
  revalidate(slug);
  return error || !data?.length ? { ok: false, message: "Somente administradores podem pausar a fila." } : { ok: true };
}

export type JobDetails = {
  id: string;
  status: string;
  scheduledAt: string;
  publishedAt: string | null;
  timezone: string;
  localDate: string;
  localTime: string;
  mediaName: string | null;
  thumbUrl: string | null;
  accountName: string | null;
  platform: string | null;
  campaignId: string | null;
  campaignName: string | null;
  attemptCount: number;
  maxAttempts: number;
  lastErrorClass: string | null;
  lastErrorMessage: string | null;
  reviewReason: string | null;
  captionOverride: string | null;
  effective: { caption?: string; sources?: Record<string, string> } | null;
  pinned: boolean;
  external: { externalId: string | null; permalink: string | null; source: string } | null;
  attempts: { no: number; kind: string; outcome: string | null; startedAt: string; errorClass: string | null; errorMessage: string | null; retryAfter: number | null }[];
};

export async function getJobDetailsAction(slug: string, id: string): Promise<JobDetails | null> {
  const { workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data: j } = await supabase.from("publication_jobs").select("*").eq("id", id).eq("workspace_id", workspace.id).maybeSingle();
  if (!j) return null;
  const [{ data: m }, { data: a }, { data: c }, { data: ext }, { data: att }] = await Promise.all([
    supabase.from("media_assets").select("name, thumbnail_path").eq("id", j.media_asset_id ?? "").maybeSingle(),
    supabase.from("social_accounts").select("display_name, platform").eq("id", j.social_account_id ?? "").maybeSingle(),
    supabase.from("campaigns").select("id, name").eq("id", j.campaign_id ?? "").maybeSingle(),
    supabase.from("external_publications").select("external_id, permalink, source").eq("job_id", id).maybeSingle(),
    supabase.from("publication_attempts").select("*").eq("job_id", id).order("id"),
  ]);
  let thumbUrl: string | null = null;
  if (m?.thumbnail_path) thumbUrl = (await supabase.storage.from("media").createSignedUrl(m.thumbnail_path, 600)).data?.signedUrl ?? null;
  return {
    id: j.id,
    status: j.status,
    scheduledAt: j.scheduled_at,
    publishedAt: j.published_at,
    timezone: j.timezone,
    localDate: j.local_date,
    localTime: j.local_time.slice(0, 5),
    mediaName: m?.name ?? null,
    thumbUrl,
    accountName: a?.display_name ?? null,
    platform: a?.platform ?? null,
    campaignId: c?.id ?? null,
    campaignName: c?.name ?? null,
    attemptCount: j.attempt_count,
    maxAttempts: j.max_attempts,
    lastErrorClass: j.last_error_class,
    lastErrorMessage: j.last_error_message,
    reviewReason: j.review_reason,
    captionOverride: j.caption_override,
    effective: j.effective_config as JobDetails["effective"],
    pinned: j.pinned,
    external: ext ? { externalId: ext.external_id, permalink: ext.permalink, source: ext.source } : null,
    attempts: (att ?? []).map((x) => ({
      no: x.attempt_no,
      kind: x.kind,
      outcome: x.outcome,
      startedAt: x.started_at,
      errorClass: x.error_class,
      errorMessage: x.error_message,
      retryAfter: x.retry_after_seconds,
    })),
  };
}
