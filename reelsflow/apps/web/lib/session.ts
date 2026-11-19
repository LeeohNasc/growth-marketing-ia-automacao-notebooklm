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
 * Resolve o workspace da URL. Se o usuário não for membro, a RLS não retorna a
 * linha e respondemos 404 (não revelamos que o slug existe).
 */
export const requireWorkspace = cache(async (slug: string) => {
  const user = await requireUser();
  const supabase = await createClient();
  const { data: workspace } = await supabase.from("workspaces").select("*").eq("slug", slug).maybeSingle();
  if (!workspace) notFound();
  const { data: membership } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspace.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership || !isWorkspaceRole(membership.role)) notFound();
  return { user, workspace, role: membership.role };
});
