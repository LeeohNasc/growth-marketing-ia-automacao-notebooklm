"use server";
import { redirect } from "next/navigation";
import { fieldErrors, resetPasswordSchema } from "@reelsflow/domain";
import type { ActionState } from "@/lib/action-state";
import { authErrorMessage } from "@/lib/auth-errors";
import { createClient } from "@/lib/supabase/server";

export async function resetPasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = resetPasswordSchema.safeParse({ password: formData.get("password"), confirm: formData.get("confirm") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect("/login?notice=link-invalid");

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return { message: authErrorMessage(error.code) };

  // Encerra todas as sessões (inclusive outros dispositivos) após troca de senha.
  await supabase.auth.signOut({ scope: "global" });
  redirect("/login?notice=password-updated");
}
