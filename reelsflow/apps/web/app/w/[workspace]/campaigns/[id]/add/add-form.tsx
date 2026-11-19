"use client";
import { useActionState } from "react";
import { FormMessage, SubmitButton } from "@/components/form";
import { initialActionState } from "@/lib/action-state";
import { addVideosAction } from "../../actions";
import { VideoPicker, type PickerVideo } from "../../video-picker";

export function AddVideosForm({ slug, campaignId, videos, exclude }: { slug: string; campaignId: string; videos: PickerVideo[]; exclude: string[] }) {
  const [state, action] = useActionState(addVideosAction, initialActionState);
  return (
    <form action={action} className="grid gap-4">
      <FormMessage state={state} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="campaign" value={campaignId} />
      <VideoPicker videos={videos} exclude={exclude} error={state.fieldErrors?.media} />
      <SubmitButton className="justify-self-start" pendingText="Agendando…">
        Adicionar ao fim da fila
      </SubmitButton>
    </form>
  );
}
