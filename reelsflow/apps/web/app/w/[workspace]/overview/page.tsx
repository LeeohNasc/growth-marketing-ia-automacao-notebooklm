import type { Metadata } from "next";
import Link from "next/link";
import { Bell, CalendarClock, CheckCircle2, Circle, Film, TriangleAlert, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Visão Geral" };

/**
 * Indicadores cujas tabelas ainda não existem aparecem como "—" com a fase em
 * que passam a ser medidos. Nenhum número é inventado.
 */
const PENDING_KPIS = [
  { label: "Vídeos na biblioteca", icon: Film, phase: 2 },
  { label: "Publicações agendadas", icon: CalendarClock, phase: 3 },
  { label: "Publicações realizadas", icon: CheckCircle2, phase: 3 },
  { label: "Publicações com erro", icon: TriangleAlert, phase: 3 },
];

export default async function OverviewPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { user, workspace } = await requireWorkspace(slug);
  const supabase = await createClient();

  const [members, unread, recent] = await Promise.all([
    supabase.from("workspace_members").select("user_id", { count: "exact", head: true }).eq("workspace_id", workspace.id),
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id)
      .eq("user_id", user.id)
      .is("read_at", null),
    supabase
      .from("notifications")
      .select("id, type, created_at")
      .eq("workspace_id", workspace.id)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  const checklist = [
    { done: true, label: "Criar workspace", href: null },
    { done: false, label: "Enviar os primeiros vídeos", href: `/w/${slug}/upload`, phase: 2 },
    { done: false, label: "Criar um modelo de publicação", href: `/w/${slug}/templates`, phase: 3 },
    { done: false, label: "Conectar Instagram ou Facebook", href: `/w/${slug}/accounts`, phase: 4 },
  ];

  return (
    <div className="mx-auto grid max-w-6xl gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Visão Geral</h1>
          <p className="text-sm text-muted-foreground">
            {workspace.name} · fuso {workspace.default_timezone.replaceAll("_", " ")}
          </p>
        </div>
        {workspace.queue_paused && <Badge variant="warning">Fila pausada</Badge>}
      </div>

      <section aria-labelledby="kpis" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <h2 id="kpis" className="sr-only">
          Indicadores
        </h2>
        {PENDING_KPIS.map(({ label, icon: Icon, phase }) => (
          <Card key={label}>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <Icon className="size-4" aria-hidden /> {label}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold text-muted-foreground" aria-label="sem dados">
                —
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Medido a partir da Fase {phase}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Primeiros passos</CardTitle>
            <CardDescription>O fluxo principal: enviar vídeos → escolher modelo → gerar calendário → ativar.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2">
              {checklist.map((step) => (
                <li key={step.label} className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm">
                  {step.done ? (
                    <CheckCircle2 className="size-4 text-success" aria-label="concluído" />
                  ) : (
                    <Circle className="size-4 text-muted-foreground" aria-label="pendente" />
                  )}
                  <span className={step.done ? "text-muted-foreground line-through" : undefined}>{step.label}</span>
                  {"phase" in step && (
                    <Badge variant="outline" className="ml-auto">
                      Fase {step.phase}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <div className="grid gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <Users className="size-4" aria-hidden /> Membros
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">{members.count ?? 0}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <Bell className="size-4" aria-hidden /> Notificações não lidas
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <p className="text-3xl font-semibold">{unread.count ?? 0}</p>
              {(recent.data?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhuma atividade recente.</p>
              ) : (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/w/${slug}/notifications`}>Ver notificações</Link>
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
