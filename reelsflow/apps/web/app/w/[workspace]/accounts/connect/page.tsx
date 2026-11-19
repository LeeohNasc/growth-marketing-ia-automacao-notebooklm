import type { Metadata } from "next";
import Link from "next/link";
import { can } from "@reelsflow/domain";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ConnectForm, type Candidate } from "./connect-form";

export const metadata: Metadata = { title: "Escolher contas" };

export default async function ConnectPage({ params, searchParams }: { params: Promise<{ workspace: string }>; searchParams: Promise<{ state?: string }> }) {
  const { workspace: slug } = await params;
  const { state } = await searchParams;
  const { workspace, role } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data, error } = state && can(role, "editWorkspaceSettings") ? await supabase.rpc("get_oauth_pending", { p_state: state }) : { data: null, error: true };
  const pending = data as { workspace_id: string; user_name: string; granted: string[]; candidates: Candidate[] } | null;

  if (error || !pending || pending.workspace_id !== workspace.id) {
    return (
      <div className="mx-auto grid max-w-2xl gap-4">
        <Alert variant="destructive">A sessão de conexão expirou ou é inválida. Inicie a conexão novamente.</Alert>
        <Link href={`/w/${slug}/accounts`} className="text-sm text-primary hover:underline">
          ← Contas Conectadas
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Escolher contas</h1>
        <p className="text-sm text-muted-foreground">
          Autorizado por {pending.user_name}. Selecione as Páginas do Facebook e contas profissionais do Instagram que este workspace poderá usar.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Contas encontradas</CardTitle>
          <CardDescription>Contas sem as permissões necessárias aparecem desativadas, com o motivo.</CardDescription>
        </CardHeader>
        <CardContent>
          {pending.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma Página foi compartilhada. No diálogo da Meta, selecione ao menos uma Página (e o Instagram profissional vinculado a ela).
            </p>
          ) : (
            <ConnectForm slug={slug} state={state!} candidates={pending.candidates} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
