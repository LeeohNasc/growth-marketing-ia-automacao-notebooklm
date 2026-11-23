"use server";
import { redirect } from "next/navigation";
import { createWorkspaceSchema, fieldErrors, safeRedirectPath } from "@reelsflow/domain";
import { formValues, type ActionState } from "@/lib/action-state";
import { createClient } from "@/lib/supabase/server";

export async function createWorkspaceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values = formValues(formData, ["name", "timezone"]);
  const parsed = createWorkspaceSchema.safeParse({ name: formData.get("name"), timezone: formData.get("timezone") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_workspace", { p_name: parsed.data.name, p_timezone: parsed.data.timezone });
  if (error || !data) {
    const message =
      error?.message === "email not confirmed"
        ? "Confirme seu e-mail antes de criar um workspace."
        : "Não foi possível criar o workspace. Tente novamente.";
    return { message, values };
  }
  redirect(safeRedirectPath(formData.get("next")?.toString(), `/w/${data.slug}/overview`));
}
