import type { Metadata } from "next";
import { ROLE_LABELS, can, isWorkspaceRole } from "@reelsflow/domain";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { DeleteWorkspaceForm, LeaveWorkspaceForm, WorkspaceForm } from "./settings-forms";

export const metadata: Metadata = { title: "Configurações" };

export default async function SettingsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { user, workspace, role } = await requireWorkspace(slug);
  const supabase = await createClient();

  const { data: members } = await supabase
    .from("workspace_members")
    .select("user_id, role, created_at")
    .eq("workspace_id", workspace.id)
    .order("created_at");
  const ids = (members ?? []).map((m) => m.user_id);
  const { data: profiles } = ids.length
    ? await supabase.from("profiles").select("id, display_name").in("id", ids)
    : { data: [] as { id: string; display_name: string }[] };
  const names = new Map((profiles ?? []).map((p) => [p.id, p.display_name]));

  const ws = { id: workspace.id, slug: workspace.slug, name: workspace.name, timezone: workspace.default_timezone };

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Configurações</h1>

      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
          <CardDescription>O fuso horário padrão é usado nos modelos de publicação, salvo configuração específica.</CardDescription>
        </CardHeader>
        <CardContent>
          <WorkspaceForm ws={ws} canEdit={can(role, "editWorkspaceSettings")} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Membros</CardTitle>
          <CardDescription>Convites e gestão de equipe chegam numa fase posterior.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y rounded-lg border">
            {(members ?? []).map((m) => (
              <li key={m.user_id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <span className="flex-1 truncate">
                  {names.get(m.user_id) || "Sem nome"}
                  {m.user_id === user.id && <span className="text-muted-foreground"> (você)</span>}
                </span>
                <Badge variant={m.role === "owner" ? "default" : "secondary"}>{isWorkspaceRole(m.role) ? ROLE_LABELS[m.role] : m.role}</Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>Zona de risco</CardTitle>
          <CardDescription>Ações irreversíveis.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          <div className="grid gap-2">
            <p className="text-sm text-muted-foreground">
              Sair remove seu acesso. Se você for o único membro, o workspace e todos os seus dados serão excluídos.
            </p>
            <LeaveWorkspaceForm ws={ws} />
          </div>
          {can(role, "deleteWorkspace") && (
            <div className="grid gap-2 border-t pt-6">
              <p className="text-sm text-muted-foreground">
                Excluir apaga o workspace, seus membros e todos os dados associados. Não é possível desfazer.
              </p>
              <DeleteWorkspaceForm ws={ws} />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
