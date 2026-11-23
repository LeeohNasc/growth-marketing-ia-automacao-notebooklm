import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DENIED, addMember, asUser, createUser, createWorkspaceAs, expectPgError, pool, uniqueEmail } from "./helpers";

afterAll(async () => {
  await pool.end();
});

describe("confiabilidade — permissões", () => {
  let owner: string;
  let member: string;
  let outsider: string;
  let ws: string;

  beforeAll(async () => {
    owner = await createUser({ email: uniqueEmail("rl-o") });
    member = await createUser({ email: uniqueEmail("rl-m") });
    outsider = await createUser({ email: uniqueEmail("rl-x") });
    ws = (await createWorkspaceAs(owner, "Alertas")).id;
    await createWorkspaceAs(outsider, "Outro");
    await addMember(ws, member, "viewer");
    await pool.query("select app.raise_ops_alert('zernio_api_key', 'critical', null, 'Chave inválida', '{}'::jsonb, 'zernio_api_key')");
  });

  it("alertas operacionais: nenhum usuário (nem owner) lê, grava ou dispara; vigia não é chamável pelo navegador", async () => {
    for (const u of [owner, member, outsider]) {
      await expectPgError(asUser(u, (db) => db.query("select * from public.ops_alerts")), DENIED);
      await expectPgError(asUser(u, (db) => db.query("select public.worker_watchdog()")), DENIED);
      await expectPgError(asUser(u, (db) => db.query("select app.raise_ops_alert('x', 'error', null, 'x', '{}'::jsonb, 'x')")), DENIED);
    }
    await expectPgError(asUser(null, (db) => db.query("select * from public.ops_alerts")), DENIED);
  });

  it("preferências de aviso: cada um vê e altera só as suas, e só em workspace do qual é membro", async () => {
    await asUser(member, (db) => db.query("insert into public.notification_preferences (user_id, workspace_id, email_enabled) values ($1, $2, false)", [member, ws]), { commit: true });
    expect((await asUser(member, (db) => db.query("select email_enabled from public.notification_preferences"))).rows).toEqual([{ email_enabled: false }]);
    expect((await asUser(owner, (db) => db.query("select 1 from public.notification_preferences"))).rowCount).toBe(0);
    expect((await asUser(owner, (db) => db.query("update public.notification_preferences set email_enabled = true where user_id = $1", [member]))).rowCount).toBe(0);
    // não cria preferência em nome de outro, nem em workspace alheio
    await expectPgError(asUser(owner, (db) => db.query("insert into public.notification_preferences (user_id, workspace_id) values ($1, $2)", [member, ws])), DENIED);
    await expectPgError(asUser(outsider, (db) => db.query("insert into public.notification_preferences (user_id, workspace_id) values ($1, $2)", [outsider, ws])), DENIED);
  });

  it("o navegador não marca e-mail como enviado nem mexe no registro de entrega", async () => {
    const n = (await pool.query("insert into public.notifications (workspace_id, user_id, type) values ($1, $2, 'publication.failed') returning id, email_status", [ws, member])).rows[0];
    expect(n.email_status).toBe("pending");
    await expectPgError(asUser(member, (db) => db.query("update public.notifications set email_status = 'sent' where id = $1", [n.id])), DENIED);
  });
});
