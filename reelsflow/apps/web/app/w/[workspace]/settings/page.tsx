import type { Metadata } from "next";
import Link from "next/link";
import { can, isWorkspaceRole } from "@reelsflow/domain";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { DeleteWorkspaceForm, LeaveWorkspaceForm, WorkspaceForm } from "./settings-forms";
import { Team } from "./team";

export const metadata: Metadata = { title: "Configurações" };

export default async function SettingsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace: slug } = await params;
  const { user, workspace, role } = await requireWorkspace(slug);
  const supabase = await createClient();

  const canAdmin = can(role, "manageMembers");
  // Convites e uso não dependem da lista de membros: buscados em paralelo com ela.
  const [{ data: members }, { data: invites }, { data: usage }] = await Promise.all([
    supabase.from("workspace_members").select("user_id, role, created_at").eq("workspace_id", workspace.id).order("created_at"),
    canAdmin
      ? supabase.from("workspace_invitations").select("id, email, role, expires_at").eq("workspace_id", workspace.id).is("accepted_at", null).is("revoked_at", null).gt("expires_at", new Date().toISOString())
      : Promise.resolve({ data: [] as { id: string; email: string; role: "viewer" | "editor" | "admin" | "owner"; expires_at: string }[] }),
    supabase.rpc("workspace_usage", { p_workspace: workspace.id }),
  ]);
  const ids = (members ?? []).map((m) => m.user_id);
  const { data: profiles } = ids.length
    ? await supabase.from("profiles").select("id, display_name").in("id", ids)
    : { data: [] as { id: string; display_name: string }[] };
  const names = new Map((profiles ?? []).map((p) => [p.id, p.display_name]));
  const u = (usage ?? {}) as { seats?: number; limits?: { seats?: number } };

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
          <CardTitle>Equipe</CardTitle>
          <CardDescription>Papéis: Leitura (vê tudo), Editor (vídeos, campanhas, calendário), Administrador (contas, membros, configurações), Proprietário.</CardDescription>
        </CardHeader>
        <CardContent>
          <Team
            slug={slug}
            myRole={role}
            seats={{ used: u.seats ?? (members ?? []).length, limit: u.limits?.seats ?? 1 }}
            invites={(invites ?? []).map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expires_at }))}
            members={(members ?? []).filter((m) => isWorkspaceRole(m.role)).map((m) => ({ userId: m.user_id, name: names.get(m.user_id) ?? "", role: m.role as "viewer" | "editor" | "admin" | "owner", isMe: m.user_id === user.id }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Automações</CardTitle>
          <CardDescription>Regras de retry, avisos de pouco conteúdo, conclusão de campanhas e reação à perda de autorização.</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href={`/w/${slug}/automations`} className="text-sm font-medium text-primary hover:underline">
            Configurar automações →
          </Link>
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
