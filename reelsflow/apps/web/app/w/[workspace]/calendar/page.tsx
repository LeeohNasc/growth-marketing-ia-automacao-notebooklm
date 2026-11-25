import type { Metadata } from "next";
import { Temporal } from "temporal-polyfill";
import { can } from "@reelsflow/domain";
import { listJobs, STATUS_GROUPS } from "@/lib/jobs";
import { signPaths } from "@/lib/media";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { CalendarView, type CalendarJob } from "./calendar-view";

export const metadata: Metadata = { title: "Calendário" };

type View = "month" | "week" | "day" | "list";

function range(view: View, anchor: Temporal.PlainDate) {
  if (view === "day") return { start: anchor, days: 1 };
  if (view === "week") return { start: anchor.subtract({ days: anchor.dayOfWeek - 1 }), days: 7 };
  if (view === "list") return { start: anchor, days: 30 };
  const first = anchor.with({ day: 1 });
  return { start: first.subtract({ days: first.dayOfWeek - 1 }), days: 42 };
}

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ view?: string; date?: string; campaign?: string; account?: string; status?: string }>;
}) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const { workspace, role } = await requireWorkspace(slug);
  const tz = workspace.default_timezone;
  const view: View = (["month", "week", "day", "list"] as const).includes(sp.view as View) ? (sp.view as View) : "month";
  const today = Temporal.Now.plainDateISO(tz);
  let anchor = today;
  try {
    if (sp.date) anchor = Temporal.PlainDate.from(sp.date);
  } catch {
    /* data inválida: hoje */
  }
  const { start, days } = range(view, anchor);
  const startInstant = start.toZonedDateTime({ timeZone: tz }).toInstant().toString();
  const endInstant = start.add({ days }).toZonedDateTime({ timeZone: tz }).toInstant().toString();

  const supabase = await createClient();
  const [{ items }, { data: campaigns }, { data: accounts }] = await Promise.all([
    listJobs(workspace.id, {
      statuses: (STATUS_GROUPS[sp.status ?? ""] ?? STATUS_GROUPS.all!).statuses,
      campaign: sp.campaign,
      account: sp.account,
      from: startInstant,
      to: endInstant,
      limit: 1000,
    }),
    supabase.from("campaigns").select("id, name").eq("workspace_id", workspace.id).order("name"),
    supabase.from("social_accounts").select("id, display_name").eq("workspace_id", workspace.id).order("display_name"),
  ]);

  // Miniaturas (até 300 vídeos por tela). Horário local e caminho da miniatura já vêm de listJobs:
  // antes eram mais 2 consultas em fila (publication_jobs de novo + media_assets).
  const thumbPathByMedia = new Map<string, string>();
  for (const j of items) if (j.mediaAssetId && j.thumbnailPath && thumbPathByMedia.size < 300) thumbPathByMedia.set(j.mediaAssetId, j.thumbnailPath);
  const thumbs = await signPaths([...new Set(thumbPathByMedia.values())], 3600);
  const thumbByMedia = new Map([...thumbPathByMedia].map(([id, path]) => [id, thumbs.get(path) ?? null]));

  const jobs: CalendarJob[] = items.map((j) => {
    const z = Temporal.Instant.from(j.scheduled_at).toZonedDateTimeISO(tz);
    return {
      id: j.id,
      date: z.toPlainDate().toString(),
      time: `${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")}`,
      jobLocalTime: (j.localTime ?? "00:00").slice(0, 5),
      status: j.status,
      media: j.media,
      account: j.account,
      platform: j.platform,
      campaign: j.campaign,
      thumbUrl: j.mediaAssetId ? (thumbByMedia.get(j.mediaAssetId) ?? null) : null,
    };
  });

  return (
    <div className="mx-auto grid max-w-7xl gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Calendário</h1>
        <p className="text-sm text-muted-foreground">Horários em {tz.replaceAll("_", " ")}. Arraste uma publicação para outro dia ou clique para editar.</p>
      </div>
      <CalendarView
        key={`${view}|${anchor}|${sp.campaign}|${sp.account}`}
        slug={slug}
        view={view}
        anchor={anchor.toString()}
        today={today.toString()}
        start={start.toString()}
        days={days}
        jobs={jobs}
        campaigns={campaigns ?? []}
        accounts={accounts ?? []}
        filters={{ campaign: sp.campaign ?? "", account: sp.account ?? "", status: sp.status && STATUS_GROUPS[sp.status] ? sp.status : "" }}
        canEdit={can(role, "editContent")}
        tz={tz}
      />
    </div>
  );
}
