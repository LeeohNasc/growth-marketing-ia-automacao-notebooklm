import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { PERFORMANCE_RULE, SOCIAL_PLATFORM_LABELS, addDays, periodDelta, periodTotal, performanceIndicator, rankPosts, sumMetric, type RankSort } from "@reelsflow/domain";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ContentPost, Period, loadContentAnalytics } from "@/lib/content-analytics";
import { Metric, PerformanceBadge, TotalTile, fmtDateTime, fmtInt, fmtPct } from "./content-ui";

type Data = Awaited<ReturnType<typeof loadContentAnalytics>>;

export const postTitle = (p: ContentPost) => p.mediaName ?? (p.origin === "external" ? `Post publicado fora do ReelsFlow (${p.platformPostId.slice(-6)})` : `Post ${p.platformPostId.slice(-6)}`);

/** Visão geral: resultado NO período (diferença entre fotos diárias) e acumulado dos vídeos publicados no período. */
export function ContentOverview({ slug, tz, period, data }: { slug: string; tz: string; period: Period; data: Data }) {
  const gain = (m: "views" | "likes" | "comments" | "shares") => periodTotal(data.all, data.snapshots, m, period.fromDay, period.toDay);
  const life = (m: "views" | "likes" | "comments" | "shares") => sumMetric(data.inPeriod, m);
  const best = rankPosts(data.inPeriod, "views")[0];
  const updated = fmtDateTime(data.lastUpdate, tz);

  if (data.all.length === 0)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Desempenho dos conteúdos</CardTitle>
          <CardDescription>Visualizações, curtidas, comentários e compartilhamentos reais dos vídeos nas redes.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            Ainda não há métricas sincronizadas. Assim que a conta tiver permissão de métricas, o ReelsFlow passa a ler os resultados a cada 3 horas. Nenhum número é estimado enquanto isso.
          </p>
        </CardContent>
      </Card>
    );

  return (
    <div className="grid gap-6">
      <section aria-labelledby="gain-h" className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="gain-h" className="text-lg font-semibold">Resultado no período ({period.label})</h2>
          <p className="text-xs text-muted-foreground">Última atualização das métricas: {updated ?? "nunca"}</p>
        </div>
        <p className="text-sm text-muted-foreground">
          Quanto todos os vídeos ganharam dentro do período, inclusive os publicados antes dele. Calculado pela diferença entre as fotos diárias; vídeos sem foto anterior ao início ficam de fora (indicado abaixo).
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TotalTile label="Visualizações" total={gain("views")} />
          <TotalTile label="Curtidas" total={gain("likes")} />
          <TotalTile label="Comentários" total={gain("comments")} />
          <TotalTile label="Compartilhamentos" total={gain("shares")} />
        </div>
      </section>

      <section aria-labelledby="life-h" className="grid gap-3">
        <h2 id="life-h" className="text-lg font-semibold">Vídeos publicados no período · resultado acumulado</h2>
        <p className="text-sm text-muted-foreground">Total desde a publicação até a última atualização, só para os {data.inPeriod.length} vídeos publicados no período.</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TotalTile label="Visualizações" total={life("views")} />
          <TotalTile label="Curtidas" total={life("likes")} />
          <TotalTile label="Comentários" total={life("comments")} />
          <TotalTile label="Compartilhamentos" total={life("shares")} />
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Melhor vídeo do período</CardTitle>
          <CardDescription>Maior número de visualizações acumuladas entre os vídeos publicados no período.</CardDescription>
        </CardHeader>
        <CardContent>
          {best && best.value !== null ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Link href={`/w/${slug}/analytics/videos/${best.post.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                {postTitle(best.post)}
              </Link>
              <span className="tabular-nums">{fmtInt(best.value)} visualizações</span>
              <PerformanceBadge label={performanceIndicator(best.post, data.all).label} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Dados insuficientes: nenhum vídeo publicado no período tem visualizações informadas.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const SORTS: { key: RankSort | "period_views"; label: string }[] = [
  { key: "views", label: "Visualizações" },
  { key: "likes", label: "Curtidas" },
  { key: "comments", label: "Comentários" },
  { key: "shares", label: "Compartilhamentos" },
  { key: "engagement_rate", label: "Taxa de engajamento" },
  { key: "period_views", label: "Ganho no período" },
  { key: "recent", label: "Desempenho recente (7 dias)" },
];
const ORIGINS = [
  { key: "all", label: "Todos" },
  { key: "reelsflow", label: "Publicados pelo ReelsFlow" },
  { key: "external", label: "Publicados fora" },
] as const;

/** Ranking (e seletor da análise individual). */
export function RankingTab(props: { slug: string; tz: string; period: Period; data: Data; sort?: string; origin?: string; scope?: string; mode: "ranking" | "video"; periodQs: Record<string, string> }) {
  const { slug, tz, period, data, mode, periodQs } = props;
  const sort = SORTS.some((s) => s.key === props.sort) ? (props.sort as (typeof SORTS)[number]["key"]) : "views";
  const origin = ORIGINS.some((o) => o.key === props.origin) ? props.origin! : "all";
  // Ganho no período / recente: todos os vídeos (inclusive antigos). Demais: só os publicados no período (valor acumulado).
  const pool = (sort === "period_views" || sort === "recent" ? data.all : data.inPeriod).filter((p) => origin === "all" || p.origin === origin);
  const ranked =
    sort === "period_views"
      ? pool
          .map((p) => ({ post: p, value: periodDelta(p, data.snapshots, "views", period.fromDay, period.toDay) }))
          .sort((a, b) => (a.value === null ? 1 : b.value === null ? -1 : b.value - a.value))
      : rankPosts(pool, sort, { snapshots: data.snapshots, todayDay: period.toDay });
  const base = `/w/${slug}/analytics`;
  const href = (o: Record<string, string>) => `${base}?${new URLSearchParams({ ...periodQs, tab: mode, sort, origin, ...o }).toString()}`;
  const sortLabel = SORTS.find((s) => s.key === sort)!.label;
  const scopeText =
    sort === "period_views"
      ? `Visualizações ganhas entre ${period.fromDay.split("-").reverse().join("/")} e ${period.toDay.split("-").reverse().join("/")}, por todos os vídeos.`
      : sort === "recent"
        ? `Visualizações ganhas de ${addDays(period.toDay, -6).split("-").reverse().join("/")} a ${period.toDay.split("-").reverse().join("/")}, por todos os vídeos.`
        : `Resultado acumulado (desde a publicação) dos vídeos publicados no período (${period.label}).`;

  return (
    <div className="grid gap-4">
      {mode === "video" && <p className="text-sm text-muted-foreground">Escolha um vídeo para ver todas as métricas, o histórico diário e onde ele está na Biblioteca, no Calendário e na Campanha.</p>}
      <div className="grid gap-1 text-sm">
        <span id="sort-label" className="text-xs text-muted-foreground">Ordenar por</span>
        <div className="flex flex-wrap gap-1" role="group" aria-labelledby="sort-label">
          {SORTS.map((s) => (
            <Button key={s.key} asChild size="sm" variant={s.key === sort ? "secondary" : "ghost"} className="h-7">
              <Link href={href({ sort: s.key })} aria-current={s.key === sort}>
                {s.label}
              </Link>
            </Button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-1 text-sm" role="group" aria-label="Origem">
        {ORIGINS.map((o) => (
          <Button key={o.key} asChild size="sm" variant={o.key === origin ? "secondary" : "ghost"} className="h-7">
            <Link href={href({ origin: o.key })} aria-current={o.key === origin}>
              {o.label}
            </Link>
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{scopeText}</p>

      {ranked.length === 0 ? (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">Nenhum vídeo com métricas neste período e filtro.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[760px] text-sm">
            <caption className="sr-only">Ranking por {sortLabel}</caption>
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2">#</th>
                <th scope="col" className="px-3 py-2">Vídeo</th>
                <th scope="col" className="px-3 py-2">Publicado</th>
                {(sort === "period_views" || sort === "recent") && <th scope="col" className="px-3 py-2 text-right">{sortLabel}</th>}
                <th scope="col" className="px-3 py-2 text-right">Visualizações</th>
                <th scope="col" className="px-3 py-2 text-right">Curtidas</th>
                <th scope="col" className="px-3 py-2 text-right">Coment.</th>
                <th scope="col" className="px-3 py-2 text-right">Compart.</th>
                <th scope="col" className="px-3 py-2 text-right">Engaj.</th>
                <th scope="col" className="px-3 py-2">Indicador</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {ranked.slice(0, 100).map(({ post: p, value }, i) => (
                <tr key={p.id}>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">{i + 1}</td>
                  <td className="max-w-[18rem] px-3 py-2">
                    <Link href={`/w/${slug}/analytics/videos/${p.id}`} className="block truncate font-medium hover:underline">
                      {postTitle(p)}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {p.accountName ?? "—"} · {SOCIAL_PLATFORM_LABELS[p.platform]} · {p.origin === "reelsflow" ? "ReelsFlow" : "fora do ReelsFlow"}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">{fmtDateTime(p.publishedAt, tz)}</td>
                  {(sort === "period_views" || sort === "recent") && (
                    <td className="px-3 py-2 text-right">
                      <Metric value={fmtInt(value)} />
                    </td>
                  )}
                  <td className="px-3 py-2 text-right"><Metric value={fmtInt(p.views)} /></td>
                  <td className="px-3 py-2 text-right"><Metric value={fmtInt(p.likes)} /></td>
                  <td className="px-3 py-2 text-right"><Metric value={fmtInt(p.comments)} /></td>
                  <td className="px-3 py-2 text-right"><Metric value={fmtInt(p.shares)} /></td>
                  <td className="px-3 py-2 text-right"><Metric value={fmtPct(p.engagementRate)} /></td>
                  <td className="px-3 py-2"><PerformanceBadge label={performanceIndicator(p, data.all).label} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Como o indicador é calculado</summary>
        <p className="mt-1">{PERFORMANCE_RULE.description}</p>
      </details>
    </div>
  );
}

/** Fase 2 — não gera nada sem autorização (chave de API e orçamento). */
export function InsightsTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Insights com IA <Badge variant="outline">Aguardando autorização</Badge>
        </CardTitle>
        <CardDescription>Fase 2 do Analytics.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm text-muted-foreground">
        <p>
          Esta área vai resumir padrões a partir das métricas reais (por exemplo, horários e formatos com melhor resultado), sempre citando os números usados e o tamanho da amostra. Ela ainda não está ativa porque depende de
          uma chave de API de IA e de um limite de gasto, que precisam da sua autorização.
        </p>
        <p>Nenhuma sugestão será aplicada automaticamente: o ReelsFlow não reagenda nem altera campanhas com base em IA.</p>
        <p className="flex items-center gap-1">
          Enquanto isso, use o ranking e o indicador de desempenho, que são calculados por regras fixas e documentadas.
          <ExternalLink className="size-3" aria-hidden />
        </p>
      </CardContent>
    </Card>
  );
}
