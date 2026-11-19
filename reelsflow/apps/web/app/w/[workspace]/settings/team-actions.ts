"use server";
import { revalidatePath } from "next/cache";
import { canAssignRole, emailSchema, isWorkspaceRole, type WorkspaceRole } from "@reelsflow/domain";
import { siteUrl } from "@/lib/env";
import { planLimitMessage } from "@/lib/limits-messages";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

type Res = { ok: boolean; message?: string; link?: string };

/**
 * Cria o convite e devolve o link para copiar. O envio por e-mail ainda não
 * está configurado (arquitetura preparada; nenhum provedor contratado).
 */
export async function inviteAction(slug: string, email: string, role: string): Promise<Res> {
  const { workspace, role: myRole } = await requireWorkspace(slug);
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) return { ok: false, message: "E-mail inválido." };
  if (!isWorkspaceRole(role) || !canAssignRole(myRole, role)) return { ok: false, message: "Você não pode convidar com este papel." };
  const supabase = await createClient();
  const { data: token, error } = await supabase.rpc("create_invitation", { p_workspace: workspace.id, p_email: parsed.data, p_role: role });
  revalidatePath(`/w/${slug}/settings`);
  if (error || !token) {
    return { ok: false, message: planLimitMessage(error?.message) ?? (error?.message.includes("already a member") ? "Esta pessoa já é membro." : "Não foi possível criar o convite.") };
  }
  return { ok: true, link: siteUrl(`/invite/${token}`), message: "Convite criado. Envie o link abaixo para a pessoa; ele vale por 7 dias e só funciona com este e-mail." };
}

export async function revokeInvitationAction(slug: string, id: string): Promise<Res> {
  await requireWorkspace(slug);
  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_invitation", { p_id: id });
  revalidatePath(`/w/${slug}/settings`);
  return error ? { ok: false, message: "Sem permissão." } : { ok: true };
}

export async function changeRoleAction(slug: string, userId: string, role: string): Promise<Res> {
  const { workspace, role: myRole } = await requireWorkspace(slug);
  if (!isWorkspaceRole(role) || !canAssignRole(myRole, role as WorkspaceRole)) return { ok: false, message: "Você não pode atribuir este papel." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("workspace_members").update({ role }).eq("workspace_id", workspace.id).eq("user_id", userId).select("user_id");
  revalidatePath(`/w/${slug}/settings`);
  if (error) return { ok: false, message: error.message.includes("at least one owner") ? "O workspace precisa manter ao menos um proprietário." : "Não foi possível alterar." };
  if (!data?.length) return { ok: false, message: "Sem permissão para alterar este membro." };
  return { ok: true };
}

export async function removeMemberAction(slug: string, userId: string): Promise<Res> {
  const { workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data, error } = await supabase.from("workspace_members").delete().eq("workspace_id", workspace.id).eq("user_id", userId).select("user_id");
  revalidatePath(`/w/${slug}/settings`);
  if (error) return { ok: false, message: error.message.includes("at least one owner") ? "O workspace precisa manter ao menos um proprietário." : "Não foi possível remover." };
  if (!data?.length) return { ok: false, message: "Sem permissão para remover este membro." };
  return { ok: true };
}
