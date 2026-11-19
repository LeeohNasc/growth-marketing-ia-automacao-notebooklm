import type { Metadata } from "next";
import { can } from "@reelsflow/domain";
import { STATUS_GROUPS, listJobs } from "@/lib/jobs";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { QueueView } from "./queue-view";

export const metadata: Metadata = { title: "Fila de Publicações" };

const PAGE = 50;

export default async function QueuePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ group?: string; campaign?: string; account?: string; page?: string }>;
}) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const { workspace, role } = await requireWorkspace(slug);
  const group = sp.group && STATUS_GROUPS[sp.group] ? sp.group : "all";
  const page = Math.max(1, Number(sp.page) || 1);
  const supabase = await createClient();
  const [{ items, total }, { data: campaigns }, { data: accounts }] = await Promise.all([
    listJobs(workspace.id, {
      statuses: STATUS_GROUPS[group]!.statuses,
      campaign: sp.campaign,
      account: sp.account,
      order: group === "published" || group === "cancelled" ? "desc" : "asc",
      limit: PAGE,
      offset: (page - 1) * PAGE,
    }),
    supabase.from("campaigns").select("id, name").eq("workspace_id", workspace.id).order("name"),
    supabase.from("social_accounts").select("id, display_name").eq("workspace_id", workspace.id).order("display_name"),
  ]);
  return (
    <div className="mx-auto grid max-w-7xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Fila de Publicações</h1>
        <p className="text-sm text-muted-foreground">Status de cada publicação, tentativas e erros. Clique no horário para ver detalhes.</p>
      </div>
      <QueueView
        key={`${group}|${sp.campaign}|${sp.account}|${page}`}
        slug={slug}
        items={items}
        total={total}
        page={page}
        pageSize={PAGE}
        groups={Object.entries(STATUS_GROUPS).map(([key, g]) => ({ key, label: g.label }))}
        filters={{ group, campaign: sp.campaign ?? "", account: sp.account ?? "" }}
        campaigns={campaigns ?? []}
        accounts={accounts ?? []}
        canEdit={can(role, "editContent")}
        canAdmin={can(role, "editWorkspaceSettings")}
        queuePaused={workspace.queue_paused}
        tz={workspace.default_timezone}
      />
    </div>
  );
}
