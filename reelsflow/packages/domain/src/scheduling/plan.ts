import { Temporal } from "temporal-polyfill";
import type { Compatibility, Platform } from "../media";
import { generateSlots, type ScheduleRule } from "./schedule";

export const SOCIAL_PLATFORMS = ["instagram", "facebook", "tiktok", "youtube", "mock"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const SOCIAL_PLATFORM_LABELS: Record<SocialPlatform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  youtube: "YouTube",
  mock: "Simulada",
};

/** Qual verificação de compatibilidade se aplica a cada rede (mock: nenhuma). */
export const COMPAT_KEY: Record<SocialPlatform, Platform | null> = {
  instagram: "instagram_reels",
  facebook: "facebook_reels",
  tiktok: "tiktok",
  youtube: "youtube_shorts",
  mock: null,
};

export type DistributionMode = "mirrored" | "independent";
export const MODE_LABELS: Record<DistributionMode, string> = {
  mirrored: "Espelhado (mesmo vídeo em todas as redes)",
  independent: "Filas independentes por rede",
};

export type PlanTarget = {
  targetId: string;
  accountId: string;
  platform: SocialPlatform;
  /** Como a conta foi conectada: imagens só são publicadas por contas via Zernio (ou simuladas). */
  provider?: "native" | "zernio";
  /** Modo independente: regra própria; espelhado: ignorado (usa a da campanha). */
  rule?: ScheduleRule;
  offsetMinutes: number;
};

export type PlanMedia = {
  campaignMediaId: string;
  mediaId: string;
  name: string;
  compatibility: Compatibility | null;
  /** Modo independente: a qual alvo este item pertence. */
  targetId?: string | null;
};

export type PlannedJob = {
  campaignMediaId: string;
  mediaId: string;
  targetId: string;
  accountId: string;
  localDate: string;
  localTime: string;
  timezone: string;
  scheduledAt: string;
  dstAdjusted: boolean;
  postGroupKey: string | null;
};

export type SkippedItem = { mediaId: string; name: string; targetId: string; reason: "incompatible" | "no_slot" };

export type PlanInput = {
  mode: DistributionMode;
  rule: ScheduleRule;
  targets: PlanTarget[];
  media: PlanMedia[]; // já ordenados
  notBefore: Date;
  /** Para anexar a uma campanha existente: só gerar slots depois destes instantes. */
  notBeforeByTarget?: Record<string, Date>;
  maxJobs?: number;
};

export type Plan = { jobs: PlannedJob[]; skipped: SkippedItem[]; truncated: boolean };

export function isCompatible(item: PlanMedia, platform: SocialPlatform, provider: "native" | "zernio" = "native"): boolean {
  // Imagem (ex.: Card Editorial): os conectores diretos só publicam Reels (vídeo).
  if ((item.compatibility as { kind?: string } | null)?.kind === "image" && platform !== "mock" && provider !== "zernio") return false;
  const key = COMPAT_KEY[platform];
  if (!key) return true;
  const status = item.compatibility?.platforms?.[key]?.status;
  return status !== "error";
}

function shift(iso: string, minutes: number, timezone: string) {
  if (!minutes) return null;
  const z = Temporal.Instant.from(iso).add({ minutes }).toZonedDateTimeISO(timezone);
  return {
    scheduledAt: z.toInstant().toString(),
    localDate: z.toPlainDate().toString(),
    localTime: `${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")}`,
  };
}

const later = (a: Date, b?: Date) => (b && b.getTime() > a.getTime() ? b : a);

/**
 * Gera o plano de publicações. Função pura e determinística: mesmas entradas →
 * mesmo plano. Vídeos incompatíveis com uma rede são pulados naquela rede e
 * listados em `skipped` (nunca silenciosamente).
 */
export function buildPlan(input: PlanInput): Plan {
  const maxJobs = input.maxJobs ?? 5000;
  const jobs: PlannedJob[] = [];
  const skipped: SkippedItem[] = [];

  if (input.mode === "mirrored") {
    const notBefore = input.targets.reduce((acc, t) => later(acc, input.notBeforeByTarget?.[t.targetId]), input.notBefore);
    const slots = generateSlots(input.rule, { notBefore, limit: input.media.length });
    input.media.forEach((item, i) => {
      const slot = slots[i];
      for (const t of input.targets) {
        if (!slot) {
          skipped.push({ mediaId: item.mediaId, name: item.name, targetId: t.targetId, reason: "no_slot" });
          continue;
        }
        if (!isCompatible(item, t.platform, t.provider)) {
          skipped.push({ mediaId: item.mediaId, name: item.name, targetId: t.targetId, reason: "incompatible" });
          continue;
        }
        const s = shift(slot.scheduledAt, t.offsetMinutes, input.rule.timezone);
        jobs.push({
          campaignMediaId: item.campaignMediaId,
          mediaId: item.mediaId,
          targetId: t.targetId,
          accountId: t.accountId,
          localDate: s?.localDate ?? slot.localDate,
          localTime: s?.localTime ?? slot.localTime,
          timezone: input.rule.timezone,
          scheduledAt: s?.scheduledAt ?? slot.scheduledAt,
          dstAdjusted: slot.dstAdjusted,
          postGroupKey: `${slot.scheduledAt}`,
        });
      }
    });
  } else {
    for (const t of input.targets) {
      const rule = t.rule ?? input.rule;
      const mine = input.media.filter((m) => m.targetId === t.targetId);
      const usable: PlanMedia[] = [];
      for (const m of mine) {
        if (isCompatible(m, t.platform, t.provider)) usable.push(m);
        else skipped.push({ mediaId: m.mediaId, name: m.name, targetId: t.targetId, reason: "incompatible" });
      }
      const slots = generateSlots(rule, { notBefore: later(input.notBefore, input.notBeforeByTarget?.[t.targetId]), limit: usable.length });
      usable.forEach((m, i) => {
        const slot = slots[i];
        if (!slot) {
          skipped.push({ mediaId: m.mediaId, name: m.name, targetId: t.targetId, reason: "no_slot" });
          return;
        }
        const s = shift(slot.scheduledAt, t.offsetMinutes, rule.timezone);
        jobs.push({
          campaignMediaId: m.campaignMediaId,
          mediaId: m.mediaId,
          targetId: t.targetId,
          accountId: t.accountId,
          localDate: s?.localDate ?? slot.localDate,
          localTime: s?.localTime ?? slot.localTime,
          timezone: rule.timezone,
          scheduledAt: s?.scheduledAt ?? slot.scheduledAt,
          dstAdjusted: slot.dstAdjusted,
          postGroupKey: null,
        });
      });
    }
  }

  jobs.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.targetId.localeCompare(b.targetId));
  const truncated = jobs.length > maxJobs;
  return { jobs: truncated ? jobs.slice(0, maxJobs) : jobs, skipped, truncated };
}

export type ScheduledRef = { id: string; accountId: string; scheduledAt: string };
export type Conflict = { a: string; b: string; accountId: string; minutesApart: number };

/** Publicações da mesma conta mais próximas que o espaçamento mínimo. */
export function detectConflicts(items: ScheduledRef[], minSpacingMinutes: number): Conflict[] {
  const byAccount = new Map<string, ScheduledRef[]>();
  for (const i of items) byAccount.set(i.accountId, [...(byAccount.get(i.accountId) ?? []), i]);
  const out: Conflict[] = [];
  for (const [accountId, list] of byAccount) {
    list.sort((x, y) => x.scheduledAt.localeCompare(y.scheduledAt));
    for (let k = 1; k < list.length; k++) {
      const minutes = (Date.parse(list[k]!.scheduledAt) - Date.parse(list[k - 1]!.scheduledAt)) / 60000;
      if (minutes < minSpacingMinutes) out.push({ a: list[k - 1]!.id, b: list[k]!.id, accountId, minutesApart: Math.round(minutes) });
    }
  }
  return out;
}
