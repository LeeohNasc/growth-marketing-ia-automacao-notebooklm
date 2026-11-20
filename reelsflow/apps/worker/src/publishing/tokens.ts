import { classifyMetaError, fetchInstagramProfile, refreshInstagramToken, type GraphClient, type TokenCipher } from "@reelsflow/connectors/server";
import type { Db } from "../db";
import type { Logger } from "../log";
import { workspaceAdmins } from "./rules";

/**
 * Renovação dos tokens do Instagram Login (60 dias). A doc exige token com ≥ 24 h, ainda válido e
 * com instagram_business_basic; o novo token vale 60 dias a partir da renovação.
 * Política: renova quando faltam ≤ 15 dias; tenta de novo a cada 6 h se falhar;
 * avisa admins quando faltam ≤ 7 dias sem renovação; vencido → conta "requer reconexão".
 */
export const REFRESH_WINDOW_DAYS = 15;
export const WARN_WINDOW_DAYS = 7;

type Due = {
  social_account_id: string;
  workspace_id: string;
  external_account_id: string;
  display_name: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  key_version: number;
};

/** Notificação no máximo 1×/dia por conta e tipo. */
async function notifyOncePerDay(db: Db, workspaceId: string, type: string, accountId: string, payload: Record<string, unknown>) {
  for (const uid of await workspaceAdmins(db, workspaceId)) {
    await db.query(
      `insert into public.notifications (workspace_id, user_id, type, payload)
       select $1, $2, $3, $4::jsonb
        where not exists (select 1 from public.notifications n
                           where n.user_id = $2 and n.type = $3 and n.payload ->> 'account_id' = $5 and n.created_at > now() - interval '1 day')`,
      [workspaceId, uid, type, JSON.stringify({ ...payload, account_id: accountId }), accountId],
    );
  }
}

export async function maintainInstagramTokens(db: Db, deps: { cipher: TokenCipher | null; graph: GraphClient; log: Logger }, limit = 5) {
  // 1. Vencidos: não há como renovar; a conta precisa de nova autorização.
  const expired = await db.query<{ id: string; workspace_id: string; display_name: string }>(
    `update public.social_accounts a set status = 'needs_reauth'
       from public.social_account_tokens t
      where t.social_account_id = a.id and t.token_type = 'ig_user' and a.status = 'active' and t.expires_at <= now()
      returning a.id, a.workspace_id, a.display_name`,
  );
  for (const a of expired.rows) {
    deps.log.warn("instagram token expired", { account_id: a.id });
    await notifyOncePerDay(db, a.workspace_id, "account.disconnected", a.id, { account: a.display_name, reason: "token_expired" });
  }

  if (!deps.cipher) return { refreshed: 0, failed: 0, expired: expired.rowCount ?? 0 };

  // 2. Reivindica atomicamente os que estão na janela (dois workers nunca renovam o mesmo token).
  const due = await db.query<Due>(
    `update public.social_account_tokens t set last_refresh_attempt_at = now()
       from public.social_accounts a
      where a.id = t.social_account_id
        and t.social_account_id in (
          select t2.social_account_id from public.social_account_tokens t2 join public.social_accounts a2 on a2.id = t2.social_account_id
           where t2.token_type = 'ig_user' and a2.status = 'active' and t2.expires_at > now()
             and t2.expires_at < now() + make_interval(days => $1)
             and t2.issued_at < now() - interval '24 hours'
             and (t2.last_refresh_attempt_at is null or t2.last_refresh_attempt_at < now() - interval '6 hours')
           order by t2.expires_at limit $2)
      returning t.social_account_id, a.workspace_id, a.external_account_id, a.display_name, t.ciphertext, t.iv, t.auth_tag, t.key_version`,
    [REFRESH_WINDOW_DAYS, limit],
  );

  let refreshed = 0;
  let failed = 0;
  for (const row of due.rows) {
    const aad = `instagram:${row.external_account_id}`;
    try {
      const current = deps.cipher.open({ ciphertext: row.ciphertext, iv: row.iv, tag: row.auth_tag, keyVersion: row.key_version }, aad);
      const next = await refreshInstagramToken(deps.graph, current);
      // Confere a identidade antes de gravar: o token renovado precisa ser da MESMA conta.
      const profile = await fetchInstagramProfile(deps.graph, next.token);
      if (profile.userId !== row.external_account_id) throw new Error("token renovado pertence a outra conta");
      const sealed = deps.cipher.seal(next.token, aad);
      await db.query(
        `update public.social_account_tokens
            set ciphertext = $2, iv = $3, auth_tag = $4, key_version = $5, expires_at = $6, issued_at = now(), last_refresh_error = null
          where social_account_id = $1`,
        [row.social_account_id, sealed.ciphertext, sealed.iv, sealed.tag, sealed.keyVersion, next.expiresAt],
      );
      await db.query(
        `update public.social_accounts
            set token_expires_at = $2, avatar_url = coalesce($3, avatar_url),
                settings = settings || jsonb_build_object('username', $4::text)
          where id = $1`,
        [row.social_account_id, next.expiresAt, profile.avatarUrl, profile.username],
      );
      refreshed++;
      deps.log.info("instagram token refreshed", { account_id: row.social_account_id });
    } catch (e) {
      failed++;
      const err = classifyMetaError(e, false);
      await db.query("update public.social_account_tokens set last_refresh_error = left($2, 500) where social_account_id = $1", [row.social_account_id, `${err.errorClass}: ${err.message}`]);
      deps.log.warn("instagram token refresh failed", { account_id: row.social_account_id, error_class: err.errorClass });
      if (err.errorClass === "auth") {
        await db.query("update public.social_accounts set status = 'needs_reauth' where id = $1", [row.social_account_id]);
        await notifyOncePerDay(db, row.workspace_id, "account.disconnected", row.social_account_id, { account: row.display_name, reason: "refresh_denied" });
      }
    }
  }

  // 3. Aviso antecipado: faltam ≤ 7 dias e a renovação ainda não aconteceu.
  const warn = await db.query<{ id: string; workspace_id: string; display_name: string; expires_at: string }>(
    `select a.id, a.workspace_id, a.display_name, t.expires_at
       from public.social_account_tokens t join public.social_accounts a on a.id = t.social_account_id
      where t.token_type = 'ig_user' and a.status = 'active' and t.expires_at > now() and t.expires_at < now() + make_interval(days => $1)`,
    [WARN_WINDOW_DAYS],
  );
  for (const a of warn.rows) {
    await notifyOncePerDay(db, a.workspace_id, "account.token_expiring", a.id, { account: a.display_name, expires_at: a.expires_at });
  }
  return { refreshed, failed, expired: expired.rowCount ?? 0 };
}
