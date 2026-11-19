"use server";
import { revalidatePath } from "next/cache";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

const KEYS = ["append_from_collection", "retry_transient", "low_content_alert", "complete_campaign", "pause_on_auth_loss"];

export async function setRuleAction(slug: string, rule: string, enabled: boolean, params: Record<string, number>) {
  const { workspace } = await requireWorkspace(slug);
  if (!KEYS.includes(rule)) return { ok: false, message: "Regra inválida." };
  const clean: Record<string, number> = {};
  if (params.max_attempts !== undefined) clean.max_attempts = Math.max(1, Math.min(20, Math.round(params.max_attempts)));
  if (params.days !== undefined) clean.days = Math.max(1, Math.min(30, Math.round(params.days)));
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_automation_rule", { p_workspace: workspace.id, p_rule: rule, p_enabled: enabled, p_params: clean });
  revalidatePath(`/w/${slug}/automations`);
  return error ? { ok: false, message: "Somente administradores podem alterar automações." } : { ok: true };
}
