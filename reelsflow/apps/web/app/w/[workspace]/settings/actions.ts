"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fieldErrors, updateWorkspaceSchema } from "@reelsflow/domain";
import { formValues, type ActionState } from "@/lib/action-state";
import { createClient } from "@/lib/supabase/server";
import { SESSION_ENDED_PATH } from "@/lib/session";

export async function updateWorkspaceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values = formValues(formData, ["name", "timezone"]);
  const id = String(formData.get("workspaceId") ?? "");
  const slug = String(formData.get("slug") ?? "");
  const parsed = updateWorkspaceSchema.safeParse({ name: formData.get("name"), timezone: formData.get("timezone") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };

  const supabase = await createClient();
  // A RLS só permite a atualização para admin/owner; 0 linhas = sem permissão.
  const { data, error } = await supabase
    .from("workspaces")
    .update({ name: parsed.data.name, default_timezone: parsed.data.timezone })
    .eq("id", id)
    .select("id");
  if (error) return { message: "Não foi possível salvar. Tente novamente.", values };
  if (!data?.length) return { message: "Você não tem permissão para alterar este workspace.", values };

  revalidatePath(`/w/${slug}`, "layout");
  return { ok: true, message: "Alterações salvas.", values };
}

export async function deleteWorkspaceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = String(formData.get("workspaceId") ?? "");
  const expected = String(formData.get("expectedName") ?? "");
  const typed = String(formData.get("confirmName") ?? "").trim();
  if (typed !== expected) return { fieldErrors: { confirmName: "Digite o nome exatamente como aparece." } };

  const supabase = await createClient();
  const { data, error } = await supabase.from("workspaces").delete().eq("id", id).select("id");
  if (error) return { message: "Não foi possível excluir. Tente novamente." };
  if (!data?.length) return { message: "Somente o proprietário pode excluir o workspace." };
  redirect("/w");
}

export async function leaveWorkspaceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = String(formData.get("workspaceId") ?? "");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect(SESSION_ENDED_PATH);
  const { data, error } = await supabase
    .from("workspace_members")
    .delete()
    .eq("workspace_id", id)
    .eq("user_id", auth.user.id)
    .select("user_id");
  if (error) {
    return {
      message: error.message.includes("at least one owner")
        ? "Você é o único proprietário. Promova outro membro a proprietário antes de sair."
        : "Não foi possível sair do workspace.",
    };
  }
  if (!data?.length) return { message: "Não foi possível sair do workspace." };
  redirect("/w");
}
