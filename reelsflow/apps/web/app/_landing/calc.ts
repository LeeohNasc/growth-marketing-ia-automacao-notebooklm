/** Calculadora de tempo de publicação manual: vídeos/dia × minutos/vídeo × dias/mês. */
const fmt = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

function parse(raw: string, { min, max, step }: { min: number; max: number; step: number }): number | null {
  const s = raw.trim().replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  if (Math.abs(n / step - Math.round(n / step)) > 1e-9) return null;
  return n;
}

export const FIELDS = {
  videos: { min: 0, max: 1000, step: 1 },
  minutes: { min: 0, max: 1440, step: 0.5 },
  days: { min: 0, max: 31, step: 1 },
} as const;

export const INVALID = "Preencha os campos com valores válidos.";

/** Retorna o texto do resultado (ex.: "5 horas por mês") ou null se algum campo for inválido. */
export function manualPublishingTime(videos: string, minutes: string, days: string): string | null {
  const v = parse(videos, FIELDS.videos);
  const m = parse(minutes, FIELDS.minutes);
  const d = parse(days, FIELDS.days);
  if (v === null || m === null || d === null) return null;
  const total = v * m * d;
  if (total < 60) {
    const text = fmt.format(total);
    return `${text} ${text === "1" ? "minuto" : "minutos"} por mês`;
  }
  const text = fmt.format(total / 60);
  return `${text} ${text === "1" ? "hora" : "horas"} por mês`;
}
