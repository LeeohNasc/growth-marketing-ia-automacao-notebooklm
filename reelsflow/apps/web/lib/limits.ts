import "server-only";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@reelsflow/domain";
import { createClient } from "@/lib/supabase/server";

/** Mesmo cálculo de app.max_upload_bytes: limite do plano, senão 50 MB. */
export async function maxUploadBytes(workspaceId: string): Promise<number> {
  const supabase = await createClient();
  const { data } = await supabase.from("subscriptions").select("limits").eq("workspace_id", workspaceId).maybeSingle();
  const limits = data?.limits as { max_upload_bytes?: number } | null;
  return typeof limits?.max_upload_bytes === "number" ? limits.max_upload_bytes : DEFAULT_MAX_UPLOAD_BYTES;
}
