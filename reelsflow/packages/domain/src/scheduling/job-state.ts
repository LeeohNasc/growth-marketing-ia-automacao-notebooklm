/**
 * Máquina de estados das publicações. A MESMA tabela é imposta no banco pelo
 * trigger `app.guard_job_transition` (supabase/migrations) — mantenha ambas
 * sincronizadas (há teste que compara).
 */
export const JOB_STATUSES = [
  "draft",
  "scheduled",
  "queued",
  "preparing",
  "uploading",
  "processing_remote",
  "publishing",
  "published",
  "failed_retryable",
  "failed_permanent",
  "uncertain",
  "needs_review",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const IN_FLIGHT: JobStatus[] = ["preparing", "uploading", "processing_remote", "publishing"];

export const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  draft: ["scheduled", "cancelled"],
  scheduled: ["queued", "needs_review", "cancelled", "draft"],
  queued: ["preparing", "scheduled", "needs_review", "cancelled"],
  preparing: ["uploading", "processing_remote", "publishing", "published", "failed_retryable", "failed_permanent", "uncertain", "queued"],
  uploading: ["processing_remote", "publishing", "published", "failed_retryable", "failed_permanent", "uncertain"],
  processing_remote: ["publishing", "published", "failed_retryable", "failed_permanent", "uncertain"],
  publishing: ["published", "failed_retryable", "failed_permanent", "uncertain"],
  published: [],
  failed_retryable: ["preparing", "scheduled", "needs_review", "failed_permanent", "cancelled"],
  failed_permanent: ["scheduled", "cancelled"],
  uncertain: ["published", "failed_retryable", "needs_review", "failed_permanent"],
  needs_review: ["scheduled", "cancelled", "published"],
  cancelled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return from === to || JOB_TRANSITIONS[from].includes(to);
}

export const TERMINAL_STATUSES: JobStatus[] = ["published", "cancelled"];
export const IN_FLIGHT_STATUSES = IN_FLIGHT;
/** Estados em que o usuário pode editar/reagendar/cancelar. */
export const EDITABLE_STATUSES: JobStatus[] = ["draft", "scheduled", "needs_review", "failed_permanent", "failed_retryable"];

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  draft: "Rascunho",
  scheduled: "Agendado",
  queued: "Aguardando processamento",
  preparing: "Em preparação",
  uploading: "Enviando",
  processing_remote: "Processando na plataforma",
  publishing: "Publicando",
  published: "Publicado",
  failed_retryable: "Falha temporária",
  failed_permanent: "Falha permanente",
  uncertain: "Estado incerto",
  needs_review: "Requer revisão",
  cancelled: "Cancelado",
};

export type StatusTone = "neutral" | "progress" | "success" | "warning" | "danger";
export const JOB_STATUS_TONE: Record<JobStatus, StatusTone> = {
  draft: "neutral",
  scheduled: "neutral",
  queued: "progress",
  preparing: "progress",
  uploading: "progress",
  processing_remote: "progress",
  publishing: "progress",
  published: "success",
  failed_retryable: "warning",
  failed_permanent: "danger",
  uncertain: "warning",
  needs_review: "warning",
  cancelled: "neutral",
};

/** Política de retry de publicação: backoff exponencial com jitter; Retry-After tem precedência. */
export function publicationBackoffSeconds(attempt: number, opts: { retryAfterSeconds?: number | null; random?: () => number } = {}): number {
  if (opts.retryAfterSeconds && opts.retryAfterSeconds > 0) return Math.min(24 * 3600, Math.ceil(opts.retryAfterSeconds));
  const base = Math.min(3600, 60 * 2 ** Math.max(0, attempt - 1));
  const r = opts.random ?? Math.random;
  return Math.round(base * (0.8 + r() * 0.4));
}

/**
 * Reconciliação de publicações "incertas" (o pedido pode ter chegado à plataforma, mas a resposta
 * se perdeu). A Zernio e a Meta podem segurar um post por horas (fila/limites da rede), então
 * mandar para revisão cedo demais leva o usuário a republicar à mão — e duplicar.
 *  - consultas espaçadas: 30 s, 1, 2, 4, 8, 16, 32 min e depois a cada 1 h;
 *  - revisão humana só depois de ~24 h sem confirmação (RECONCILE_MAX_ATTEMPTS consultas).
 */
export const RECONCILE_MAX_ATTEMPTS = 30;
export function reconcileDelaySeconds(attemptsDone: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attemptsDone));
}
/** Tempo total aproximado (s) até a revisão humana. */
export function reconcileWindowSeconds(maxAttempts = RECONCILE_MAX_ATTEMPTS): number {
  let s = 0;
  for (let i = 0; i < maxAttempts - 1; i++) s += reconcileDelaySeconds(i + 1);
  return s;
}
