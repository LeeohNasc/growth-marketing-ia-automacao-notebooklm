import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DENIED, addMember, asUser, createUser, createWorkspaceAs, expectPgError, pool, uniqueEmail } from "./helpers";

afterAll(async () => {
  await pool.end();
});

const setPlan = (ws: string, plan: string, limits = {}) =>
  pool.query("update public.subscriptions set plan = $2, limits = $3 where workspace_id = $1", [ws, plan, JSON.stringify(limits)]);

describe("convites de equipe", () => {
  let owner: string;
  let admin: string;
  let editor: string;
  let ws: string;

  beforeAll(async () => {
    owner = await createUser({ email: uniqueEmail("t-owner") });
    admin = await createUser({ email: uniqueEmail("t-admin") });
    editor = await createUser({ email: uniqueEmail("t-editor") });
    ws = (await createWorkspaceAs(owner, "Equipe Pro")).id;
    await setPlan(ws, "agency");
    await addMember(ws, admin, "admin");
    await addMember(ws, editor, "editor");
  });

  const invite = (by: string, email: string, role = "editor", commit = true) =>
    asUser(by, async (db) => (await db.query<{ t: string }>("select public.create_invitation($1, $2, $3) as t", [ws, email, role])).rows[0]!.t, { commit });

  it("admin convida; token em claro só no retorno, banco guarda hash", async () => {
    const email = uniqueEmail("convidada");
    const token = await invite(admin, email.toUpperCase());
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    const row = (await pool.query("select email, token_hash from public.workspace_invitations where email = $1", [email])).rows[0];
    expect(row.email).toBe(email);
    expect(row.token_hash).not.toBe(token);
    const seen = await asUser(admin, (db) => db.query("select email, role from public.workspace_invitations where workspace_id = $1 and email = $2", [ws, email]));
    expect(seen.rows[0]).toEqual({ email, role: "editor" });
    await expectPgError(asUser(admin, (db) => db.query("select token_hash from public.workspace_invitations")), DENIED);
  });

  it("editor não convida; admin não convida owner; owner convida owner", async () => {
    await expectPgError(asUser(editor, (db) => db.query("select public.create_invitation($1, $2, 'viewer')", [ws, uniqueEmail("x")])), DENIED);
    await expectPgError(invite(admin, uniqueEmail("y"), "owner", false), DENIED);
    expect(await invite(owner, uniqueEmail("z"), "owner", false)).toMatch(/^[0-9a-f]{48}$/);
  });

  it("aceite exige o mesmo e-mail confirmado; uso único", async () => {
    const email = uniqueEmail("aceite");
    const token = await invite(admin, email, "viewer");
    const intruder = await createUser({ email: uniqueEmail("intruso") });
    await expectPgError(asUser(intruder, (db) => db.query("select public.accept_invitation($1)", [token])), DENIED);
    const unconfirmed = await createUser({ email, confirmed: false }).catch(() => null);
    expect(unconfirmed).not.toBeNull();
    await expectPgError(asUser(unconfirmed!, (db) => db.query("select public.accept_invitation($1)", [token])), DENIED);
    await pool.query("update auth.users set email_confirmed_at = now() where id = $1", [unconfirmed]);
    const slug = await asUser(unconfirmed!, async (db) => (await db.query("select public.accept_invitation($1) as s", [token])).rows[0].s, { commit: true });
    expect(slug).toMatch(/^equipe-pro-/);
    const role = await pool.query("select role from public.workspace_members where workspace_id = $1 and user_id = $2", [ws, unconfirmed]);
    expect(role.rows[0].role).toBe("viewer");
    await expectPgError(asUser(unconfirmed!, (db) => db.query("select public.accept_invitation($1)", [token])), ["P0002"]);
  });

  it("convite revogado, expirado ou token errado é recusado; preview não exige login", async () => {
    const email = uniqueEmail("rev");
    const token = await invite(admin, email);
    const id = (await pool.query("select id from public.workspace_invitations where email = $1", [email])).rows[0].id;
    const prev = await asUser(null, (db) => db.query("select * from public.invitation_preview($1)", [token]));
    expect(prev.rows[0]).toMatchObject({ workspace_name: "Equipe Pro", role: "editor", valid: true });
    await asUser(admin, (db) => db.query("select public.revoke_invitation($1)", [id]), { commit: true });
    const u = await createUser({ email });
    await expectPgError(asUser(u, (db) => db.query("select public.accept_invitation($1)", [token])), ["P0002"]);
    await expectPgError(asUser(u, (db) => db.query("select public.accept_invitation('nada')")), ["P0002"]);

    const t2 = await invite(admin, email);
    await pool.query("update public.workspace_invitations set expires_at = now() - interval '1 s' where email = $1 and revoked_at is null", [email]);
    await expectPgError(asUser(u, (db) => db.query("select public.accept_invitation($1)", [t2])), ["P0002"]);
  });

  it("não convida quem já é membro; novo convite substitui o pendente", async () => {
    const editorEmail = (await pool.query("select email from auth.users where id = $1", [editor])).rows[0].email;
    await expectPgError(invite(admin, editorEmail, "viewer", false), ["P0001"]);
    const email = uniqueEmail("dup");
    const t1 = await invite(admin, email);
    await invite(admin, email, "admin");
    const u = await createUser({ email });
    await expectPgError(asUser(u, (db) => db.query("select public.accept_invitation($1)", [t1])), ["P0002"]);
  });
});

describe("limites de plano (provisórios)", () => {
  it("Starter: 1 assento — convite bloqueado", async () => {
    const o = await createUser({ email: uniqueEmail("s1") });
    const ws = (await createWorkspaceAs(o, "Starter")).id;
    const err = await asUser(o, (db) => db.query("select public.create_invitation($1, $2, 'editor')", [ws, uniqueEmail("n")])).catch((e) => e);
    expect(err.message).toBe("plan limit: seats");
  });

  it("assentos contam convites pendentes", async () => {
    const o = await createUser({ email: uniqueEmail("s2") });
    const ws = (await createWorkspaceAs(o, "Pro")).id;
    await setPlan(ws, "pro"); // 3 assentos
    for (let i = 0; i < 2; i++) await asUser(o, (db) => db.query("select public.create_invitation($1, $2, 'editor')", [ws, uniqueEmail(`p${i}`)]), { commit: true });
    const err = await asUser(o, (db) => db.query("select public.create_invitation($1, $2, 'editor')", [ws, uniqueEmail("p3")])).catch((e) => e);
    expect(err.message).toBe("plan limit: seats");
    const usage = await asUser(o, async (db) => (await db.query("select public.workspace_usage($1) as u", [ws])).rows[0].u);
    expect(usage).toMatchObject({ seats: 3, limits: { seats: 3 } });
  });

  it("vídeos e armazenamento bloqueados no registro do upload", async () => {
    const o = await createUser({ email: uniqueEmail("s3") });
    const ws = (await createWorkspaceAs(o, "Mídia")).id;
    await setPlan(ws, "starter", { videos: 1, storage_bytes: 5_000_000 });
    const file = (sha: string, size = 1_000_000) => JSON.stringify([{ name: "v.mp4", size, mime: "video/mp4", sha256: sha.repeat(64) }]);
    await asUser(o, (db) => db.query("select * from public.begin_media_upload($1, $2::jsonb)", [ws, file("a")]), { commit: true });
    expect((await asUser(o, (db) => db.query("select * from public.begin_media_upload($1, $2::jsonb)", [ws, file("b")])).catch((e) => e)).message).toBe("plan limit: videos");
    await setPlan(ws, "starter", { videos: 10, storage_bytes: 1_500_000 });
    expect((await asUser(o, (db) => db.query("select * from public.begin_media_upload($1, $2::jsonb)", [ws, file("c")])).catch((e) => e)).message).toBe("plan limit: storage_bytes");
  });

  it("contas reais: 1 por rede no Starter; reconectar a mesma conta é permitido; simuladas não contam", async () => {
    const o = await createUser({ email: uniqueEmail("s4") });
    const ws = (await createWorkspaceAs(o, "Contas")).id;
    const add = (ext: string, platform = "instagram") =>
      pool.query("insert into public.social_accounts (workspace_id, platform, external_account_id, display_name) values ($1,$2,$3,'x') on conflict (workspace_id, platform, external_account_id) do update set status = 'active'", [ws, platform, ext]);
    await add("ig-a");
    await add("ig-a"); // reconexão
    await add("fb-a", "facebook");
    await expect(add("ig-b")).rejects.toThrow("plan limit: accounts_per_platform");
    for (let i = 0; i < 3; i++) await asUser(o, (db) => db.query("select public.create_simulated_account($1, 'S')", [ws]), { commit: true });
    // desconectada libera a vaga; reativar outra respeita o limite
    await pool.query("update public.social_accounts set status = 'disconnected' where workspace_id = $1 and external_account_id = 'ig-a'", [ws]);
    await add("ig-b");
    await expect(pool.query("update public.social_accounts set status = 'active' where workspace_id = $1 and external_account_id = 'ig-a'", [ws])).rejects.toThrow("plan limit");
  });
});

describe("analytics interno", () => {
  it("taxas, atrasos, por dia e por conta — somente membros", async () => {
    const o = await createUser({ email: uniqueEmail("an") });
    const outsider = await createUser({ email: uniqueEmail("an-x") });
    const ws = (await createWorkspaceAs(o, "Analytics")).id;
    const acc = (await pool.query("insert into public.social_accounts (workspace_id, platform, external_account_id, display_name) values ($1,'mock','a1','Conta A') returning id", [ws])).rows[0].id;
    const mk = async (status: string, offsetH: number, delayS: number | null, attempts = 1) => {
      const at = new Date(Date.now() - offsetH * 3600_000);
      await pool.query(
        `insert into public.publication_jobs (workspace_id, social_account_id, local_date, local_time, timezone, scheduled_at, status, published_at, attempt_count, last_error_class)
         values ($1,$2,current_date,'09:00','UTC',$3,'draft',$4,$5,$6)`,
        [ws, acc, at, delayS === null ? null : new Date(at.getTime() + delayS * 1000), attempts, status === "failed_permanent" ? "permanent" : null],
      );
      // força o status final ignorando a máquina de estados (dado de teste)
      await pool.query("alter table public.publication_jobs disable trigger publication_jobs_guard_status");
      await pool.query("update public.publication_jobs set status = $2 where workspace_id = $1 and status = 'draft'", [ws, status]);
      await pool.query("alter table public.publication_jobs enable trigger publication_jobs_guard_status");
    };
    await mk("published", 30, 10);
    await mk("published", 26, 30);
    await mk("published", 2, 50, 3);
    await mk("failed_permanent", 5, null);
    await mk("scheduled", -5, null);

    const r = await asUser(o, async (db) =>
      (await db.query("select public.publication_analytics($1, now() - interval '7 days', now() + interval '1 day') as a", [ws])).rows[0].a,
    );
    expect(r).toMatchObject({ published: 3, failed: 1, delay_p50_s: 30 });
    expect(r.delay_p95_s).toBeCloseTo(48, 0);
    expect(r.first_attempt_rate).toBeCloseTo(0.6667, 3);
    expect(r.by_account[0]).toMatchObject({ account: "Conta A", published: 3, failed: 1, total: 5 });
    expect(r.failure_reasons).toEqual([{ reason: "permanent", n: 1 }]);
    expect(r.by_day.reduce((s: number, d: { published: number }) => s + d.published, 0)).toBe(3);

    await expectPgError(asUser(outsider, (db) => db.query("select public.publication_analytics($1, now() - interval '1 day', now())", [ws])), DENIED);
    await expectPgError(asUser(o, (db) => db.query("select public.publication_analytics($1, now(), now() - interval '1 day')", [ws])), ["22023"]);
  });
});
