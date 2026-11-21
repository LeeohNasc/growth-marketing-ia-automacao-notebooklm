import type { ZernioClient } from "@reelsflow/connectors/server";
import type { Db } from "../db";
import type { Logger } from "../log";
import { workspaceAdmins } from "./rules";

/**
 * Sincroniza o estado das contas conectadas pela Zernio (GET /v1/accounts/health, uma chamada para
 * todas), no máximo a cada 10 min — o plano gratuito da Zernio permite 60 requisições/min.
 *  - needsReconnect / canPost=false → conta "requer reconexão" (a fila segura as publicações) + aviso;
 *  - de volta a canPost=true → conta reativada automaticamente (as publicações seguem sozinhas).
 */
export const ZERNIO_HEALTH_EVERY_MINUTES = 10;

export async function syncZernioAccounts(db: Db, deps: { zernio: ZernioClient; log: Logger }) {
  const due = await db.query<{ id: string; workspace_id: string; external_account_id: string; status: string; display_name: string }>(
    `select id, workspace_id, external_account_id, status, display_name from public.social_accounts
      where provider = 'zernio' and status in ('active', 'needs_reauth')
        and coalesce((settings ->> 'zernio_checked_at')::timestamptz, 'epoch') < now() - make_interval(mins => $1)`,
    [ZERNIO_HEALTH_EVERY_MINUTES],
  );
  if (!due.rows.length) return { checked: 0, changed: 0 };

  const health = new Map((await deps.zernio.accountsHealth()).map((h) => [h.accountId, h]));
  let changed = 0;
  for (const a of due.rows) {
    const h = health.get(a.external_account_id);
    // Conta sumiu da Zernio (desconectada/removida lá) ou não pode publicar.
    const healthy = Boolean(h && h.canPost !== false && !h.needsReconnect);
    const next = healthy ? "active" : "needs_reauth";
    await db.query(
      `update public.social_accounts
          set status = $2, settings = settings || jsonb_build_object('zernio_checked_at', now(), 'zernio_health', $3::text)
        where id = $1 and provider = 'zernio'`,
      [a.id, next, h?.status ?? "missing"],
    );
    if (next !== a.status) {
      changed++;
      deps.log.warn("zernio account status changed", { account_id: a.id, from: a.status, to: next });
      if (next === "needs_reauth") {
        for (const uid of await workspaceAdmins(db, a.workspace_id)) {
          await db.query(
            `insert into public.notifications (workspace_id, user_id, type, payload)
             select $1, $2, 'account.disconnected', $3::jsonb
              where not exists (select 1 from public.notifications n where n.user_id = $2 and n.type = 'account.disconnected'
                                  and n.payload ->> 'account_id' = $4 and n.created_at > now() - interval '1 day')`,
            [a.workspace_id, uid, JSON.stringify({ account_id: a.id, account: a.display_name, reason: "zernio_needs_reconnect" }), a.id],
          );
        }
      }
    }
  }
  return { checked: due.rows.length, changed };
}
