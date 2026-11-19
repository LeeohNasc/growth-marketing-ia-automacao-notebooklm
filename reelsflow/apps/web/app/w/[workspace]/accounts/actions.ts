"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { MOCK_BEHAVIORS } from "@reelsflow/connectors";
import type { ActionState } from "@/lib/action-state";
import type { Json } from "@/lib/database.types";
import { planLimitMessage } from "@/lib/limits-messages";
import { requireWorkspace } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";

const simulatedEnabled = () => process.env.ENABLE_SIMULATED_ACCOUNTS !== "false";

export async function createSimulatedAccountAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const slug = String(formData.get("slug"));
  if (!simulatedEnabled()) return { message: "Contas simuladas estão desativadas neste ambiente." };
  const { workspace } = await requireWorkspace(slug);
  const name = String(formData.get("name") ?? "").trim();
  const behavior = String(formData.get("behavior") ?? "success");
  if (!name || name.length > 120) return { fieldErrors: { name: "Informe um nome (até 120 caracteres)." } };
  if (!(MOCK_BEHAVIORS as readonly string[]).includes(behavior)) return { message: "Comportamento inválido." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_simulated_account", { p_workspace: workspace.id, p_name: name, p_behavior: behavior });
  if (error) return { message: "Somente administradores podem conectar contas." };
  revalidatePath(`/w/${slug}/accounts`);
  return { ok: true, message: "Conta simulada criada." };
}

export async function updateAccountAction(slug: string, accountId: string, patch: { paused?: boolean; minSpacing?: number; behavior?: string; reconnect?: boolean }) {
  const { workspace } = await requireWorkspace(slug);
  const supabase = await createClient();
  const { data: acc } = await supabase.from("social_accounts").select("settings, platform").eq("id", accountId).eq("workspace_id", workspace.id).single();
  if (!acc) return { ok: false, message: "Conta não encontrada." };
  const update: { paused?: boolean; min_spacing_minutes?: number; settings?: Json } = {};
  if (patch.paused !== undefined) update.paused = patch.paused;
  if (patch.minSpacing !== undefined) update.min_spacing_minutes = Math.max(0, Math.min(1440, Math.round(patch.minSpacing)));
  if (patch.behavior && acc.platform === "mock" && (MOCK_BEHAVIORS as readonly string[]).includes(patch.behavior)) {
    update.settings = { ...(acc.settings as Record<string, Json>), mock_behavior: patch.behavior };
  }
  const { data, error } = await supabase.from("social_accounts").update(update).eq("id", accountId).select("id");
  if (error || !data?.length) return { ok: false, message: "Somente administradores podem alterar contas." };
  revalidatePath(`/w/${slug}/accounts`);
  return { ok: true };
}

export async function deleteAccountAction(slug: string, accountId: string) {
  await requireWorkspace(slug);
  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_social_account", { p_account: accountId });
  revalidatePath(`/w/${slug}/accounts`);
  if (error) return { ok: false, message: error.message.includes("in progress") ? "Há publicações em andamento nesta conta. Tente novamente em instantes." : "Não foi possível remover." };
  return { ok: true };
}

export async function finalizeConnectionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const slug = String(formData.get("slug"));
  const state = String(formData.get("state"));
  const keys = formData.getAll("keys").map(String);
  await requireWorkspace(slug);
  if (!keys.length) return { message: "Selecione ao menos uma conta." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("finalize_oauth", { p_state: state, p_keys: keys });
  if (error) return { message: planLimitMessage(error.message) ?? "A sessão de conexão expirou ou já foi usada. Inicie a conexão novamente." };
  revalidatePath(`/w/${slug}/accounts`);
  redirect(`/w/${slug}/accounts?connected=${data ?? 0}`);
}

export async function disconnectAccountAction(slug: string, accountId: string) {
  await requireWorkspace(slug);
  const supabase = await createClient();
  const { error } = await supabase.rpc("disconnect_social_account", { p_account: accountId });
  revalidatePath(`/w/${slug}/accounts`);
  return error ? { ok: false, message: "Somente administradores podem desconectar contas." } : { ok: true };
}
