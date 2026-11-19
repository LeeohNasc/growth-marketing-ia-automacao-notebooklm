import type { Metadata } from "next";
import Link from "next/link";
import { Megaphone, Plus } from "lucide-react";
import { MODE_LABELS, can } from "@reelsflow/domain";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CAMPAIGN_STATUS } from "@/lib/labels";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Campanhas" };

export default async function CampaignsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug);
  const supabase = await createClient();
  const [{ data: campaigns }, { data: jobs }] = await Promise.all([
    supabase.from("campaigns").select("*").eq("workspace_id", workspace.id).order("created_at", { ascending: false }),
    supabase.from("publication_jobs").select("campaign_id, status, scheduled_at").eq("workspace_id", workspace.id).neq("status", "cancelled"),
  ]);
  const stats = new Map<string, { total: number; published: number; next: string | null }>();
  const now = new Date().toISOString();
  for (const j of jobs ?? []) {
    if (!j.campaign_id) continue;
    const s = stats.get(j.campaign_id) ?? { total: 0, published: 0, next: null };
    s.total++;
    if (j.status === "published") s.published++;
    if (["scheduled", "queued"].includes(j.status) && j.scheduled_at > now && (!s.next || j.scheduled_at < s.next)) s.next = j.scheduled_at;
    stats.set(j.campaign_id, s);
  }
  const fmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: workspace.default_timezone });

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Campanhas</h1>
          <p className="text-sm text-muted-foreground">Cada campanha distribui um conjunto de vídeos automaticamente.</p>
        </div>
        {can(role, "editContent") && (
          <Button asChild>
            <Link href={`/w/${slug}/campaigns/new`}>
              <Plus /> Nova campanha
            </Link>
          </Button>
        )}
      </div>
      {(campaigns?.length ?? 0) === 0 ? (
        <div className="grid place-items-center gap-2 rounded-xl border border-dashed py-14 text-center">
          <Megaphone className="size-8 text-muted-foreground" aria-hidden />
          <p className="font-medium">Nenhuma campanha</p>
          <p className="text-sm text-muted-foreground">Crie uma campanha para gerar o calendário automaticamente.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Campanha</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Progresso</th>
                <th className="px-4 py-2 font-medium">Próxima publicação</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {campaigns!.map((c) => {
                const s = stats.get(c.id);
                return (
                  <tr key={c.id} className="hover:bg-accent/40">
                    <td className="px-4 py-3">
                      <Link href={`/w/${slug}/campaigns/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                      <span className="block text-xs text-muted-foreground">{MODE_LABELS[c.mode]}</span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={CAMPAIGN_STATUS[c.status].variant}>{CAMPAIGN_STATUS[c.status].label}</Badge>
                    </td>
                    <td className="px-4 py-3 tabular-nums">{s ? `${s.published} de ${s.total} publicadas` : "—"}</td>
                    <td className="px-4 py-3 tabular-nums">{s?.next ? fmt.format(new Date(s.next)) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
