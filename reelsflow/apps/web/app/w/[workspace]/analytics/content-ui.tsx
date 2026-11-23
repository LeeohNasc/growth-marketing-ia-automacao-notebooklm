import Link from "next/link";
import { PERFORMANCE_RULE, type MetricTotal, type PerformanceLabel } from "@reelsflow/domain";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SYNC_STATUS_TEXT, type Period, type SyncState } from "@/lib/content-analytics";

/** Formatação e estados de dado ausente compartilhados pelas telas de analytics de conteúdo. */

export const UNAVAILABLE_HINT = "A rede ou a integração não informou este dado para o vídeo. Não é zero; é desconhecido.";

export const fmtInt = (v: number | null) => (v === null ? null : Math.round(v).toLocaleString("pt-BR"));
export const fmtPct = (v: number | null) => (v === null ? null : `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`);
export const fmtSecs = (ms: number | null) => (ms === null ? null : `${(ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`);

/** Valor ou "Indisponível" (com explicação acessível). */
export function Metric({ value, className }: { value: string | null; className?: string }) {
  if (value === null)
    return (
      <span className={`text-muted-foreground ${className ?? ""}`} title={UNAVAILABLE_HINT}>
        Indisponível
      </span>
    );
  return <span className={`tabular-nums ${className ?? ""}`}>{value}</span>;
}

/** Total + cobertura ("de 8 vídeos com o dado"). */
export function TotalTile({ label, total, hint }: { label: string; total: MetricTotal; hint?: string }) {
  const all = total.withData + total.withoutData;
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">
        <Metric value={fmtInt(total.value)} />
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {all === 0 ? "Nenhum vídeo no período." : total.withoutData > 0 ? `${total.withData} de ${all} vídeos com o dado.` : `${all} ${all === 1 ? "vídeo" : "vídeos"}.`}
        {hint ? ` ${hint}` : ""}
      </p>
    </div>
  );
}

const PERF: Record<PerformanceLabel, { text: string; variant: "success" | "secondary" | "warning" | "outline" }> = {
  above: { text: "Acima da média", variant: "success" },
  within: { text: "Dentro da média", variant: "secondary" },
  below: { text: "Abaixo da média", variant: "warning" },
  insufficient: { text: "Dados insuficientes", variant: "outline" },
};
export function PerformanceBadge({ label }: { label: PerformanceLabel }) {
  return (
    <Badge variant={PERF[label].variant} title={PERFORMANCE_RULE.description}>
      {PERF[label].text}
    </Badge>
  );
}

/** Aviso do estado da sincronização (escopo ausente, erro, nunca sincronizado). */
export function SyncNotice({ sync, slug }: { sync: SyncState[]; slug: string }) {
  const problems = sync.filter((s) => s.status !== "ok");
  if (sync.length === 0)
    return (
      <Alert>
        Nenhuma conta com métricas sincronizadas ainda. As métricas são lidas das redes pela integração Zernio, a cada 3 horas, para contas conectadas por ela.
      </Alert>
    );
  if (problems.length === 0) return null;
  return (
    <div className="grid gap-2">
      {problems.map((s) => (
        <Alert key={s.socialAccountId} variant={s.status === "needs_analytics_scope" ? "warning" : undefined}>
          <strong>{s.accountName ?? "Conta"}:</strong> {SYNC_STATUS_TEXT[s.status]}{" "}
          {s.status === "needs_analytics_scope" && (
            <Link href={`/w/${slug}/accounts`} className="underline">
              Ver contas
            </Link>
          )}
        </Alert>
      ))}
    </div>
  );
}

export const PERIOD_OPTIONS = [
  { key: "1", label: "24 h" },
  { key: "7", label: "7 dias" },
  { key: "30", label: "30 dias" },
  { key: "90", label: "90 dias" },
] as const;

/** Seletor de período (links + intervalo personalizado via GET, sem JavaScript). */
export function PeriodPicker({ base, period, extra = {} }: { base: string; period: Period; extra?: Record<string, string> }) {
  const qs = (o: Record<string, string>) => new URLSearchParams({ ...extra, ...o }).toString();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex rounded-md border p-0.5" role="group" aria-label="Período">
        {PERIOD_OPTIONS.map((p) => (
          <Button key={p.key} asChild size="sm" variant={p.key === period.key ? "secondary" : "ghost"} className="h-8">
            <Link href={`${base}?${qs({ days: p.key })}`} aria-current={p.key === period.key}>
              {p.label}
            </Link>
          </Button>
        ))}
      </div>
      <form action={base} method="get" className="flex flex-wrap items-center gap-1 text-sm" aria-label="Período personalizado">
        {Object.entries(extra).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <label className="sr-only" htmlFor="pf">De</label>
        <input id="pf" name="from" type="date" defaultValue={period.key === "custom" ? period.fromDay : ""} required className="h-8 w-[8.75rem] min-w-0 rounded-md border bg-background px-2" />
        <span aria-hidden>–</span>
        <label className="sr-only" htmlFor="pt">Até</label>
        <input id="pt" name="to" type="date" defaultValue={period.key === "custom" ? period.toDay : ""} required className="h-8 w-[8.75rem] min-w-0 rounded-md border bg-background px-2" />
        <Button type="submit" size="sm" variant={period.key === "custom" ? "secondary" : "outline"} className="h-8">
          Aplicar
        </Button>
      </form>
    </div>
  );
}

export const fmtDateTime = (iso: string | null, tz: string) =>
  iso ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: tz }).format(new Date(iso)) : null;
