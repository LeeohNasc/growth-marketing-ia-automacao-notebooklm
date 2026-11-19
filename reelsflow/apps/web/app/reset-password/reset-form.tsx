"use client";
import { useActionState } from "react";
import { Field, FormMessage, SubmitButton } from "@/components/form";
import { initialActionState } from "@/lib/action-state";
import { resetPasswordAction } from "./actions";

export function ResetForm() {
  const [state, action] = useActionState(resetPasswordAction, initialActionState);
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormMessage state={state} />
      <Field label="Nova senha" name="password" type="password" autoComplete="new-password" required hint="Mínimo de 8 caracteres, com letras e números." error={state.fieldErrors?.password} />
      <Field label="Confirmar nova senha" name="confirm" type="password" autoComplete="new-password" required error={state.fieldErrors?.confirm} />
      <SubmitButton pendingText="Salvando…">Salvar nova senha</SubmitButton>
    </form>
  );
}
