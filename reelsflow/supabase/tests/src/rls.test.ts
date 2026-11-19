import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DENIED, addMember, asAdmin, asUser, createUser, createWorkspaceAs, expectPgError, pool, uniqueEmail } from "./helpers";

afterAll(async () => {
  await pool.end();
});

const DOMAIN_TABLES = [
  "profiles",
  "workspaces",
  "workspace_members",
  "subscriptions",
  "usage_records",
  "notifications",
  "audit_logs",
] as const;

describe("RLS habilitado", () => {
  it("todas as tabelas de public têm RLS ativo", async () => {
    const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const without = rows.filter((r) => !r.relrowsecurity).map((r) => r.relname);
    expect(without).toEqual([]);
  });
});

describe("anon", () => {
  it.each(DOMAIN_TABLES)("não lê %s", async (table) => {
    await expectPgError(
      asUser(null, (db) => db.query(`select * from public.${table} limit 1`)),
      DENIED,
    );
  });

  it("não executa create_workspace", async () => {
    await expectPgError(
      asUser(null, (db) => db.query("select public.create_workspace('X Y', 'UTC')")),
      DENIED,
    );
  });
});

describe("signup e profile", () => {
  it("cria profile automaticamente com display_name", async () => {
    const id = await createUser({ email: uniqueEmail("p"), displayName: "Ana Lima" });
    const { rows } = await pool.query("select display_name, default_timezone from public.profiles where id = $1", [id]);
    expect(rows[0]).toEqual({ display_name: "Ana Lima", default_timezone: "America/Sao_Paulo" });
  });
});

describe("create_workspace", () => {
  it("cria workspace, membership owner, assinatura starter e auditoria", async () => {
    const a = await createUser({ email: uniqueEmail("a") });
    const ws = await createWorkspaceAs(a, "Agência Ação");
    expect(ws.slug).toMatch(/^agencia-acao-[0-9a-f]{6}$/);

    const role = await pool.query("select role from public.workspace_members where workspace_id = $1 and user_id = $2", [ws.id, a]);
    expect(role.rows[0]?.role).toBe("owner");
    const sub = await pool.query("select plan from public.subscriptions where workspace_id = $1", [ws.id]);
    expect(sub.rows[0]?.plan).toBe("starter");
    const audit = await pool.query("select action from public.audit_logs where workspace_id = $1", [ws.id]);
    expect(audit.rows.map((r) => r.action)).toContain("workspace.created");
  });

  it("recusa e-mail não confirmado", async () => {
    const u = await createUser({ email: uniqueEmail("unconfirmed"), confirmed: false });
    await expectPgError(
      asUser(u, (db) => db.query("select public.create_workspace('Meu Espaço', 'UTC')")),
      DENIED,
    );
  });

  it("recusa fuso inválido e nome curto", async () => {
    const u = await createUser({ email: uniqueEmail("tz") });
    await expectPgError(asUser(u, (db) => db.query("select public.create_workspace('Meu Espaço', 'Mars/Base')")), ["22023"]);
    await expectPgError(asUser(u, (db) => db.query("select public.create_workspace('x', 'UTC')")), ["22023"]);
  });

  it("insert direto em workspaces é negado", async () => {
    const u = await createUser({ email: uniqueEmail("direct") });
    await expectPgError(
      asUser(u, (db) => db.query("insert into public.workspaces (name, slug) values ('Direto', 'direto')")),
      DENIED,
    );
  });
});

describe("isolamento entre workspaces", () => {
  let a: string;
  let b: string;
  let wsA: { id: string; slug: string };
  let wsB: { id: string; slug: string };

  beforeAll(async () => {
    a = await createUser({ email: uniqueEmail("iso-a"), displayName: "Usuária A" });
    b = await createUser({ email: uniqueEmail("iso-b"), displayName: "Usuário B" });
    wsA = await createWorkspaceAs(a, "Workspace A");
    wsB = await createWorkspaceAs(b, "Workspace B");
    await asAdmin((db) =>
      db.query("insert into public.notifications (workspace_id, user_id, type) values ($1, $2, 'test'), ($3, $4, 'test')", [
        wsA.id,
        a,
        wsB.id,
        b,
      ]),
    );
    await asAdmin((db) =>
      db.query("insert into public.usage_records (workspace_id, metric, quantity, period_start) values ($1, 'uploads', 3, current_date)", [wsA.id]),
    );
  });

  it("B não vê workspace, membros, assinatura, uso, notificações nem auditoria de A", async () => {
    await asUser(b, async (db) => {
      for (const [table, col] of [
        ["workspaces", "id"],
        ["workspace_members", "workspace_id"],
        ["subscriptions", "workspace_id"],
        ["usage_records", "workspace_id"],
        ["notifications", "workspace_id"],
        ["audit_logs", "workspace_id"],
      ] as const) {
        const { rowCount } = await db.query(`select 1 from public.${table} where ${col} = $1`, [wsA.id]);
        expect(rowCount, table).toBe(0);
      }
    });
  });

  it("B vê apenas o próprio workspace na listagem geral", async () => {
    const ids = await asUser(b, async (db) => (await db.query<{ id: string }>("select id from public.workspaces")).rows.map((r) => r.id));
    expect(ids).toEqual([wsB.id]);
  });

  it("B não vê o profile de A (não são colegas)", async () => {
    const { rowCount } = await asUser(b, (db) => db.query("select 1 from public.profiles where id = $1", [a]));
    expect(rowCount).toBe(0);
  });

  it("B não altera nem apaga o workspace de A", async () => {
    await asUser(b, async (db) => {
      const up = await db.query("update public.workspaces set name = 'Invadido' where id = $1", [wsA.id]);
      expect(up.rowCount).toBe(0);
      const del = await db.query("delete from public.workspaces where id = $1", [wsA.id]);
      expect(del.rowCount).toBe(0);
    });
    const { rows } = await pool.query("select name from public.workspaces where id = $1", [wsA.id]);
    expect(rows[0]?.name).toBe("Workspace A");
  });

  it("B não se adiciona como membro do workspace de A", async () => {
    await expectPgError(
      asUser(b, (db) =>
        db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [wsA.id, b]),
      ),
      DENIED,
    );
    await expectPgError(
      asUser(b, (db) =>
        db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'viewer')", [wsA.id, b]),
      ),
      DENIED,
    );
  });

  it("B não remove membros de A nem marca notificações de A como lidas", async () => {
    await asUser(b, async (db) => {
      const del = await db.query("delete from public.workspace_members where workspace_id = $1", [wsA.id]);
      expect(del.rowCount).toBe(0);
      const ids = (await pool.query<{ id: string }>("select id from public.notifications where user_id = $1", [a])).rows.map((r) => r.id);
      const { rows } = await db.query<{ n: number }>("select public.mark_notifications_read($1::uuid[]) as n", [ids]);
      expect(rows[0]?.n).toBe(0);
    });
  });

  it("B não altera o profile de A", async () => {
    const { rowCount } = await asUser(b, (db) => db.query("update public.profiles set display_name = 'x' where id = $1", [a]));
    expect(rowCount).toBe(0);
  });
});

describe("RBAC dentro do workspace", () => {
  let owner: string;
  let admin: string;
  let editor: string;
  let viewer: string;
  let outsider: string;
  let ws: { id: string };

  beforeAll(async () => {
    owner = await createUser({ email: uniqueEmail("owner"), displayName: "Owner" });
    admin = await createUser({ email: uniqueEmail("admin"), displayName: "Admin" });
    editor = await createUser({ email: uniqueEmail("editor"), displayName: "Editor" });
    viewer = await createUser({ email: uniqueEmail("viewer"), displayName: "Viewer" });
    outsider = await createUser({ email: uniqueEmail("outsider") });
    ws = await createWorkspaceAs(owner, "Equipe");
    await addMember(ws.id, admin, "admin");
    await addMember(ws.id, editor, "editor");
    await addMember(ws.id, viewer, "viewer");
  });

  it("viewer lê o workspace e os nomes dos colegas", async () => {
    await asUser(viewer, async (db) => {
      expect((await db.query("select 1 from public.workspaces where id = $1", [ws.id])).rowCount).toBe(1);
      expect((await db.query("select 1 from public.profiles where id = $1", [owner])).rowCount).toBe(1);
    });
  });

  it("viewer e editor não alteram configurações do workspace", async () => {
    for (const u of [viewer, editor]) {
      const { rowCount } = await asUser(u, (db) => db.query("update public.workspaces set name = 'Novo' where id = $1", [ws.id]));
      expect(rowCount).toBe(0);
    }
  });

  it("admin altera nome, mas não campos protegidos", async () => {
    const { rowCount } = await asUser(admin, (db) => db.query("update public.workspaces set name = 'Equipe 2' where id = $1", [ws.id]));
    expect(rowCount).toBe(1);
    await expectPgError(asUser(admin, (db) => db.query("update public.workspaces set is_demo = true where id = $1", [ws.id])), DENIED);
    await expectPgError(asUser(admin, (db) => db.query("update public.workspaces set created_by = $2 where id = $1", [ws.id, admin])), DENIED);
    await expectPgError(asUser(admin, (db) => db.query("update public.workspaces set slug = 'x' where id = $1", [ws.id])), DENIED);
  });

  it("admin não apaga o workspace; owner sim (testado com rollback)", async () => {
    const r1 = await asUser(admin, (db) => db.query("delete from public.workspaces where id = $1", [ws.id]));
    expect(r1.rowCount).toBe(0);
    const r2 = await asUser(owner, (db) => db.query("delete from public.workspaces where id = $1", [ws.id]));
    expect(r2.rowCount).toBe(1); // asUser faz rollback
  });

  it("admin não concede owner; owner concede", async () => {
    await expectPgError(
      asUser(admin, (db) => db.query("update public.workspace_members set role = 'owner' where workspace_id = $1 and user_id = $2", [ws.id, editor])),
      DENIED,
    );
    await expectPgError(
      asUser(admin, (db) => db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws.id, outsider])),
      DENIED,
    );
    const ok = await asUser(owner, (db) =>
      db.query("update public.workspace_members set role = 'owner' where workspace_id = $1 and user_id = $2", [ws.id, editor]),
    );
    expect(ok.rowCount).toBe(1);
  });

  it("admin não remove nem rebaixa o owner", async () => {
    const del = await asUser(admin, (db) => db.query("delete from public.workspace_members where workspace_id = $1 and user_id = $2", [ws.id, owner]));
    expect(del.rowCount).toBe(0);
    const up = await asUser(admin, (db) =>
      db.query("update public.workspace_members set role = 'viewer' where workspace_id = $1 and user_id = $2", [ws.id, owner]),
    );
    expect(up.rowCount).toBe(0);
  });

  it("editor não gerencia membros", async () => {
    await expectPgError(
      asUser(editor, (db) => db.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'viewer')", [ws.id, outsider])),
      DENIED,
    );
    const up = await asUser(editor, (db) =>
      db.query("update public.workspace_members set role = 'admin' where workspace_id = $1 and user_id = $2", [ws.id, editor]),
    );
    expect(up.rowCount).toBe(0);
  });

  it("viewer pode sair do workspace", async () => {
    const r = await asUser(viewer, (db) => db.query("delete from public.workspace_members where workspace_id = $1 and user_id = $2", [ws.id, viewer]));
    expect(r.rowCount).toBe(1);
  });

  it("auditoria: viewer não lê, admin lê, ninguém escreve", async () => {
    expect((await asUser(viewer, (db) => db.query("select 1 from public.audit_logs where workspace_id = $1", [ws.id]))).rowCount).toBe(0);
    expect((await asUser(admin, (db) => db.query("select 1 from public.audit_logs where workspace_id = $1", [ws.id]))).rowCount).toBeGreaterThan(0);
    await expectPgError(
      asUser(admin, (db) => db.query("insert into public.audit_logs (workspace_id, action, entity) values ($1, 'x', 'y')", [ws.id])),
      DENIED,
    );
    await expectPgError(asUser(owner, (db) => db.query("delete from public.audit_logs where workspace_id = $1", [ws.id])), DENIED);
  });

  it("membros não escrevem em subscriptions nem usage_records", async () => {
    await expectPgError(asUser(owner, (db) => db.query("update public.subscriptions set plan = 'agency' where workspace_id = $1", [ws.id])), DENIED);
    await expectPgError(
      asUser(owner, (db) => db.query("insert into public.usage_records (workspace_id, metric, period_start) values ($1, 'uploads', current_date)", [ws.id])),
      DENIED,
    );
  });

  it("schema app não é acessível ao anon", async () => {
    await expectPgError(asUser(null, (db) => db.query("select app.has_role(gen_random_uuid(), 'viewer')")), DENIED);
  });
});

describe("proteção do último owner e exclusão de conta", () => {
  it("último owner não se rebaixa nem sai enquanto houver outros membros", async () => {
    const o = await createUser({ email: uniqueEmail("lo-o") });
    const m = await createUser({ email: uniqueEmail("lo-m") });
    const ws = await createWorkspaceAs(o, "Último owner");
    await addMember(ws.id, m, "editor");
    await expectPgError(
      asUser(o, (db) => db.query("update public.workspace_members set role = 'admin' where workspace_id = $1 and user_id = $2", [ws.id, o])),
      ["P0001"],
    );
    await expectPgError(
      asUser(o, (db) => db.query("delete from public.workspace_members where workspace_id = $1 and user_id = $2", [ws.id, o])),
      ["P0001"],
    );
    const blockers = await asUser(o, (db) => db.query("select * from public.account_deletion_blockers()"));
    expect(blockers.rows).toEqual([{ workspace_id: ws.id, workspace_name: "Último owner", other_members: 1 }]);
  });

  it("excluir a conta do último owner com outros membros é bloqueado no banco", async () => {
    const o = await createUser({ email: uniqueEmail("del-o") });
    const m = await createUser({ email: uniqueEmail("del-m") });
    const ws = await createWorkspaceAs(o, "Bloqueio");
    await addMember(ws.id, m, "viewer");
    await expectPgError(pool.query("delete from auth.users where id = $1", [o]), ["P0001"]);
  });

  it("excluir a conta com segundo owner preserva o workspace", async () => {
    const o1 = await createUser({ email: uniqueEmail("two-o1") });
    const o2 = await createUser({ email: uniqueEmail("two-o2") });
    const ws = await createWorkspaceAs(o1, "Dois owners");
    await addMember(ws.id, o2, "owner");
    expect((await asUser(o1, (db) => db.query("select * from public.account_deletion_blockers()"))).rowCount).toBe(0);
    await pool.query("delete from auth.users where id = $1", [o1]);
    const { rows } = await pool.query("select created_by from public.workspaces where id = $1", [ws.id]);
    expect(rows).toEqual([{ created_by: null }]);
  });

  it("excluir a conta de membro único remove o workspace e dados dependentes", async () => {
    const o = await createUser({ email: uniqueEmail("solo") });
    const ws = await createWorkspaceAs(o, "Solo");
    await pool.query("delete from auth.users where id = $1", [o]);
    for (const [t, c] of [
      ["workspaces", "id"],
      ["workspace_members", "workspace_id"],
      ["subscriptions", "workspace_id"],
      ["audit_logs", "workspace_id"],
    ] as const) {
      const { rowCount } = await pool.query(`select 1 from public.${t} where ${c} = $1`, [ws.id]);
      expect(rowCount, t).toBe(0);
    }
    expect((await pool.query("select 1 from public.profiles where id = $1", [o])).rowCount).toBe(0);
  });

  it("membro único que sai apaga o workspace", async () => {
    const o = await createUser({ email: uniqueEmail("leave") });
    const ws = await createWorkspaceAs(o, "Sair");
    await asUser(o, (db) => db.query("delete from public.workspace_members where workspace_id = $1 and user_id = $2", [ws.id, o]), {
      commit: true,
    });
    expect((await pool.query("select 1 from public.workspaces where id = $1", [ws.id])).rowCount).toBe(0);
  });
});

describe("notificações e profile", () => {
  it("usuário vê e marca como lidas apenas as próprias", async () => {
    const o = await createUser({ email: uniqueEmail("n-o") });
    const m = await createUser({ email: uniqueEmail("n-m") });
    const ws = await createWorkspaceAs(o, "Notif");
    await addMember(ws.id, m, "viewer");
    await pool.query("insert into public.notifications (workspace_id, user_id, type) values ($1, $2, 'a'), ($1, $3, 'b')", [ws.id, o, m]);

    const seen = await asUser(m, (db) => db.query<{ type: string; id: string }>("select id, type from public.notifications"));
    expect(seen.rows.map((r) => r.type)).toEqual(["b"]);

    const all = (await pool.query<{ id: string }>("select id from public.notifications where workspace_id = $1", [ws.id])).rows.map((r) => r.id);
    const marked = await asUser(m, (db) => db.query<{ n: number }>("select public.mark_notifications_read($1::uuid[]) as n", [all]));
    expect(marked.rows[0]?.n).toBe(1);

    await expectPgError(asUser(m, (db) => db.query("update public.notifications set type = 'x'")), DENIED);
  });

  it("usuário atualiza o próprio profile; fuso é validado; colunas protegidas negadas", async () => {
    const u = await createUser({ email: uniqueEmail("prof") });
    const r = await asUser(u, (db) => db.query("update public.profiles set display_name = 'Novo Nome', default_timezone = 'Europe/Lisbon' where id = $1", [u]));
    expect(r.rowCount).toBe(1);
    await expectPgError(asUser(u, (db) => db.query("update public.profiles set default_timezone = 'Fake/Zone' where id = $1", [u])), ["22023"]);
    await expectPgError(asUser(u, (db) => db.query("update public.profiles set id = gen_random_uuid() where id = $1", [u])), DENIED);
  });
});
