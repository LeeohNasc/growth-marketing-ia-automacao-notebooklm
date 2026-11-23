import type { Db } from "../db";
import type { Logger } from "../log";

/**
 * Avisos importantes por e-mail (falha de publicação, conta desconectada, worker parado…).
 *
 * - Fila: a própria notificação (email_status = 'pending', marcada pelo banco só para tipos importantes).
 * - Respeita preferências (desligar e-mail ou categorias), limite por pessoa (10/h) e limite diário
 *   global (padrão 90/dia, abaixo da franquia gratuita de provedores como o Resend).
 * - Sem duplicar: mesma pessoa + mesmo tipo + mesmo assunto em 1 h → não reenvia.
 * - Conteúdo mínimo: tipo do aviso, conta/campanha e link para o ReelsFlow. Nunca tokens, URLs
 *   assinadas ou mensagens técnicas brutas da plataforma.
 * - Sem provedor configurado: nada é enviado; os avisos ficam "skipped" (provider_not_configured)
 *   e continuam visíveis dentro do sistema.
 */
export type EmailMessage = { to: string; subject: string; text: string };
export interface EmailSender {
  readonly name: string;
  send(msg: EmailMessage): Promise<void>;
}

export class EmailSendError extends Error {
  constructor(message: string, readonly permanent: boolean) {
    super(message);
  }
}

/** Resend (https://resend.com) — só é usado se RESEND_API_KEY e EMAIL_FROM estiverem configurados. */
export class ResendSender implements EmailSender {
  readonly name = "resend";
  constructor(private cfg: { apiKey: string; from: string; fetchImpl?: typeof fetch }) {}
  async send(msg: EmailMessage) {
    const res = await (this.cfg.fetchImpl ?? fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.cfg.from, to: [msg.to], subject: msg.subject, text: msg.text }),
    });
    if (!res.ok) {
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      throw new EmailSendError(`HTTP ${res.status}`, permanent);
    }
  }
}

const SUBJECTS: Record<string, string> = {
  "publication.failed": "Uma publicação falhou",
  "publication.needs_review": "Uma publicação precisa da sua revisão",
  "publication.late": "Uma publicação atrasou e foi para revisão",
  "account.disconnected": "Uma conta precisa ser reconectada",
  "account.token_expiring": "A autorização de uma conta vai expirar",
  "system.worker_stalled": "Publicações em espera: processamento interrompido",
  "upload.failed": "Um vídeo enviado não pôde ser processado",
  "plan.limit_reached": "Limite do plano atingido",
};
const ACTION: Record<string, string> = {
  "publication.failed": "Veja o motivo na Fila de Publicações e, se quiser, reagende.",
  "publication.needs_review": "Abra a Fila de Publicações para decidir o que fazer.",
  "publication.late": "Abra a Fila de Publicações para reagendar ou descartar.",
  "account.disconnected": "Abra Contas Conectadas e reconecte a conta. As publicações dela aguardam.",
  "account.token_expiring": "Abra Contas Conectadas e renove a autorização.",
  "system.worker_stalled": "Nossa equipe já foi alertada. As publicações vencidas aguardam e nada é publicado em rajada.",
  "upload.failed": "Abra a Biblioteca para ver o motivo e enviar outro arquivo.",
  "plan.limit_reached": "Abra Assinatura para ver o uso e os planos.",
};

type Pending = { id: string; workspace_id: string; user_id: string; type: string; payload: Record<string, unknown>; email_attempts: number; email: string | null; workspace: string; slug: string; email_enabled: boolean | null; muted_types: string[] | null };

/** Monta o texto (sem dados sensíveis). Exportado para teste. */
export function composeEmail(p: Pick<Pending, "type" | "payload" | "workspace" | "slug">, appUrl: string | null): { subject: string; text: string } {
  const subject = `[ReelsFlow] ${SUBJECTS[p.type] ?? "Novo aviso"}`;
  const pick = (k: string) => (typeof p.payload[k] === "string" ? String(p.payload[k]).slice(0, 120) : null);
  const lines = [`Workspace: ${p.workspace}`];
  if (pick("account")) lines.push(`Conta: ${pick("account")}`);
  if (pick("campaign")) lines.push(`Campanha: ${pick("campaign")}`);
  if (pick("media")) lines.push(`Vídeo: ${pick("media")}`);
  lines.push("", ACTION[p.type] ?? "Abra o ReelsFlow para ver os detalhes.");
  if (appUrl) lines.push("", `${appUrl.replace(/\/$/, "")}/w/${p.slug}/notifications`);
  lines.push("", "Você recebe este e-mail porque é membro do workspace. Ajuste em Notificações → Preferências.");
  return { subject, text: lines.join("\n") };
}

export async function deliverEmails(
  db: Db,
  deps: { sender: EmailSender | null; log: Logger; appUrl?: string | null; batch?: number; perUserPerHour?: number; dailyCap?: number },
): Promise<{ sent: number; skipped: number; failed: number }> {
  const out = { sent: 0, skipped: 0, failed: 0 };
  const { rows } = await db.query<Pending>(
    `select n.id, n.workspace_id, n.user_id, n.type, n.payload, n.email_attempts, u.email, w.name as workspace, w.slug,
            p.email_enabled, p.muted_types
       from public.notifications n
       join auth.users u on u.id = n.user_id
       join public.workspaces w on w.id = n.workspace_id
       left join public.notification_preferences p on p.user_id = n.user_id and p.workspace_id = n.workspace_id
      where n.email_status = 'pending' and n.created_at > now() - interval '24 hours'
      order by n.created_at limit $1`,
    [deps.batch ?? 20],
  );
  if (!rows.length) return out;
  const mark = (id: string, status: "sent" | "skipped" | "failed" | "pending", error: string | null) =>
    db.query(
      `update public.notifications set email_status = $2, email_error = $3, email_attempts = email_attempts + case when $2 in ('sent', 'failed', 'pending') then 1 else 0 end,
              emailed_at = case when $2 = 'sent' then now() else emailed_at end
        where id = $1 and email_status = 'pending'`,
      [id, status, error],
    );
  const sentToday = Number((await db.query<{ n: string }>("select count(*) as n from public.notifications where emailed_at > now() - interval '24 hours'")).rows[0]?.n ?? 0);
  let budget = (deps.dailyCap ?? 90) - sentToday;

  for (const n of rows) {
    if (!deps.sender) {
      await mark(n.id, "skipped", "provider_not_configured");
      out.skipped++;
      continue;
    }
    if (!n.email) {
      await mark(n.id, "skipped", "no_email");
      out.skipped++;
      continue;
    }
    if (n.email_enabled === false || (n.muted_types ?? []).includes(n.type)) {
      await mark(n.id, "skipped", "user_preference");
      out.skipped++;
      continue;
    }
    const subjectKey = String(n.payload.account_id ?? n.payload.job_id ?? n.payload.campaign ?? "");
    const recent = await db.query<{ total: string; same: string }>(
      `select count(*) as total,
              count(*) filter (where type = $2 and coalesce(payload ->> 'account_id', payload ->> 'job_id', payload ->> 'campaign', '') = $3) as same
         from public.notifications where user_id = $1 and emailed_at > now() - interval '1 hour'`,
      [n.user_id, n.type, subjectKey],
    );
    if (Number(recent.rows[0]?.same ?? 0) > 0) {
      await mark(n.id, "skipped", "duplicate_recent");
      out.skipped++;
      continue;
    }
    if (Number(recent.rows[0]?.total ?? 0) >= (deps.perUserPerHour ?? 10) || budget <= 0) {
      await mark(n.id, "skipped", budget <= 0 ? "daily_cap" : "user_rate_limit");
      out.skipped++;
      continue;
    }
    try {
      await deps.sender.send({ to: n.email, ...composeEmail(n, deps.appUrl ?? null) });
      await mark(n.id, "sent", null);
      budget--;
      out.sent++;
    } catch (e) {
      const permanent = e instanceof EmailSendError ? e.permanent : false;
      const giveUp = permanent || n.email_attempts + 1 >= 3;
      await mark(n.id, giveUp ? "failed" : "pending", (e instanceof Error ? e.message : String(e)).slice(0, 300));
      if (giveUp) out.failed++;
      deps.log.warn("email delivery failed", { notification_id: n.id, provider: deps.sender.name, permanent, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (out.sent || out.failed) deps.log.info("emails delivered", out);
  return out;
}
