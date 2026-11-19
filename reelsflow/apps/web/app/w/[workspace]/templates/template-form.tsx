"use client";
import { useActionState } from "react";
import { MODE_LABELS } from "@reelsflow/domain";
import { Field, FormMessage, SubmitButton } from "@/components/form";
import { ContentFields, ScheduleFields } from "@/components/schedule-fields";
import { NativeSelect } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initialActionState } from "@/lib/action-state";
import type { TemplateRow } from "@/lib/database.types";
import { saveTemplateAction } from "./actions";

export function TemplateForm({ slug, template, defaultTimezone }: { slug: string; template?: TemplateRow; defaultTimezone: string }) {
  const [state, action] = useActionState(saveTemplateAction, initialActionState);
  return (
    <form action={action} className="grid gap-6" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="slug" value={slug} />
      {template && <input type="hidden" name="id" value={template.id} />}
      <Field label="Nome do modelo" name="name" defaultValue={template?.name ?? ""} placeholder="Ex.: Publicações Diárias" error={state.fieldErrors?.name} />
      <div className="grid gap-2">
        <Label htmlFor="mode">Distribuição</Label>
        <NativeSelect id="mode" name="mode" defaultValue={template?.mode ?? "mirrored"}>
          <option value="mirrored">{MODE_LABELS.mirrored}</option>
          <option value="independent">{MODE_LABELS.independent}</option>
        </NativeSelect>
      </div>
      <ScheduleFields
        errors={state.fieldErrors}
        defaults={{
          timezone: template?.timezone ?? defaultTimezone,
          weekdays: template?.weekdays ?? [1, 2, 3, 4, 5, 6, 7],
          times: template?.times ?? ["09:00", "13:00", "19:00"],
          orderStrategy: template?.order_strategy,
          maxLatenessMinutes: template?.max_lateness_minutes,
        }}
      />
      <ContentFields caption={template?.caption} hashtags={template?.hashtags} />
      <SubmitButton className="justify-self-start" pendingText="Salvando…">
        Salvar modelo
      </SubmitButton>
    </form>
  );
}
