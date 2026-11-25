import { extraHashtags, normalizeHashtags, scheduleRuleSchema, timezoneSchema } from "@reelsflow/domain";
import { z } from "zod";

/** Lê os campos de ScheduleFields/ContentFields de um FormData. */
export function readScheduleForm(formData: FormData) {
  const caption = String(formData.get("caption") ?? "").trim();
  return {
    timezone: String(formData.get("timezone") ?? ""),
    weekdays: formData.getAll("weekdays").map(Number),
    times: formData.getAll("times").map(String),
    orderStrategy: String(formData.get("order_strategy") ?? "upload"),
    maxLatenessMinutes: Number(formData.get("max_lateness_minutes") ?? 120),
    caption,
    // Hashtags já escritas na legenda não são repetidas no campo separado.
    hashtags: extraHashtags(caption, normalizeHashtags(String(formData.get("hashtags") ?? ""))),
  };
}

export const templateSchema = z.object({
  name: z.string().trim().min(1, { message: "Informe um nome." }).max(80),
  mode: z.enum(["mirrored", "independent"]),
  timezone: timezoneSchema,
  weekdays: z.array(z.number().int().min(1).max(7)).min(1, { message: "Escolha ao menos um dia da semana." }),
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).min(1, { message: "Informe ao menos um horário." }).max(24),
  orderStrategy: z.enum(["upload", "oldest", "newest", "manual", "random"]),
  maxLatenessMinutes: z.number().int().min(5).max(10080),
  caption: z.string().max(2200),
  hashtags: z.array(z.string()).max(30),
});

export { scheduleRuleSchema };
