"use server";
import { redirect } from "next/navigation";
import { fieldErrors, forgotPasswordSchema, safeRedirectPath, signInSchema, signUpSchema } from "@reelsflow/domain";
import { formValues, type ActionState } from "@/lib/action-state";
import { authErrorMessage } from "@/lib/auth-errors";
import { siteUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export async function signInAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values = formValues(formData, ["email"]);
  const parsed = signInSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { message: authErrorMessage(error.code), values };

  redirect(safeRedirectPath(formData.get("next")?.toString(), "/w"));
}

export async function signUpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values = formValues(formData, ["displayName", "email"]);
  const parsed = signUpSchema.safeParse({
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };
  if (formData.get("terms") !== "on") {
    return { fieldErrors: { terms: "É necessário aceitar os termos para continuar." }, values };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { display_name: parsed.data.displayName },
      emailRedirectTo: siteUrl("/auth/confirm?next=/onboarding"),
    },
  });
  // E-mail já cadastrado não gera erro (o Supabase responde igual) — evita enumeração.
  if (error) return { message: authErrorMessage(error.code), values };

  redirect(`/check-email?type=signup`);
}

export async function forgotPasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values = formValues(formData, ["email"]);
  const parsed = forgotPasswordSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: siteUrl("/auth/confirm?next=/reset-password"),
  });
  if (error?.code === "over_email_send_rate_limit" || error?.code === "over_request_rate_limit") {
    return { message: authErrorMessage(error.code), values };
  }
  // Mesma resposta exista ou não o e-mail.
  redirect(`/check-email?type=recovery`);
}
