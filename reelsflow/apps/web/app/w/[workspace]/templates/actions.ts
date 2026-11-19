"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fieldErrors } from "@reelsflow/domain";
import type { ActionState } from "@/lib/action-state";
import { readScheduleForm, templateSchema } from "@/lib/forms";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

export async function saveTemplateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const slug = String(formData.get("slug"));
  const id = String(formData.get("id") ?? "");
  const { workspace, user } = await requireWorkspace(slug);
  const f = readScheduleForm(formData);
  const parsed = templateSchema.safeParse({ ...f, name: formData.get("name"), mode: formData.get("mode") });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error) };
  const d = parsed.data;
  const row = {
    name: d.name,
    mode: d.mode,
    timezone: d.timezone,
    weekdays: d.weekdays,
    times: d.times,
    order_strategy: d.orderStrategy,
    max_lateness_minutes: d.maxLatenessMinutes,
    caption: d.caption || null,
    hashtags: d.hashtags,
  };
  const supabase = await createClient();
  const res = id
    ? await supabase.from("publication_templates").update(row).eq("id", id).eq("workspace_id", workspace.id).select("id")
    : await supabase.from("publication_templates").insert({ ...row, workspace_id: workspace.id, created_by: user.id }).select("id");
  if (res.error || !res.data?.length) {
    return { message: res.error?.code === "23505" ? "Já existe um modelo com esse nome." : "Não foi possível salvar (permissão de editor necessária)." };
  }
  revalidatePath(`/w/${slug}/templates`);
  redirect(`/w/${slug}/templates`);
}

export async function deleteTemplateAction(slug: string, id: string) {
  const { workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  await supabase.from("publication_templates").delete().eq("id", id).eq("workspace_id", workspace.id);
  revalidatePath(`/w/${slug}/templates`);
}
