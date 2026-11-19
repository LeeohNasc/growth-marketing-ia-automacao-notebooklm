import type pg from "pg";

export type RuleKey = "append_from_collection" | "retry_transient" | "low_content_alert" | "complete_campaign" | "pause_on_auth_loss";

/** Valores padrão quando o workspace nunca alterou a regra. */
export const RULE_DEFAULTS: Record<RuleKey, { enabled: boolean; params: Record<string, number> }> = {
  append_from_collection: { enabled: true, params: {} },
  retry_transient: { enabled: true, params: { max_attempts: 6 } },
  low_content_alert: { enabled: true, params: { days: 3 } },
  complete_campaign: { enabled: true, params: {} },
  pause_on_auth_loss: { enabled: true, params: {} },
};

export async function getRule(db: pg.Pool, workspaceId: string, key: RuleKey) {
  const r = await db.query<{ enabled: boolean; params: Record<string, number> }>(
    "select enabled, params from public.automation_rules where workspace_id = $1 and rule_key = $2",
    [workspaceId, key],
  );
  const row = r.rows[0];
  return { enabled: row?.enabled ?? RULE_DEFAULTS[key].enabled, params: { ...RULE_DEFAULTS[key].params, ...(row?.params ?? {}) } };
}

/** Registra execução de regra; `dedupeKey` impede repetir a mesma ação (ex.: 1 alerta por dia). Retorna false se já existia. */
export async function recordRun(
  db: pg.Pool,
  run: { workspaceId: string; rule: RuleKey; subjectType: string; subjectId: string | null; outcome: string; details?: object; dedupeKey?: string },
): Promise<boolean> {
  const r = await db.query(
    `insert into public.automation_runs (workspace_id, rule_key, subject_type, subject_id, outcome, details, dedupe_key)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (dedupe_key) do nothing`,
    [run.workspaceId, run.rule, run.subjectType, run.subjectId, run.outcome, JSON.stringify(run.details ?? {}), run.dedupeKey ?? null],
  );
  return r.rowCount === 1;
}

export async function notify(db: pg.Pool, workspaceId: string, userIds: (string | null | undefined)[], type: string, payload: object) {
  const ids = [...new Set(userIds.filter((u): u is string => Boolean(u)))];
  for (const uid of ids) {
    await db.query(
      `insert into public.notifications (workspace_id, user_id, type, payload)
       select $1, $2, $3, $4 where exists (select 1 from public.workspace_members where workspace_id = $1 and user_id = $2)`,
      [workspaceId, uid, type, JSON.stringify(payload)],
    );
  }
}

export async function workspaceAdmins(db: pg.Pool, workspaceId: string): Promise<string[]> {
  const r = await db.query<{ user_id: string }>(
    "select user_id from public.workspace_members where workspace_id = $1 and role in ('admin', 'owner')",
    [workspaceId],
  );
  return r.rows.map((x) => x.user_id);
}
