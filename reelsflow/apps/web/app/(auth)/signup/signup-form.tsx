"use client";
import { useActionState } from "react";
import { Field, FormMessage, SubmitButton } from "@/components/form";
import { initialActionState } from "@/lib/action-state";
import { signUpAction } from "../actions";

export function SignUpForm() {
  const [state, action] = useActionState(signUpAction, initialActionState);
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormMessage state={state} />
      <Field label="Nome" name="displayName" autoComplete="name" required defaultValue={state.values?.displayName} error={state.fieldErrors?.displayName} />
      <Field label="E-mail" name="email" type="email" autoComplete="email" required defaultValue={state.values?.email} error={state.fieldErrors?.email} />
      <Field
        label="Senha"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        hint="Mínimo de 8 caracteres, com letras e números."
        error={state.fieldErrors?.password}
      />
      <div className="grid gap-1">
        <label className="flex items-start gap-2 text-sm text-muted-foreground">
          <input type="checkbox" name="terms" className="mt-0.5 size-4 accent-[var(--primary)]" aria-invalid={state.fieldErrors?.terms ? true : undefined} />
          <span>Li e aceito os termos de uso e a política de privacidade.</span>
        </label>
        {state.fieldErrors?.terms && <p className="text-xs text-destructive">{state.fieldErrors.terms}</p>}
      </div>
      <SubmitButton pendingText="Criando conta…">Criar conta</SubmitButton>
    </form>
  );
}
