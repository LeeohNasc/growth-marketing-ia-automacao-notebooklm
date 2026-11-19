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
  searchParams: Promise<{ view?: string; date?: string; campaign?: string; account?: string }>;
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
      statuses: STATUS_GROUPS.all!.statuses,
      campaign: sp.campaign,
      account: sp.account,
      from: startInstant,
      to: endInstant,
      limit: 1000,
    }),
    supabase.from("campaigns").select("id, name").eq("workspace_id", workspace.id).order("name"),
    supabase.from("social_accounts").select("id, display_name").eq("workspace_id", workspace.id).order("display_name"),
  ]);

  // Miniaturas (até 300 por tela)
  const ids = [...new Set(items.map((i) => i.id))];
  const { data: rows } = ids.length
    ? await supabase.from("publication_jobs").select("id, media_asset_id, local_time").in("id", ids)
    : { data: [] as { id: string; media_asset_id: string | null; local_time: string }[] };
  const mediaIds = [...new Set((rows ?? []).map((r) => r.media_asset_id).filter((x): x is string => Boolean(x)))].slice(0, 300);
  const { data: media } = mediaIds.length ? await supabase.from("media_assets").select("id, thumbnail_path").in("id", mediaIds) : { data: [] as { id: string; thumbnail_path: string | null }[] };
  const thumbs = await signPaths((media ?? []).map((m) => m.thumbnail_path).filter((p): p is string => Boolean(p)), 3600);
  const thumbByMedia = new Map((media ?? []).map((m) => [m.id, m.thumbnail_path ? (thumbs.get(m.thumbnail_path) ?? null) : null]));
  const rowById = new Map((rows ?? []).map((r) => [r.id, r]));

  const jobs: CalendarJob[] = items.map((j) => {
    const z = Temporal.Instant.from(j.scheduled_at).toZonedDateTimeISO(tz);
    const row = rowById.get(j.id);
    return {
      id: j.id,
      date: z.toPlainDate().toString(),
      time: `${String(z.hour).padStart(2, "0")}:${String(z.minute).padStart(2, "0")}`,
      jobLocalTime: (row?.local_time ?? "00:00").slice(0, 5),
      status: j.status,
      media: j.media,
      account: j.account,
      platform: j.platform,
      campaign: j.campaign,
      thumbUrl: row?.media_asset_id ? (thumbByMedia.get(row.media_asset_id) ?? null) : null,
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
        filters={{ campaign: sp.campaign ?? "", account: sp.account ?? "" }}
        canEdit={can(role, "editContent")}
        tz={tz}
      />
    </div>
  );
}
