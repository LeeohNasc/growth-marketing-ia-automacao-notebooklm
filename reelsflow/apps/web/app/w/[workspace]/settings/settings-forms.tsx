"use client";
import { useActionState } from "react";
import { Field, FormMessage, SubmitButton } from "@/components/form";
import { TimezoneSelect } from "@/components/timezone-select";
import { initialActionState } from "@/lib/action-state";
import { deleteWorkspaceAction, leaveWorkspaceAction, updateWorkspaceAction } from "./actions";

type Ws = { id: string; slug: string; name: string; timezone: string };

export function WorkspaceForm({ ws, canEdit }: { ws: Ws; canEdit: boolean }) {
  const [state, action] = useActionState(updateWorkspaceAction, initialActionState);
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="workspaceId" value={ws.id} />
      <input type="hidden" name="slug" value={ws.slug} />
      <fieldset disabled={!canEdit} className="grid gap-4 disabled:opacity-70">
        <Field label="Nome" name="name" required defaultValue={state.values?.name ?? ws.name} error={state.fieldErrors?.name} />
        <TimezoneSelect defaultValue={state.values?.timezone ?? ws.timezone} error={state.fieldErrors?.timezone} />
      </fieldset>
      {canEdit ? (
        <SubmitButton className="justify-self-start" pendingText="Salvando…">
          Salvar alterações
        </SubmitButton>
      ) : (
        <p className="text-sm text-muted-foreground">Somente administradores podem alterar estas configurações.</p>
      )}
    </form>
  );
}

export function DeleteWorkspaceForm({ ws }: { ws: Ws }) {
  const [state, action] = useActionState(deleteWorkspaceAction, initialActionState);
  return (
    <form action={action} className="grid gap-3" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="workspaceId" value={ws.id} />
      <input type="hidden" name="expectedName" value={ws.name} />
      <Field label={`Digite "${ws.name}" para confirmar`} name="confirmName" autoComplete="off" error={state.fieldErrors?.confirmName} />
      <SubmitButton variant="destructive" className="justify-self-start" pendingText="Excluindo…">
        Excluir workspace
      </SubmitButton>
    </form>
  );
}

export function LeaveWorkspaceForm({ ws }: { ws: Ws }) {
  const [state, action] = useActionState(leaveWorkspaceAction, initialActionState);
  return (
    <form action={action} className="grid gap-3">
      <FormMessage state={state} />
      <input type="hidden" name="workspaceId" value={ws.id} />
      <SubmitButton variant="outline" className="justify-self-start" pendingText="Saindo…">
        Sair do workspace
      </SubmitButton>
    </form>
  );
}
