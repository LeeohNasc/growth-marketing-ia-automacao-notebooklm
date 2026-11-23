import type { Metadata } from "next";
import Link from "next/link";
import { Temporal } from "temporal-polyfill";
import { BarChart3, Lightbulb, ListOrdered, PlaySquare } from "lucide-react";
import { SOCIAL_PLATFORM_LABELS } from "@reelsflow/domain";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ERROR_CLASS_LABELS } from "@/lib/labels";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { loadContentAnalytics, resolvePeriod, type Period } from "@/lib/content-analytics";
import { AccountBars, DailyColumns, type AccountRow, type Day } from "./charts";
import { PeriodPicker, SyncNotice } from "./content-ui";
import { ContentOverview, InsightsTab, RankingTab } from "./tabs";

export const metadata: Metadata = { title: "Analytics" };

type Analytics = {
  published: number;
  failed: number;
  delay_p50_s: number | null;
  delay_p95_s: number | null;
  first_attempt_rate: number | null;
  reconciled: number;
  by_day: Day[];
  by_account: AccountRow[];
  failure_reasons: { reason: string; n: number }[];
};


function fmtDelay(s: number | null) {
  if (s === null || s === undefined) return "—";
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1).replace(".", ",")} h`;
}
const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1).replace(".", ",")}%`);

const TABS = [
  { key: "overview", label: "Visão geral", icon: BarChart3 },
  { key: "ranking", label: "Ranking de vídeos", icon: ListOrdered },
  { key: "video", label: "Análise individual", icon: PlaySquare },
  { key: "insights", label: "Insights com IA", icon: Lightbulb },
] as const;
type TabKey = (typeof TABS)[number]["key"];

type Search = { days?: string; from?: string; to?: string; tab?: string; sort?: string; origin?: string; scope?: string };

export default async function AnalyticsPage({ params, searchParams }: { params: Promise<{ workspace: string }>; searchParams: Promise<Search> }) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const { workspace } = await requireWorkspace(slug);
  const tz = workspace.default_timezone;
  const period = resolvePeriod(tz, sp);
  const tab: TabKey = TABS.some((t) => t.key === sp.tab) ? (sp.tab as TabKey) : "overview";
  const base = `/w/${slug}/analytics`;
  const periodQs: Record<string, string> = period.key === "custom" ? { from: period.fromDay, to: period.toDay } : { days: period.key };
  const content = await loadContentAnalytics(workspace.id, period);

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">Resultados reais dos conteúdos nas redes e desempenho operacional das publicações. Nada aqui é estimado.</p>
        </div>
        {tab !== "insights" && <PeriodPicker base={base} period={period} extra={{ tab, ...(sp.sort ? { sort: sp.sort } : {}), ...(sp.origin ? { origin: sp.origin } : {}) }} />}
      </div>

      <nav aria-label="Seções de analytics" className="flex flex-wrap gap-1 border-b">
        {TABS.map(({ key, label, icon: Icon }) => (
          <Link
            key={key}
            href={`${base}?${new URLSearchParams({ ...periodQs, tab: key }).toString()}`}
            aria-current={key === tab ? "page" : undefined}
            className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm ${key === tab ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            <Icon className="size-4" aria-hidden /> {label}
          </Link>
        ))}
      </nav>

      {tab !== "insights" && <SyncNotice sync={content.sync} slug={slug} />}

      {tab === "overview" && (
        <>
          <ContentOverview slug={slug} tz={tz} period={period} data={content} />
          <h2 className="mt-2 text-lg font-semibold">Operação das publicações</h2>
          <OperationalSection workspaceId={workspace.id} tz={tz} period={period} />
        </>
      )}
      {(tab === "ranking" || tab === "video") && (
        <RankingTab slug={slug} tz={tz} period={period} data={content} sort={sp.sort} origin={sp.origin} scope={sp.scope} mode={tab} periodQs={periodQs} />
      )}
      {tab === "insights" && <InsightsTab />}
    </div>
  );
}

/** Indicadores operacionais (dados do próprio ReelsFlow) — mesmos de antes, agora no período escolhido. */
async function OperationalSection({ workspaceId, tz, period }: { workspaceId: string; tz: string; period: Period }) {
  const supabase = await createClient();
  const { data } = await supabase.rpc("publication_analytics", { p_workspace: workspaceId, p_from: period.fromIso, p_to: period.toIso });
  const a = data as Analytics | null;
  const start = Temporal.PlainDate.from(period.fromDay);
  const nDays = start.until(Temporal.PlainDate.from(period.toDay)).days + 1;
  const byDay = new Map((a?.by_day ?? []).map((d) => [d.day, d]));
  const series: Day[] = Array.from({ length: nDays }, (_, i) => {
    const d = start.add({ days: i }).toString();
    return byDay.get(d) ?? { day: d, published: 0, failed: 0, other: 0 };
  });
  const finished = (a?.published ?? 0) + (a?.failed ?? 0);
  const successRate = finished ? (a!.published / finished) : null;

  const kpis = [
    { label: "Publicadas", value: (a?.published ?? 0).toLocaleString("pt-BR") },
    { label: "Taxa de sucesso", value: pct(successRate), hint: "publicadas ÷ (publicadas + falhas definitivas)" },
    { label: "Sucesso na 1ª tentativa", value: pct(a?.first_attempt_rate ?? null) },
    { label: "Atraso mediano", value: fmtDelay(a?.delay_p50_s ?? null), hint: "horário efetivo − previsto" },
    { label: "Atraso p95", value: fmtDelay(a?.delay_p95_s ?? null) },
    { label: "Falhas definitivas", value: (a?.failed ?? 0).toLocaleString("pt-BR") },
  ];

  return (
    <>
      <section aria-label="Indicadores operacionais" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {kpis.map((k) => (
          <Card key={k.label}>
            <CardHeader className="pb-1">
              <CardDescription>{k.label}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold tabular-nums">{k.value}</p>
              {k.hint && <p className="mt-1 text-xs text-muted-foreground">{k.hint}</p>}
            </CardContent>
          </Card>
        ))}
      </section>

      {finished === 0 && (a?.by_day.length ?? 0) === 0 ? (
        <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">Nenhuma publicação prevista neste período.</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle>Publicações realizadas por dia</CardTitle>
              <CardDescription>Pelo dia previsto, em {tz.replaceAll("_", " ")}. Passe o mouse ou use Tab para ver falhas e pendentes.</CardDescription>
            </CardHeader>
            <CardContent>
              <DailyColumns days={series} />
            </CardContent>
          </Card>
          <div className="grid content-start gap-6 lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>Por conta</CardTitle>
              </CardHeader>
              <CardContent>
                {(a?.by_account.length ?? 0) === 0 ? <p className="text-sm text-muted-foreground">Sem dados.</p> : <AccountBars rows={a!.by_account} platformLabel={SOCIAL_PLATFORM_LABELS} />}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Motivos de falha</CardTitle>
                <CardDescription>{a?.reconciled ? `${a.reconciled} publicação(ões) confirmadas por reconciliação após resposta incerta.` : "Falhas definitivas no período."}</CardDescription>
              </CardHeader>
              <CardContent>
                {(a?.failure_reasons.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">Nenhuma falha definitiva.</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {a!.failure_reasons.map((f) => (
                      <li key={f.reason} className="flex justify-between py-1.5">
                        <span>{ERROR_CLASS_LABELS[f.reason] ?? f.reason}</span>
                        <span className="tabular-nums">{f.n}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

    </>
  );
}
