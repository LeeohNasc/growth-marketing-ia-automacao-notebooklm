"use server";
import { revalidatePath } from "next/cache";
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
