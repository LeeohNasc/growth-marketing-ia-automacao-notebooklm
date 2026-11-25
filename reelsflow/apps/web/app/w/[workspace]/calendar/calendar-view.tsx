"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Temporal } from "temporal-polyfill";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { EDITABLE_STATUSES, JOB_STATUS_LABELS, JOB_STATUS_TONE, SOCIAL_PLATFORM_LABELS, type JobStatus, type SocialPlatform } from "@reelsflow/domain";
import { rescheduleJobAction } from "@/app/w/[workspace]/queue/actions";
import { JobSheet } from "@/components/job-sheet";
import { STATUS_DOT } from "@/components/job-status";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type CalendarJob = {
  id: string;
  date: string;
  time: string;
  jobLocalTime: string;
  status: JobStatus;
  media: string | null;
  account: string | null;
  platform: string | null;
  campaign: string | null;
  thumbUrl: string | null;
};

type Props = {
  slug: string;
  view: "month" | "week" | "day" | "list";
  anchor: string;
  today: string;
  start: string;
  days: number;
  jobs: CalendarJob[];
  campaigns: { id: string; name: string }[];
  accounts: { id: string; display_name: string }[];
  filters: { campaign: string; account: string; status: string };
  canEdit: boolean;
  tz: string;
};

/** Filtros de situação (mesmos grupos da Lista; "canceladas" fica só na Lista). */
const CALENDAR_STATUS_FILTERS = [["upcoming", "Agendadas"], ["active", "Saindo agora"], ["problems", "Com problema"], ["published", "Publicadas"]] as const;

const VIEWS = [
  ["day", "Dia"],
  ["week", "Semana"],
  ["month", "Mês"],
  ["list", "Lista"],
] as const;
const WEEK = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

export function CalendarView(p: Props) {
  const router = useRouter();
  const sp = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overDate, setOverDate] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const anchor = Temporal.PlainDate.from(p.anchor);
  const byDate = useMemo(() => {
    const m = new Map<string, CalendarJob[]>();
    for (const j of p.jobs) m.set(j.date, [...(m.get(j.date) ?? []), j]);
    for (const list of m.values()) list.sort((a, b) => a.time.localeCompare(b.time));
    return m;
  }, [p.jobs]);
  const days = Array.from({ length: p.days }, (_, i) => Temporal.PlainDate.from(p.start).add({ days: i }));

  const go = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) n.set(k, v);
      else n.delete(k);
    }
    router.push(`/w/${p.slug}/calendar?${n.toString()}`);
  };
  const step = (dir: -1 | 1) => {
    const unit = p.view === "month" ? { months: dir } : p.view === "week" ? { weeks: dir } : p.view === "list" ? { days: 30 * dir } : { days: dir };
    go({ date: anchor.add(unit).toString() });
  };
  const title =
    p.view === "month"
      ? new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${anchor.with({ day: 1 })}T12:00:00Z`))
      : p.view === "day"
        ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeZone: "UTC" }).format(new Date(`${p.anchor}T12:00:00Z`))
        : `${fmtShort(days[0]!)} – ${fmtShort(days.at(-1)!)}`;

  const drop = (date: string) => {
    const job = p.jobs.find((j) => j.id === dragId);
    setDragId(null);
    setOverDate(null);
    if (!job || job.date === date) return;
    start(async () => {
      let r = await rescheduleJobAction(p.slug, job.id, date, job.jobLocalTime);
      if (!r.ok && r.conflict && window.confirm(r.message)) r = await rescheduleJobAction(p.slug, job.id, date, job.jobLocalTime, true);
      setMsg(r.message ? { ok: r.ok, text: r.message } : null);
      router.refresh();
    });
  };

  const chip = (j: CalendarJob, compact = false) => {
    const draggable = p.canEdit && EDITABLE_STATUSES.includes(j.status);
    return (
      <button
        key={j.id}
        type="button"
        draggable={draggable}
        onDragStart={(e) => {
          setDragId(j.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => setDragId(null)}
        onClick={() => setOpenId(j.id)}
        title={`${j.time} · ${j.media ?? "—"} · ${j.account ?? "—"} · ${JOB_STATUS_LABELS[j.status]}`}
        aria-label={`${j.time}, ${j.media ?? "vídeo"}, ${j.account ?? "conta"}, ${JOB_STATUS_LABELS[j.status]}`}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md border bg-card px-1.5 py-1 text-left text-xs hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          draggable && "cursor-grab active:cursor-grabbing",
          dragId === j.id && "opacity-50",
        )}
      >
        <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[JOB_STATUS_TONE[j.status]])} aria-hidden />
        {!compact &&
          (j.thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- URL assinada temporária
            <img src={j.thumbUrl} alt="" className="h-8 w-5 shrink-0 rounded object-cover" />
          ) : (
            <span className="h-8 w-5 shrink-0 rounded bg-muted" />
          ))}
        <span className="min-w-0 flex-1">
          <span className="font-medium tabular-nums">{j.time}</span> <span className="truncate">{j.media ?? "—"}</span>
          {!compact && <span className="block truncate text-muted-foreground">{j.account}{j.platform ? ` · ${SOCIAL_PLATFORM_LABELS[j.platform as SocialPlatform]}` : ""}</span>}
        </span>
      </button>
    );
  };

  const dayCell = (d: Temporal.PlainDate, opts: { maxItems?: number; compact?: boolean; minH: string }) => {
    const key = d.toString();
    const list = byDate.get(key) ?? [];
    const outside = p.view === "month" && d.month !== anchor.month;
    const past = Temporal.PlainDate.compare(d, Temporal.PlainDate.from(p.today)) < 0;
    const shown = opts.maxItems ? list.slice(0, opts.maxItems) : list;
    return (
      <div
        key={key}
        onDragOver={(e) => {
          if (!dragId || past) return;
          e.preventDefault();
          setOverDate(key);
        }}
        onDragLeave={() => setOverDate((o) => (o === key ? null : o))}
        onDrop={(e) => {
          e.preventDefault();
          if (!past) drop(key);
        }}
        className={cn("grid content-start gap-1 border-b border-r p-1.5", opts.minH, outside && "bg-muted/30 text-muted-foreground", overDate === key && "bg-primary/10 ring-2 ring-inset ring-primary")}
      >
        <span className={cn("text-xs tabular-nums", key === p.today && "inline-grid size-6 place-items-center rounded-full bg-primary font-semibold text-primary-foreground")}>{d.day}</span>
        {shown.map((j) => chip(j, opts.compact))}
        {opts.maxItems && list.length > opts.maxItems && (
          <button type="button" className="text-left text-xs text-primary hover:underline" onClick={() => go({ view: "day", date: key })}>
            +{list.length - opts.maxItems} mais
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-1">
          <Button size="icon" variant="outline" onClick={() => step(-1)} aria-label="Anterior">
            <ChevronLeft />
          </Button>
          <Button size="sm" variant="outline" onClick={() => go({ date: p.today })}>
            Hoje
          </Button>
          <Button size="icon" variant="outline" onClick={() => step(1)} aria-label="Próximo">
            <ChevronRight />
          </Button>
        </div>
        <h2 className="text-lg font-medium capitalize">{title}</h2>
        <div className="ml-auto flex flex-wrap items-end gap-2">
          <div className="flex rounded-md border p-0.5" role="group" aria-label="Visualização">
            {VIEWS.map(([v, l]) => (
              <Button key={v} size="sm" variant={p.view === v ? "secondary" : "ghost"} className="h-8" aria-pressed={p.view === v} onClick={() => go({ view: v })}>
                {l}
              </Button>
            ))}
          </div>
          <div className="grid gap-1">
            <Label htmlFor="cal-status" className="sr-only">
              Situação
            </Label>
            <NativeSelect id="cal-status" value={p.filters.status} onChange={(e) => go({ status: e.target.value })} className="h-9 w-auto">
              <option value="">Todas as situações</option>
              {CALENDAR_STATUS_FILTERS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="cal-campaign" className="sr-only">
              Campanha
            </Label>
            <NativeSelect id="cal-campaign" value={p.filters.campaign} onChange={(e) => go({ campaign: e.target.value })} className="h-9 w-auto">
              <option value="">Todas as campanhas</option>
              {p.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="cal-account" className="sr-only">
              Conta
            </Label>
            <NativeSelect id="cal-account" value={p.filters.account} onChange={(e) => go({ account: e.target.value })} className="h-9 w-auto">
              <option value="">Todas as contas</option>
              {p.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.display_name}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      </div>

      <p className="min-h-5 text-sm" role="status">
        {pending ? <span className="text-muted-foreground">Salvando…</span> : msg && <span className={msg.ok ? "text-success" : "text-destructive"}>{msg.text}</span>}
      </p>

      {p.view === "month" && (
        <div className="overflow-x-auto">
          <div className="grid min-w-[720px] grid-cols-7 border-l border-t">
            {WEEK.map((w) => (
              <div key={w} className="border-b border-r bg-muted/40 px-2 py-1 text-xs font-medium text-muted-foreground">
                {w}
              </div>
            ))}
            {days.map((d) => dayCell(d, { maxItems: 3, compact: true, minH: "min-h-28" }))}
          </div>
        </div>
      )}

      {p.view === "week" && (
        <div className="overflow-x-auto">
          <div className="grid min-w-[840px] grid-cols-7 border-l border-t">
            {days.map((d, i) => (
              <div key={d.toString()} className="border-b border-r bg-muted/40 px-2 py-1 text-xs font-medium text-muted-foreground">
                {WEEK[i]} {d.day}/{d.month}
              </div>
            ))}
            {days.map((d) => dayCell(d, { minH: "min-h-80" }))}
          </div>
        </div>
      )}

      {p.view === "day" && <div className="rounded-xl border">{dayCell(days[0]!, { minH: "min-h-40" })}</div>}

      {p.view === "list" && (
        <div className="grid gap-4">
          {days.filter((d) => byDate.has(d.toString())).length === 0 && <p className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">Nenhuma publicação nos próximos 30 dias.</p>}
          {days
            .filter((d) => byDate.has(d.toString()))
            .map((d) => (
              <section key={d.toString()} className="grid gap-2">
                <h3 className="text-sm font-medium capitalize">{new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`))}</h3>
                <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">{byDate.get(d.toString())!.map((j) => chip(j))}</div>
              </section>
            ))}
        </div>
      )}

      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground" aria-label="Legenda">
        {(["neutral", "progress", "success", "warning", "danger"] as const).map((t) => (
          <span key={t} className="flex items-center gap-1">
            <span className={cn("size-2 rounded-full", STATUS_DOT[t])} />
            {{ neutral: "Agendada/rascunho/cancelada", progress: "Em andamento", success: "Publicada", warning: "Atenção", danger: "Falha" }[t]}
          </span>
        ))}
      </div>

      <JobSheet slug={p.slug} jobId={openId} onClose={() => setOpenId(null)} canEdit={p.canEdit} displayTz={p.tz} />
    </div>
  );
}

function fmtShort(d: Temporal.PlainDate) {
  return `${String(d.day).padStart(2, "0")}/${String(d.month).padStart(2, "0")}`;
}
