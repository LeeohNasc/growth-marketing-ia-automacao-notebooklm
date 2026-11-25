import type { Metadata } from "next";
import Link from "next/link";
import { Temporal } from "temporal-polyfill";
import { CalendarClock, CheckCircle2, Film, Megaphone, SquarePen, TriangleAlert, Users } from "lucide-react";
import { SOCIAL_PLATFORM_LABELS, can, type JobStatus, type SocialPlatform } from "@reelsflow/domain";
import { JobStatusBadge } from "@/components/job-status";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { listJobs } from "@/lib/jobs";
import { NOTIFICATION_LABELS } from "@/lib/labels";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Início" };

/** Worker sem sinal há mais de 5 minutos. */
function isStale(lastSeen: string | null): boolean {
  return !lastSeen || Date.now() - Date.parse(lastSeen) > 5 * 60_000;
}

export default async function OverviewPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { user, workspace, role } = await requireWorkspace(slug);
  const supabase = await createClient();
  const tz = workspace.default_timezone;
  const ws = workspace.id;
  const head = { count: "exact" as const, head: true };

  const today = Temporal.Now.plainDateISO(tz);
  const weekEnd = today.add({ days: 7 }).toZonedDateTime({ timeZone: tz }).toInstant().toString();

  const [videos, scheduled, published, problems, campaigns, accounts, needsReauth, review, next, weekJobs, notes, lastSeen] = await Promise.all([
    supabase.from("media_assets").select("id", head).eq("workspace_id", ws).eq("status", "ready").is("deleted_at", null),
    supabase.from("publication_jobs").select("id", head).eq("workspace_id", ws).in("status", ["scheduled", "queued"]),
    supabase.from("publication_jobs").select("id", head).eq("workspace_id", ws).eq("status", "published"),
    supabase.from("publication_jobs").select("id", head).eq("workspace_id", ws).in("status", ["failed_permanent", "needs_review", "uncertain"]),
    supabase.from("campaigns").select("id", head).eq("workspace_id", ws).eq("status", "active"),
    supabase.from("social_accounts").select("id", head).eq("workspace_id", ws),
    supabase.from("social_accounts").select("display_name").eq("workspace_id", ws).eq("status", "needs_reauth"),
    supabase.from("publication_jobs").select("id", head).eq("workspace_id", ws).eq("status", "needs_review"),
    listJobs(ws, { statuses: ["scheduled", "queued"], from: new Date().toISOString(), limit: 1 }),
    supabase.from("publication_jobs").select("scheduled_at").eq("workspace_id", ws).in("status", ["scheduled", "queued", "published"]).gte("scheduled_at", today.toZonedDateTime({ timeZone: tz }).toInstant().toString()).lt("scheduled_at", weekEnd),
    supabase.from("notifications").select("id, type, created_at, payload").eq("workspace_id", ws).eq("user_id", user.id).order("created_at", { ascending: false }).limit(6),
    supabase.rpc("worker_last_seen"),
  ]);

  const nextJob = next.items[0];
  const fmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: tz });
  const perDay = new Map<string, number>();
  for (const j of weekJobs.data ?? []) {
    const d = Temporal.Instant.from(j.scheduled_at).toZonedDateTimeISO(tz).toPlainDate().toString();
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  const week = Array.from({ length: 7 }, (_, i) => today.add({ days: i }));
  const max = Math.max(1, ...perDay.values());
  const workerStale = (scheduled.count ?? 0) > 0 && isStale(lastSeen.data);

  const kpis = [
    { label: "Vídeos prontos", value: videos.count ?? 0, icon: Film, href: "library" },
    { label: "Publicações agendadas", value: scheduled.count ?? 0, icon: CalendarClock, href: "queue?group=upcoming" },
    { label: "Publicações realizadas", value: published.count ?? 0, icon: CheckCircle2, href: "history?show=published" },
    { label: "Com problema", value: problems.count ?? 0, icon: TriangleAlert, href: "queue?group=problems" },
    { label: "Campanhas ativas", value: campaigns.count ?? 0, icon: Megaphone, href: "campaigns" },
    { label: "Contas conectadas", value: accounts.count ?? 0, icon: Users, href: "accounts" },
  ];

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Início</h1>
          <p className="text-sm text-muted-foreground">
            {workspace.name} · fuso {tz.replaceAll("_", " ")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {workspace.queue_paused && <Badge variant="warning">Fila pausada</Badge>}
          {can(role, "editContent") && (
            <Button asChild>
              <Link href={`/w/${slug}/create/quick`}>
                <SquarePen /> Criar publicação
              </Link>
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-2">
        {workerStale && (
          <Alert variant="destructive">
            O processador de publicações não dá sinal há mais de 5 minutos. Publicações agendadas não sairão até ele voltar; as que passarem da tolerância irão para revisão.
          </Alert>
        )}
        {(needsReauth.data?.length ?? 0) > 0 && (
          <Alert variant="warning">
            Reconecte {needsReauth.data!.map((a) => a.display_name).join(", ")}: as publicações dessas contas estão aguardando.{" "}
            <Link href={`/w/${slug}/accounts`} className="underline">
              Contas
            </Link>
          </Alert>
        )}
        {(review.count ?? 0) > 0 && (
          <Alert variant="warning">
            {review.count} publicação(ões) precisam de revisão.{" "}
            <Link href={`/w/${slug}/queue?group=problems`} className="underline">
              Ver na lista
            </Link>
          </Alert>
        )}
      </div>

      <section aria-label="Indicadores" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {kpis.map(({ label, value, icon: Icon, href }) => (
          <Link key={label} href={`/w/${slug}/${href}`} className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Card className="h-full transition-colors hover:border-primary/50">
              <CardHeader className="pb-1">
                <CardDescription className="flex items-center gap-2">
                  <Icon className="size-4" aria-hidden /> {label}
                </CardDescription>
              </CardHeader>
              <CardContent className="text-3xl font-semibold tabular-nums">{value}</CardContent>
            </Card>
          </Link>
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Próxima publicação</CardTitle>
          </CardHeader>
          <CardContent>
            {nextJob ? (
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="text-lg font-semibold tabular-nums">{fmt.format(new Date(nextJob.scheduled_at))}</span>
                <span className="min-w-0 flex-1 truncate">{nextJob.media ?? "—"}</span>
                <span className="text-muted-foreground">
                  {nextJob.account}
                  {nextJob.platform ? ` · ${SOCIAL_PLATFORM_LABELS[nextJob.platform as SocialPlatform]}` : ""}
                </span>
                <JobStatusBadge status={nextJob.status as JobStatus} />
              </div>
            ) : (
              <div className="grid gap-3 text-sm text-muted-foreground">
                <p>Nenhuma publicação agendada.</p>
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm">
                    <Link href={`/w/${slug}/library?enviar=1`}>Enviar vídeos</Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/w/${slug}/campaigns/new`}>Criar campanha</Link>
                  </Button>
                </div>
              </div>
            )}
            <div className="mt-6">
              <h3 className="mb-2 text-sm font-medium">Próximos 7 dias</h3>
              <ul className="grid grid-cols-7 gap-2" aria-label="Publicações por dia nos próximos 7 dias">
                {week.map((d) => {
                  const n = perDay.get(d.toString()) ?? 0;
                  return (
                    <li key={d.toString()} className="grid justify-items-center gap-1 text-xs">
                      <span className="flex h-16 w-full items-end overflow-hidden rounded bg-muted" aria-hidden>
                        <span className="w-full rounded bg-primary" style={{ height: `${(n / max) * 100}%` }} />
                      </span>
                      <span className="tabular-nums">{n}</span>
                      <span className="text-muted-foreground">{["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"][d.dayOfWeek - 1]}</span>
                      <span className="sr-only">{`${d.toString()}: ${n} publicações`}</span>
                    </li>
                  );
                })}
              </ul>
              <Link href={`/w/${slug}/calendar`} className="mt-3 inline-block text-sm text-primary hover:underline">
                Abrir calendário →
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Atividade recente</CardTitle>
          </CardHeader>
          <CardContent>
            {(notes.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma atividade ainda.</p>
            ) : (
              <ul className="grid gap-2 text-sm">
                {notes.data!.map((n) => (
                  <li key={n.id} className="flex justify-between gap-2">
                    <span className="truncate">{NOTIFICATION_LABELS[n.type] ?? n.type}</span>
                    <time className="shrink-0 text-xs text-muted-foreground" dateTime={n.created_at}>
                      {fmt.format(new Date(n.created_at))}
                    </time>
                  </li>
                ))}
              </ul>
            )}
            <Link href={`/w/${slug}/notifications`} className="mt-3 inline-block text-sm text-primary hover:underline">
              Ver notificações →
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
