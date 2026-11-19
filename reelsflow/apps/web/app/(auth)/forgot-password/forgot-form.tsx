"use client";
import { useActionState } from "react";
import { Field, FormMessage, SubmitButton } from "@/components/form";
import { initialActionState } from "@/lib/action-state";
import { forgotPasswordAction } from "../actions";

export function ForgotForm() {
  const [state, action] = useActionState(forgotPasswordAction, initialActionState);
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormMessage state={state} />
      <Field label="E-mail" name="email" type="email" autoComplete="email" required defaultValue={state.values?.email} error={state.fieldErrors?.email} />
      <SubmitButton pendingText="Enviando…">Enviar link de redefinição</SubmitButton>
    </form>
  );
}
