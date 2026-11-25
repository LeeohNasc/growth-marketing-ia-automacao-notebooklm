import type { Metadata } from "next";
import { TechDetails } from "@/components/tech-details";
import Link from "next/link";
import { Temporal } from "temporal-polyfill";
import { SOCIAL_PLATFORM_LABELS } from "@reelsflow/domain";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ERROR_CLASS_LABELS } from "@/lib/labels";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { AccountBars, DailyColumns, type AccountRow, type Day } from "./charts";

export const metadata: Metadata = { title: "Resultados" };

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

const PERIODS = [7, 30, 90] as const;

function fmtDelay(s: number | null) {
  if (s === null || s === undefined) return "—";
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1).replace(".", ",")} h`;
}
const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1).replace(".", ",")}%`);

export default async function AnalyticsPage({ params, searchParams }: { params: Promise<{ workspace: string }>; searchParams: Promise<{ days?: string }> }) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const { workspace } = await requireWorkspace(slug);
  const days = PERIODS.includes(Number(sp.days) as (typeof PERIODS)[number]) ? Number(sp.days) : 30;
  const tz = workspace.default_timezone;
  const today = Temporal.Now.plainDateISO(tz);
  const start = today.subtract({ days: days - 1 });
  const from = start.toZonedDateTime({ timeZone: tz }).toInstant().toString();
  const to = today.add({ days: 1 }).toZonedDateTime({ timeZone: tz }).toInstant().toString();

  const supabase = await createClient();
  const { data } = await supabase.rpc("publication_analytics", { p_workspace: workspace.id, p_from: from, p_to: to });
  const a = data as Analytics | null;

  // Série completa de dias (inclui dias sem publicação).
  const byDay = new Map((a?.by_day ?? []).map((d) => [d.day, d]));
  const series: Day[] = Array.from({ length: days }, (_, i) => {
    const d = start.add({ days: i }).toString();
    return byDay.get(d) ?? { day: d, published: 0, failed: 0, other: 0 };
  });
  const finished = (a?.published ?? 0) + (a?.failed ?? 0);
  const successRate = finished ? (a!.published / finished) : null;

  const kpis = [
    { label: "Publicadas", value: (a?.published ?? 0).toLocaleString("pt-BR") },
    { label: "Taxa de sucesso", value: pct(successRate), hint: "publicadas ÷ (publicadas + falhas definitivas)" },
    { label: "Não publicadas", value: (a?.failed ?? 0).toLocaleString("pt-BR"), hint: "falharam mesmo depois das novas tentativas" },
  ];
  // Indicadores de operação: úteis para diagnóstico, não para decidir conteúdo.
  const techKpis = [
    { label: "Sucesso na 1ª tentativa", value: pct(a?.first_attempt_rate ?? null) },
    { label: "Atraso mediano (efetivo − previsto)", value: fmtDelay(a?.delay_p50_s ?? null) },
    { label: "Atraso p95", value: fmtDelay(a?.delay_p95_s ?? null) },
  ];

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Resultados</h1>
          <p className="text-sm text-muted-foreground">Quantas publicações saíram, quando e por conta (dados do próprio ReelsFlow). Visualizações, curtidas e comentários ainda não estão disponíveis.</p>
        </div>
        <div className="flex rounded-md border p-0.5" role="group" aria-label="Período">
          {PERIODS.map((p) => (
            <Button key={p} asChild size="sm" variant={p === days ? "secondary" : "ghost"} className="h-8">
              <Link href={`/w/${slug}/analytics?days=${p}`} aria-current={p === days}>
                {p} dias
              </Link>
            </Button>
          ))}
        </div>
      </div>

      <section aria-label="Indicadores" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
      <TechDetails label="Indicadores técnicos">
        {techKpis.map((k) => (
          <span key={k.label}>
            {k.label}: <strong className="tabular-nums text-foreground">{k.value}</strong>
          </span>
        ))}
      </TechDetails>

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

      <p className="text-xs text-muted-foreground">
        Métricas das redes (visualizações, curtidas, alcance) não estão disponíveis: exigem permissões de insights da Meta e aprovação no App Review. Nada aqui é estimado.
      </p>
    </div>
  );
}
