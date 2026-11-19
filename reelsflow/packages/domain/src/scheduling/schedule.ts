import { Temporal } from "temporal-polyfill";
import { z } from "zod";
import { isValidTimezone } from "../validators";

/**
 * Regra de horários: datas locais no fuso informado. Dias da semana em ISO
 * (1 = segunda … 7 = domingo).
 */
export type ScheduleRule = {
  timezone: string;
  weekdays: number[];
  times: string[]; // "HH:MM"
  startDate: string; // "YYYY-MM-DD"
  endDate?: string | null;
};

export type Slot = {
  localDate: string;
  localTime: string;
  /** Instante UTC (ISO). */
  scheduledAt: string;
  /** true quando o horário não existia (avanço do relógio) e foi deslocado. */
  dstAdjusted: boolean;
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const scheduleRuleSchema = z
  .object({
    timezone: z.string().refine(isValidTimezone, { message: "Fuso horário inválido." }),
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1, { message: "Escolha ao menos um dia da semana." })
      .transform((d) => [...new Set(d)].sort()),
    times: z
      .array(z.string().regex(TIME_RE, { message: "Horário inválido (use HH:MM)." }))
      .min(1, { message: "Informe ao menos um horário." })
      .max(24, { message: "Máximo de 24 horários por dia." })
      .transform((t) => [...new Set(t)].sort()),
    startDate: z.string().regex(DATE_RE, { message: "Data inicial inválida." }),
    endDate: z.string().regex(DATE_RE).nullish(),
  })
  .refine((r) => !r.endDate || r.endDate >= r.startDate, { message: "A data final deve ser igual ou posterior à inicial.", path: ["endDate"] });

/** Converte data+hora local em instante, com política de DST explícita. */
export function localToInstant(localDate: string, localTime: string, timezone: string): { instant: Temporal.Instant; dstAdjusted: boolean } {
  const date = Temporal.PlainDate.from(localDate);
  const [h, m] = localTime.split(":").map(Number) as [number, number];
  // "compatible": horário inexistente → avança; ambíguo → primeira ocorrência.
  const zdt = Temporal.ZonedDateTime.from(
    { timeZone: timezone, year: date.year, month: date.month, day: date.day, hour: h, minute: m },
    { disambiguation: "compatible" },
  );
  const dstAdjusted = zdt.hour !== h || zdt.minute !== m || !zdt.toPlainDate().equals(date);
  return { instant: zdt.toInstant(), dstAdjusted };
}

export type SlotOptions = {
  /** Slots com instante <= notBefore são descartados (bloqueio de passado). */
  notBefore: Date;
  /** Para após gerar esta quantidade. */
  limit: number;
  /** Proteção contra regras sem fim: no máximo N dias percorridos. */
  maxDays?: number;
};

/** Gera slots em ordem cronológica a partir da regra. Função pura. */
export function generateSlots(rule: ScheduleRule, opts: SlotOptions): Slot[] {
  const out: Slot[] = [];
  if (opts.limit <= 0) return out;
  const notBefore = Temporal.Instant.fromEpochMilliseconds(opts.notBefore.getTime());
  const weekdays = new Set(rule.weekdays);
  const times = [...new Set(rule.times)].sort();
  const end = rule.endDate ? Temporal.PlainDate.from(rule.endDate) : null;
  const maxDays = opts.maxDays ?? 3660;

  // Começa no maior entre a data inicial e "hoje" no fuso da regra.
  const today = notBefore.toZonedDateTimeISO(rule.timezone).toPlainDate();
  let day = Temporal.PlainDate.from(rule.startDate);
  if (Temporal.PlainDate.compare(day, today) < 0) day = today;

  for (let i = 0; i < maxDays && out.length < opts.limit; i++, day = day.add({ days: 1 })) {
    if (end && Temporal.PlainDate.compare(day, end) > 0) break;
    if (!weekdays.has(day.dayOfWeek)) continue;
    for (const t of times) {
      const { instant, dstAdjusted } = localToInstant(day.toString(), t, rule.timezone);
      if (Temporal.Instant.compare(instant, notBefore) <= 0) continue;
      out.push({ localDate: day.toString(), localTime: t, scheduledAt: instant.toString(), dstAdjusted });
      if (out.length >= opts.limit) break;
    }
  }
  // Ordem cronológica estrita (DST pode inverter horários vizinhos).
  return out.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

/** Data/hora local de um instante (para exibir e para reagendar mantendo o fuso). */
export function instantToLocal(iso: string, timezone: string): { localDate: string; localTime: string } {
  const z = Temporal.Instant.from(iso).toZonedDateTimeISO(timezone);
  return { localDate: z.toPlainDate().toString(), localTime: `${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")}` };
}

export const WEEKDAY_LABELS: Record<number, string> = { 1: "Seg", 2: "Ter", 3: "Qua", 4: "Qui", 5: "Sex", 6: "Sáb", 7: "Dom" };
