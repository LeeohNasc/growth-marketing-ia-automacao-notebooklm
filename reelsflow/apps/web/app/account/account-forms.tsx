"use client";
import { useActionState } from "react";
import { Field, FormMessage, SubmitButton } from "@/components/form";
import { TimezoneSelect } from "@/components/timezone-select";
import { initialActionState } from "@/lib/action-state";
import { deleteAccountAction, updateProfileAction } from "./actions";

export function ProfileForm({ displayName, timezone }: { displayName: string; timezone: string }) {
  const [state, action] = useActionState(updateProfileAction, initialActionState);
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormMessage state={state} />
      <Field label="Nome" name="displayName" autoComplete="name" required defaultValue={state.values?.displayName ?? displayName} error={state.fieldErrors?.displayName} />
      <TimezoneSelect defaultValue={state.values?.timezone ?? timezone} error={state.fieldErrors?.timezone} />
      <SubmitButton className="justify-self-start" pendingText="Salvando…">
        Salvar perfil
      </SubmitButton>
    </form>
  );
}

export function DeleteAccountForm({ email }: { email: string }) {
  const [state, action] = useActionState(deleteAccountAction, initialActionState);
  return (
    <form action={action} className="grid gap-3" noValidate>
      <FormMessage state={state} />
      <Field label={`Digite seu e-mail (${email}) para confirmar`} name="confirmEmail" type="email" autoComplete="off" error={state.fieldErrors?.confirmEmail} />
      <SubmitButton variant="destructive" className="justify-self-start" pendingText="Excluindo…">
        Excluir minha conta
      </SubmitButton>
    </form>
  );
}
