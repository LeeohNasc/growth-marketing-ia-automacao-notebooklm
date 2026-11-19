"use client";
import { useActionState } from "react";
import { Field, FormMessage, SubmitButton } from "@/components/form";
import { TimezoneSelect } from "@/components/timezone-select";
import { initialActionState } from "@/lib/action-state";
import { createWorkspaceAction } from "./actions";

export function OnboardingForm({ defaultTimezone }: { defaultTimezone: string }) {
  const [state, action] = useActionState(createWorkspaceAction, initialActionState);
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormMessage state={state} />
      <Field
        label="Nome do workspace"
        name="name"
        required
        placeholder="Ex.: Minha marca, Agência X, Cliente Y"
        hint="Você pode criar outros depois, um por marca ou cliente."
        defaultValue={state.values?.name}
        error={state.fieldErrors?.name}
      />
      <TimezoneSelect defaultValue={state.values?.timezone ?? defaultTimezone} error={state.fieldErrors?.timezone} />
      <SubmitButton pendingText="Criando…">Criar workspace</SubmitButton>
    </form>
  );
}
