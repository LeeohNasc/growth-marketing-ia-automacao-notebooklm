/**
 * Analytics de conteúdo — cálculos puros (sem I/O) sobre métricas REAIS sincronizadas.
 *
 * Princípios:
 * - Métrica ausente é `null` ("Indisponível"), nunca zero. Somas informam quantos posts tinham o dado.
 * - Valores "da vida" (acumulados) e valores "no período" são coisas diferentes:
 *   no período = foto no fim − foto no início; sem foto no início (post antigo), o resultado do período
 *   desse post é desconhecido e o total do período é marcado como incompleto.
 * - Nada de curvas inventadas: o histórico só existe a partir das fotos diárias gravadas.
 */

export const CONTENT_METRICS = ["views", "reach", "likes", "comments", "shares", "saves", "engagement", "follows", "profile_views", "total_watch_ms"] as const;
export type ContentMetric = (typeof CONTENT_METRICS)[number];

export type PostLatest = {
  id: string;
  socialAccountId: string;
  platform: string;
  publishedAt: string; // ISO
  metricsUpdatedAt: string | null; // ISO
  engagementRate: number | null; // % (definição da plataforma/Zernio)
} & { [K in ContentMetric]: number | null };

export type Snapshot = { postId: string; day: string /* YYYY-MM-DD (UTC) */ } & { [K in ContentMetric]: number | null };

export type MetricTotal = { value: number | null; withData: number; withoutData: number };

/** Soma ignorando ausentes; `value` é null quando nenhum post tem o dado. */
export function sumMetric<T extends Partial<Record<ContentMetric, number | null>>>(rows: T[], metric: ContentMetric): MetricTotal {
  let value = 0;
  let withData = 0;
  for (const r of rows) {
    const v = r[metric];
    if (typeof v === "number" && Number.isFinite(v)) {
      value += v;
      withData += 1;
    }
  }
  return { value: withData ? value : null, withData, withoutData: rows.length - withData };
}

/** Variação percentual entre períodos comparáveis; null quando a base é ausente ou zero. */
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

const dayOf = (iso: string) => iso.slice(0, 10);

/**
 * Resultado de um post DENTRO de [fromDay, toDay] (dias UTC, inclusivos), a partir das fotos diárias.
 * - Base: a última foto ANTES de fromDay; se o post foi publicado no período, a base é 0.
 * - Fim: a última foto até toDay.
 * Retorna null (desconhecido) quando falta a base ou o fim.
 */
export function periodDelta(post: Pick<PostLatest, "id" | "publishedAt">, snapshots: Snapshot[], metric: ContentMetric, fromDay: string, toDay: string): number | null {
  const mine = snapshots.filter((s) => s.postId === post.id).sort((a, b) => a.day.localeCompare(b.day));
  const end = [...mine].reverse().find((s) => s.day <= toDay && typeof s[metric] === "number");
  if (!end) return null;
  const publishedInPeriod = dayOf(post.publishedAt) >= fromDay;
  let base: number | null = null;
  if (publishedInPeriod) base = 0;
  else {
    const before = [...mine].reverse().find((s) => s.day < fromDay && typeof s[metric] === "number");
    base = before ? (before[metric] as number) : null;
  }
  if (base === null) return null;
  return Math.max(0, (end[metric] as number) - base);
}

/** Total do período com indicação de cobertura (quantos posts tinham histórico suficiente). */
export function periodTotal(posts: PostLatest[], snapshots: Snapshot[], metric: ContentMetric, fromDay: string, toDay: string): MetricTotal {
  let value = 0;
  let withData = 0;
  for (const p of posts) {
    if (dayOf(p.publishedAt) > toDay) continue;
    const d = periodDelta(p, snapshots, metric, fromDay, toDay);
    if (d !== null) {
      value += d;
      withData += 1;
    }
  }
  const eligible = posts.filter((p) => dayOf(p.publishedAt) <= toDay).length;
  return { value: withData ? value : null, withData, withoutData: eligible - withData };
}

export type RankSort = "views" | "likes" | "comments" | "shares" | "engagement_rate" | "recent";

/**
 * Ordena posts por uma métrica (ausentes ao final). "recent" = visualizações ganhas nos últimos 7 dias
 * (requer fotos; sem histórico, o post fica sem valor e vai para o fim).
 */
export function rankPosts<P extends PostLatest>(posts: P[], sort: RankSort, ctx: { snapshots?: Snapshot[]; todayDay?: string } = {}): { post: P; value: number | null }[] {
  const key = (p: P): number | null => {
    if (sort === "engagement_rate") return p.engagementRate;
    if (sort === "recent") {
      if (!ctx.snapshots || !ctx.todayDay) return null;
      const from = addDays(ctx.todayDay, -6);
      return periodDelta(p, ctx.snapshots, "views", from, ctx.todayDay);
    }
    return p[sort];
  };
  return [...posts]
    .map((p) => ({ post: p, value: key(p) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return b.post.publishedAt.localeCompare(a.post.publishedAt);
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return b.value - a.value || b.post.publishedAt.localeCompare(a.post.publishedAt);
    });
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Faixas de "idade" do post no momento da última medição — compara vídeos de maturidade parecida. */
export const AGE_BUCKETS = [
  { key: "lt1d", label: "menos de 1 dia", maxHours: 24 },
  { key: "1to3d", label: "1 a 3 dias", maxHours: 72 },
  { key: "3to7d", label: "3 a 7 dias", maxHours: 168 },
  { key: "7to30d", label: "7 a 30 dias", maxHours: 720 },
  { key: "gt30d", label: "mais de 30 dias", maxHours: Infinity },
] as const;

export function ageBucket(p: Pick<PostLatest, "publishedAt" | "metricsUpdatedAt">): (typeof AGE_BUCKETS)[number]["key"] | null {
  if (!p.metricsUpdatedAt) return null;
  const hours = (Date.parse(p.metricsUpdatedAt) - Date.parse(p.publishedAt)) / 3_600_000;
  if (!Number.isFinite(hours) || hours < 0) return null;
  return AGE_BUCKETS.find((b) => hours < b.maxHours)!.key;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export type PerformanceLabel = "above" | "within" | "below" | "insufficient";
export const PERFORMANCE_RULE = {
  metric: "views" as const,
  minPeers: 5,
  above: 1.25,
  below: 0.8,
  description:
    "Compara as visualizações do vídeo com a MEDIANA das visualizações dos outros vídeos da MESMA conta e MESMA faixa de idade " +
    "(menos de 1 dia, 1–3 dias, 3–7 dias, 7–30 dias, mais de 30 dias, medida no momento da última sincronização). " +
    "Acima da média: ≥ 125% da mediana. Abaixo: ≤ 80%. Dentro: entre os dois. " +
    "Dados insuficientes: menos de 5 vídeos comparáveis, vídeo sem visualizações informadas ou sem data de medição.",
};

/** Indicador de desempenho (documentado em PERFORMANCE_RULE). */
export function performanceIndicator(post: PostLatest, all: PostLatest[]): { label: PerformanceLabel; ratio: number | null; peers: number; median: number | null } {
  const bucket = ageBucket(post);
  if (bucket === null || post.views === null) return { label: "insufficient", ratio: null, peers: 0, median: null };
  const peers = all.filter((p) => p.id !== post.id && p.socialAccountId === post.socialAccountId && p.views !== null && ageBucket(p) === bucket);
  const med = median(peers.map((p) => p.views as number));
  if (peers.length < PERFORMANCE_RULE.minPeers || med === null || med === 0) return { label: "insufficient", ratio: null, peers: peers.length, median: med };
  const ratio = post.views / med;
  const label: PerformanceLabel = ratio >= PERFORMANCE_RULE.above ? "above" : ratio <= PERFORMANCE_RULE.below ? "below" : "within";
  return { label, ratio, peers: peers.length, median: med };
}
