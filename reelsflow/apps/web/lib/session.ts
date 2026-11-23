import "server-only";
import { cache } from "react";
import { redirect, notFound } from "next/navigation";
import { isWorkspaceRole, type WorkspaceRole } from "@reelsflow/domain";
import { createClient } from "@/lib/supabase/server";

/**
 * Usuário autenticado, validado no servidor do Auth (getUser), memoizado por
 * requisição. A autorização de dados continua sendo da RLS.
 */
export const getCurrentUser = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
});

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export const getProfile = cache(async (userId: string) => {
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  return data;
});

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  isDemo: boolean;
};

export const listMyWorkspaces = cache(async (userId: string): Promise<WorkspaceSummary[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspace_members")
    .select("role, workspaces!inner(id, name, slug, is_demo)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error("Falha ao carregar workspaces.");
  return (data ?? []).flatMap((row) => {
    const ws = row.workspaces;
    if (!ws || !isWorkspaceRole(row.role)) return [];
    return [{ id: ws.id, name: ws.name, slug: ws.slug, role: row.role, isDemo: ws.is_demo }];
  });
});

/**
 * Identificador do usuário a partir do JWT da sessão, com a assinatura conferida
 * localmente (chaves públicas do projeto, em cache) — sem ida ao servidor do Auth.
 * Usado só para montar consultas em paralelo; a validação completa continua sendo
 * getCurrentUser() e a autorização dos dados continua sendo da RLS.
 */
const getSessionUserId = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;
  return error || typeof sub !== "string" ? null : sub;
});

/**
 * Resolve o workspace da URL. Se o usuário não for membro, a RLS não retorna a
 * linha e respondemos 404 (não revelamos que o slug existe).
 *
 * Desempenho: antes eram 3 idas ao Supabase em fila (usuário → workspace → vínculo)
 * a cada troca de página. Agora a validação do usuário (getUser, que também detecta
 * sessão revogada) roda EM PARALELO com uma única consulta workspace + vínculo do
 * próprio usuário. Regras idênticas: o vínculo precisa ser do mesmo usuário validado
 * por getUser (conferido abaixo) e a RLS continua filtrando as duas tabelas.
 */
export const requireWorkspace = cache(async (slug: string) => {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const supabase = await createClient();
  const [user, { data: row }] = await Promise.all([
    getCurrentUser(),
    supabase
      .from("workspaces")
      .select("*, workspace_members!inner(role)")
      .eq("slug", slug)
      .eq("workspace_members.user_id", userId)
      .maybeSingle(),
  ]);
  if (!user || user.id !== userId) redirect("/login");
  if (!row) notFound();
  const { workspace_members: members, ...workspace } = row;
  const role = members[0]?.role;
  if (members.length !== 1 || !isWorkspaceRole(role)) notFound();
  return { user, workspace, role };
});
