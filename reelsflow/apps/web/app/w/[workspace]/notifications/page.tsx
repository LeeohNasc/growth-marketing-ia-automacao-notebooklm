import type { Metadata } from "next";
import { Bell } from "lucide-react";
import { SubmitButton } from "@/components/form";
import { Card, CardContent } from "@/components/ui/card";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { markAllReadAction } from "./actions";

export const metadata: Metadata = { title: "Notificações" };

/** Rótulos dos tipos previstos no PRD §4.7. Tipos desconhecidos aparecem pelo código. */
const TYPE_LABELS: Record<string, string> = {
  "upload.completed": "Upload concluído",
  "upload.failed": "Upload com falha",
  "campaign.started": "Campanha iniciada",
  "campaign.completed": "Campanha concluída",
  "publication.published": "Publicação realizada",
  "publication.failed": "Publicação com erro",
  "account.disconnected": "Conta desconectada",
  "account.token_expiring": "Autorização expirando",
  "queue.low": "Pouco conteúdo na fila",
  "plan.limit_reached": "Limite do plano atingido",
};

export default async function NotificationsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { user, workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data: items } = await supabase
    .from("notifications")
    .select("id, type, read_at, created_at")
    .eq("workspace_id", workspace.id)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(100);
  const hasUnread = (items ?? []).some((n) => !n.read_at);
  const fmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: workspace.default_timezone });

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Notificações</h1>
        {hasUnread && (
          <form action={markAllReadAction}>
            <input type="hidden" name="workspaceId" value={workspace.id} />
            <input type="hidden" name="slug" value={slug} />
            <SubmitButton variant="outline" size="sm" pendingText="Marcando…">
              Marcar todas como lidas
            </SubmitButton>
          </form>
        )}
      </div>
      {(items?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="grid place-items-center gap-2 py-12 text-center">
            <Bell className="size-8 text-muted-foreground" aria-hidden />
            <p className="font-medium">Nenhuma notificação</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Avisos sobre uploads, campanhas, publicações e contas conectadas aparecerão aqui.
            </p>
          </CardContent>
        </Card>
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {items!.map((n) => (
            <li key={n.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className={cn("size-2 shrink-0 rounded-full", n.read_at ? "bg-transparent" : "bg-primary")} aria-label={n.read_at ? "lida" : "não lida"} />
              <span className="flex-1">{TYPE_LABELS[n.type] ?? n.type}</span>
              <time dateTime={n.created_at} className="text-xs text-muted-foreground">
                {fmt.format(new Date(n.created_at))}
              </time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
