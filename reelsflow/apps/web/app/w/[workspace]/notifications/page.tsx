import type { Metadata } from "next";
import { Bell } from "lucide-react";
import { SubmitButton } from "@/components/form";
import { Card, CardContent } from "@/components/ui/card";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { EMAIL_NOTIFICATION_TYPES, NOTIFICATION_LABELS as TYPE_LABELS } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { markAllReadAction, savePreferencesAction } from "./actions";

export const metadata: Metadata = { title: "Notificações" };


export default async function NotificationsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { user, workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data: items } = await supabase
    .from("notifications")
    .select("id, type, read_at, created_at, email_status, email_error")
    .eq("workspace_id", workspace.id)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(100);
  const hasUnread = (items ?? []).some((n) => !n.read_at);
  const { data: pref } = await supabase.from("notification_preferences").select("email_enabled, muted_types").eq("workspace_id", workspace.id).eq("user_id", user.id).maybeSingle();
  const emailOn = pref?.email_enabled ?? true;
  const muted = new Set(pref?.muted_types ?? []);
  // O envio depende de um provedor configurado no servidor; enquanto não houver, o banco registra o motivo.
  const providerMissing = (items ?? []).some((n) => n.email_error === "provider_not_configured");
  const EMAIL_NOTE: Record<string, string> = { sent: "e-mail enviado", failed: "e-mail não entregue", pending: "e-mail na fila" };
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
              <span className="flex-1">
                {TYPE_LABELS[n.type] ?? n.type}
                {n.email_status && EMAIL_NOTE[n.email_status] && <span className="ml-2 text-xs text-muted-foreground">· {EMAIL_NOTE[n.email_status]}</span>}
              </span>
              <time dateTime={n.created_at} className="text-xs text-muted-foreground">
                {fmt.format(new Date(n.created_at))}
              </time>
            </li>
          ))}
        </ul>
      )}
      <section aria-labelledby="prefs-title" className="grid gap-3 rounded-xl border bg-card p-4">
        <div>
          <h2 id="prefs-title" className="font-medium">Avisos por e-mail</h2>
          <p className="text-sm text-muted-foreground">Os avisos importantes também podem chegar no seu e-mail. Todos continuam aparecendo aqui.</p>
        </div>
        {providerMissing && (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning" role="status">
            O envio de e-mails ainda não está ativo nesta instalação. Suas preferências ficam salvas e passam a valer quando ele for ativado.
          </p>
        )}
        <form action={savePreferencesAction} className="grid gap-3">
          <input type="hidden" name="workspaceId" value={workspace.id} />
          <input type="hidden" name="slug" value={slug} />
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" name="email_enabled" defaultChecked={emailOn} /> Receber avisos importantes por e-mail
          </label>
          <fieldset className="grid gap-1.5 sm:grid-cols-2">
            <legend className="mb-1 text-sm text-muted-foreground">Quais avisos</legend>
            {EMAIL_NOTIFICATION_TYPES.map((t) => (
              <label key={t} className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="types" value={t} defaultChecked={!muted.has(t)} className="mt-0.5" /> {TYPE_LABELS[t] ?? t}
              </label>
            ))}
          </fieldset>
          <div>
            <SubmitButton size="sm" pendingText="Salvando…">
              Salvar preferências
            </SubmitButton>
          </div>
        </form>
      </section>
    </div>
  );
}
