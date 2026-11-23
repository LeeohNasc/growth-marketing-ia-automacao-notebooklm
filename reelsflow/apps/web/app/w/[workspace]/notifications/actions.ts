"use server";
import { revalidatePath } from "next/cache";
import { EMAIL_NOTIFICATION_TYPES } from "@/lib/labels";
import { createClient } from "@/lib/supabase/server";

export async function markAllReadAction(formData: FormData): Promise<void> {
  const workspaceId = String(formData.get("workspaceId") ?? "");
  const slug = String(formData.get("slug") ?? "");
  const supabase = await createClient();
  const { data } = await supabase.from("notifications").select("id").eq("workspace_id", workspaceId).is("read_at", null).limit(500);
  const ids = (data ?? []).map((n) => n.id);
  if (ids.length) await supabase.rpc("mark_notifications_read", { p_ids: ids });
  revalidatePath(`/w/${slug}`, "layout");
}

const ALLOWED = new Set<string>(EMAIL_NOTIFICATION_TYPES);

/** Preferências de aviso por e-mail do PRÓPRIO usuário neste workspace (RLS também garante). */
export async function savePreferencesAction(formData: FormData): Promise<void> {
  const workspaceId = String(formData.get("workspaceId") ?? "");
  const slug = String(formData.get("slug") ?? "");
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return;
  const enabledTypes = new Set(formData.getAll("types").map(String).filter((t) => ALLOWED.has(t)));
  const muted = [...ALLOWED].filter((t) => !enabledTypes.has(t));
  const values = { email_enabled: formData.get("email_enabled") === "on", muted_types: muted };
  // O banco só permite alterar estas duas colunas (sem upsert, que tentaria reescrever as chaves).
  const { data: updated } = await supabase
    .from("notification_preferences")
    .update(values)
    .eq("user_id", auth.user.id)
    .eq("workspace_id", workspaceId)
    .select("user_id");
  if (!updated?.length) await supabase.from("notification_preferences").insert({ user_id: auth.user.id, workspace_id: workspaceId, ...values });
  revalidatePath(`/w/${slug}/notifications`);
}
