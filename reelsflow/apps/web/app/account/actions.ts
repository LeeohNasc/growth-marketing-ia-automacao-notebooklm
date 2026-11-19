"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { deleteAccountSchema, fieldErrors, updateProfileSchema } from "@reelsflow/domain";
import { formValues, type ActionState } from "@/lib/action-state";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function updateProfileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values = formValues(formData, ["displayName", "timezone"]);
  const parsed = updateProfileSchema.safeParse({ displayName: formData.get("displayName"), timezone: formData.get("timezone") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login");
  const { data, error } = await supabase
    .from("profiles")
    .update({ display_name: parsed.data.displayName, default_timezone: parsed.data.timezone })
    .eq("id", auth.user.id)
    .select("id");
  if (error || !data?.length) return { message: "Não foi possível salvar. Tente novamente.", values };
  revalidatePath("/", "layout");
  return { ok: true, message: "Perfil atualizado.", values };
}

export async function deleteAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user?.email) redirect("/login");

  const parsed = deleteAccountSchema(auth.user.email).safeParse({ confirmEmail: formData.get("confirmEmail") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const { data: blockers, error: blockersError } = await supabase.rpc("account_deletion_blockers");
  if (blockersError) return { message: "Não foi possível verificar seus workspaces. Tente novamente." };
  if (blockers && blockers.length > 0) {
    const names = blockers.map((b) => b.workspace_name).join(", ");
    return {
      message: `Você é o único proprietário de: ${names}. Transfira a propriedade ou exclua esses workspaces antes de excluir a conta.`,
    };
  }

  const admin = createAdminClient();
  if (!admin) {
    return { message: "A exclusão de conta não está configurada neste ambiente (SUPABASE_SERVICE_ROLE_KEY ausente)." };
  }
  // O banco revalida: a exclusão falha se o usuário ainda for o último owner de um workspace com membros.
  const { error } = await admin.auth.admin.deleteUser(auth.user.id);
  if (error) return { message: "Não foi possível excluir a conta. Tente novamente ou contate o suporte." };

  await supabase.auth.signOut();
  redirect("/login?notice=account-deleted");
}
