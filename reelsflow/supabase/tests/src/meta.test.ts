import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DENIED, addMember, asUser, createUser, createWorkspaceAs, expectPgError, pool, uniqueEmail } from "./helpers";

afterAll(async () => {
  await pool.end();
});

const sealed = (n: string) => ({ ciphertext: `cifra-${n}`, iv: "iv", tag: "tag", keyVersion: 1 });
const pending = (metaUser = "mu-1") => ({
  meta_user_id: metaUser,
  user_name: "Ana",
  granted: ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish"],
  candidates: [
    { key: "facebook:p1", platform: "facebook", external_id: "p1", name: "Loja", page_id: "p1", can_publish: true, missing_scopes: [], page_token: sealed("p1") },
    { key: "instagram:ig1", platform: "instagram", external_id: "ig1", name: "@loja", page_id: "p1", can_publish: true, missing_scopes: [], page_token: sealed("ig1") },
  ],
});

describe("integração Meta — banco", () => {
  let owner: string;
  let admin: string;
  let editor: string;
  let outsider: string;
  let ws: string;

  beforeAll(async () => {
    owner = await createUser({ email: uniqueEmail("m-o") });
    admin = await createUser({ email: uniqueEmail("m-a") });
    editor = await createUser({ email: uniqueEmail("m-e") });
    outsider = await createUser({ email: uniqueEmail("m-x") });
    ws = (await createWorkspaceAs(owner, "Meta")).id;
    await addMember(ws, admin, "admin");
    await addMember(ws, editor, "editor");
  });

  const begin = (u: string) => asUser(u, async (db) => (await db.query<{ s: string }>("select public.begin_oauth($1, 'meta') as s", [ws])).rows[0]!.s, { commit: true });

  it("somente admin inicia; state é aleatório (64 hex)", async () => {
    await expectPgError(asUser(editor, (db) => db.query("select public.begin_oauth($1, 'meta')", [ws])), DENIED);
    await expectPgError(asUser(outsider, (db) => db.query("select public.begin_oauth($1, 'meta')", [ws])), DENIED);
    expect(await begin(admin)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fluxo completo cria contas, tokens cifrados e capacidades; state é de uso único", async () => {
    const st = await begin(admin);
    const slug = await asUser(admin, async (db) => (await db.query("select public.complete_oauth($1, $2::jsonb) as s", [st, JSON.stringify(pending())])).rows[0].s, { commit: true });
    expect(slug).toMatch(/^meta-/);

    const view = await asUser(admin, async (db) => (await db.query("select public.get_oauth_pending($1) as p", [st])).rows[0].p);
    expect(view.candidates).toHaveLength(2);
    expect(JSON.stringify(view)).not.toContain("cifra-"); // tokens nunca voltam ao cliente

    const n = await asUser(admin, async (db) => (await db.query("select public.finalize_oauth($1, $2::text[]) as n", [st, ["instagram:ig1"]])).rows[0].n, { commit: true });
    expect(n).toBe(1);
    const acc = (await pool.query("select id, platform, status, settings from public.social_accounts where workspace_id = $1 and external_account_id = 'ig1'", [ws])).rows[0];
    expect(acc).toMatchObject({ platform: "instagram", status: "active", settings: { page_id: "p1", meta_user_id: "mu-1" } });
    const tok = (await pool.query("select ciphertext, token_type, meta_user_id from public.social_account_tokens where social_account_id = $1", [acc.id])).rows[0];
    expect(tok).toEqual({ ciphertext: "cifra-ig1", token_type: "page", meta_user_id: "mu-1" });
    const caps = await asUser(editor, (db) => db.query("select capability, granted from public.social_account_capabilities where social_account_id = $1 order by capability", [acc.id]));
    expect(caps.rows.find((r) => r.capability === "reels_publish")?.granted).toBe(true);

    // uso único
    await expectPgError(asUser(admin, (db) => db.query("select public.finalize_oauth($1, $2::text[])", [st, ["facebook:p1"]])), DENIED);
    await expectPgError(asUser(admin, (db) => db.query("select public.get_oauth_pending($1)", [st])), DENIED);
  });

  it("state de outro usuário, expirado ou com callback repetido é recusado", async () => {
    const st = await begin(admin);
    expect((await asUser(admin, (db) => db.query("select public.check_oauth_state($1) as ok", [st]))).rows[0].ok).toBe(true);
    expect((await asUser(owner, (db) => db.query("select public.check_oauth_state($1) as ok", [st]))).rows[0].ok).toBe(false);
    await expectPgError(asUser(owner, (db) => db.query("select public.complete_oauth($1, $2::jsonb)", [st, JSON.stringify(pending())])), DENIED);
    await asUser(admin, (db) => db.query("select public.complete_oauth($1, $2::jsonb)", [st, JSON.stringify(pending())]), { commit: true });
    await expectPgError(asUser(admin, (db) => db.query("select public.complete_oauth($1, $2::jsonb)", [st, JSON.stringify(pending())])), DENIED);

    const st2 = await begin(admin);
    await pool.query("update public.oauth_states set expires_at = now() - interval '1 second' where state = $1", [st2]);
    await expectPgError(asUser(admin, (db) => db.query("select public.complete_oauth($1, $2::jsonb)", [st2, JSON.stringify(pending())])), DENIED);
  });

  it("tokens e estados OAuth são inacessíveis a qualquer usuário", async () => {
    for (const u of [owner, admin, editor]) {
      await expectPgError(asUser(u, (db) => db.query("select * from public.social_account_tokens")), DENIED);
      await expectPgError(asUser(u, (db) => db.query("select * from public.oauth_states")), DENIED);
      await expectPgError(asUser(u, (db) => db.query("select * from public.data_deletion_requests")), DENIED);
    }
  });

  it("exclusão de dados: só service role executa; status consultável por código", async () => {
    const st = await begin(admin);
    await asUser(admin, (db) => db.query("select public.complete_oauth($1, $2::jsonb)", [st, JSON.stringify(pending("mu-del"))]), { commit: true });
    await asUser(admin, (db) => db.query("select public.finalize_oauth($1, $2::text[])", [st, ["facebook:p1", "instagram:ig1"]]), { commit: true });

    await expectPgError(asUser(owner, (db) => db.query("select public.meta_data_deletion('mu-del')")), DENIED);
    await expectPgError(asUser(null, (db) => db.query("select public.meta_data_deletion('mu-del')")), DENIED);

    const client = await pool.connect();
    let code: string;
    try {
      await client.query("set role service_role");
      code = (await client.query("select public.meta_data_deletion('mu-del') as c")).rows[0].c;
      await client.query("reset role");
    } finally {
      client.release();
    }
    expect((await pool.query("select count(*)::int as n from public.social_account_tokens where meta_user_id = 'mu-del'")).rows[0].n).toBe(0);
    const accs = await pool.query("select status, display_name from public.social_accounts where workspace_id = $1 and external_account_id in ('p1','ig1')", [ws]);
    expect(accs.rows.every((a) => a.status === "disconnected")).toBe(true);
    const status = await asUser(null, (db) => db.query("select * from public.data_deletion_status($1)", [code]));
    expect(status.rows[0]).toMatchObject({ status: "completed", accounts_removed: 2 });
    const stored = (await pool.query("select external_user_id from public.data_deletion_requests where confirmation_code = $1", [code])).rows[0];
    expect(stored.external_user_id).not.toBe("mu-del"); // id do titular guardado apenas como hash
  });

  it("desconectar remove credenciais; somente admin", async () => {
    const st = await begin(admin);
    await asUser(admin, (db) => db.query("select public.complete_oauth($1, $2::jsonb)", [st, JSON.stringify(pending("mu-dc"))]), { commit: true });
    await asUser(admin, (db) => db.query("select public.finalize_oauth($1, $2::text[])", [st, ["facebook:p1"]]), { commit: true });
    const id = (await pool.query("select id from public.social_accounts where workspace_id = $1 and external_account_id = 'p1'", [ws])).rows[0].id;
    await expectPgError(asUser(editor, (db) => db.query("select public.disconnect_social_account($1)", [id])), DENIED);
    await asUser(admin, (db) => db.query("select public.disconnect_social_account($1)", [id]), { commit: true });
    expect((await pool.query("select 1 from public.social_account_tokens where social_account_id = $1", [id])).rowCount).toBe(0);
    expect((await pool.query("select status from public.social_accounts where id = $1", [id])).rows[0].status).toBe("disconnected");
  });
});
