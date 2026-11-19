"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function acceptInvitationAction(token: string): Promise<{ message: string }> {
  const supabase = await createClient();
  const { data: slug, error } = await supabase.rpc("accept_invitation", { p_token: token });
  if (error || !slug) {
    return {
      message: error?.message.includes("another email")
        ? "Este convite foi enviado para outro e-mail. Entre com a conta do e-mail convidado (e confirmado)."
        : "Convite inválido, expirado ou já utilizado.",
    };
  }
  redirect(`/w/${slug}/overview`);
}
