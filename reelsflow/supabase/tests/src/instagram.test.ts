import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DENIED, addMember, asUser, createUser, createWorkspaceAs, expectPgError, pool, uniqueEmail } from "./helpers";

afterAll(async () => {
  await pool.end();
});

const account = (userId: string, username: string, granted = ["instagram_business_basic", "instagram_business_content_publish"]) => ({
  user_id: userId,
  username,
  name: `Nome ${username}`,
  avatar_url: `https://cdn.test/${username}.jpg`,
  account_type: "Business",
  granted,
  expires_at: new Date(Date.now() + 60 * 86400_000).toISOString(),
  token: { ciphertext: `cifra-${userId}`, iv: "iv", tag: "tag", keyVersion: 1 },
});

describe("Instagram Login — banco", () => {
  let owner: string;
  let admin: string;
  let editor: string;
  let ws: string;

  beforeAll(async () => {
    owner = await createUser({ email: uniqueEmail("ig-o") });
    admin = await createUser({ email: uniqueEmail("ig-a") });
    editor = await createUser({ email: uniqueEmail("ig-e") });
    ws = (await createWorkspaceAs(owner, "Insta")).id;
    await addMember(ws, admin, "admin");
    await addMember(ws, editor, "editor");
  });

  const begin = (u: string, provider = "instagram") =>
    asUser(u, async (db) => (await db.query<{ s: string }>("select public.begin_oauth($1, $2) as s", [ws, provider])).rows[0]!.s, { commit: true });
  const connect = (u: string, st: string, acc: object) =>
    asUser(u, async (db) => (await db.query("select public.connect_instagram_account($1, $2::jsonb) as s", [st, JSON.stringify(acc)])).rows[0].s, { commit: true });

  it("conecta a conta: token cifrado (ig_user), @, foto, validade e capacidades; state de uso único", async () => {
    const st = await begin(admin);
    expect(await connect(admin, st, account("17841400000000001", "loja"))).toMatch(/^insta-/);
    const acc = (await pool.query("select * from public.social_accounts where workspace_id = $1 and external_account_id = '17841400000000001'", [ws])).rows[0];
    expect(acc).toMatchObject({ platform: "instagram", status: "active", display_name: "Nome loja", avatar_url: "https://cdn.test/loja.jpg" });
    expect(acc.settings).toEqual({ auth: "instagram_login", username: "loja", account_type: "Business" });
    expect(acc.token_expires_at).not.toBeNull();
    const tok = (await pool.query("select token_type, ciphertext, scopes, expires_at from public.social_account_tokens where social_account_id = $1", [acc.id])).rows[0];
    expect(tok).toMatchObject({ token_type: "ig_user", ciphertext: "cifra-17841400000000001", scopes: ["instagram_business_basic", "instagram_business_content_publish"] });
    const caps = (await pool.query("select capability, granted from public.social_account_capabilities where social_account_id = $1 order by 1", [acc.id])).rows;
    expect(caps).toEqual([
      { capability: "instagram_business_basic", granted: true },
      { capability: "instagram_business_content_publish", granted: true },
      { capability: "reels_publish", granted: true },
    ]);
    await expectPgError(connect(admin, st, account("17841400000000009", "outra")), DENIED); // state já usado
  });

  it("somente admin; state de outro provedor ou de outro usuário é recusado", async () => {
    await expectPgError(asUser(editor, (db) => db.query("select public.begin_oauth($1, 'instagram')", [ws])), DENIED);
    const metaState = await begin(admin, "meta");
    await expectPgError(connect(admin, metaState, account("1", "x")), DENIED);
    const st = await begin(admin);
    await expectPgError(connect(owner, st, account("1", "x")), DENIED);
  });

  it("dados inválidos são recusados (ID não numérico, sem token)", async () => {
    await expectPgError(connect(admin, await begin(admin), { ...account("abc", "x") }), ["22023"]);
    const { token: _t, ...noToken } = account("2", "y");
    await expectPgError(connect(admin, await begin(admin), noToken), ["22023"]);
  });

  it("permissão de publicação não concedida fica registrada (reels_publish = false)", async () => {
    await pool.query("insert into public.subscriptions (workspace_id, plan) values ($1, 'agency') on conflict (workspace_id) do update set plan = 'agency'", [ws]);
    await connect(admin, await begin(admin), account("17841400000000002", "sem_publicar", ["instagram_business_basic"]));
    const caps = (
      await pool.query(
        `select c.capability, c.granted from public.social_account_capabilities c join public.social_accounts a on a.id = c.social_account_id
          where a.external_account_id = '17841400000000002' and c.capability = 'reels_publish'`,
      )
    ).rows;
    expect(caps).toEqual([{ capability: "reels_publish", granted: false }]);
  });

  it("várias contas no mesmo workspace (dentro do limite do plano); reconexão não duplica", async () => {
    await connect(admin, await begin(admin), account("17841400000000003", "terceira"));
    await connect(admin, await begin(admin), account("17841400000000001", "loja_renomeada"));
    const rows = (await pool.query("select external_account_id, settings ->> 'username' u from public.social_accounts where workspace_id = $1 and platform = 'instagram' order by 1", [ws])).rows;
    expect(rows).toEqual([
      { external_account_id: "17841400000000001", u: "loja_renomeada" },
      { external_account_id: "17841400000000002", u: "sem_publicar" },
      { external_account_id: "17841400000000003", u: "terceira" },
    ]);
  });

  it("limite do plano starter: 1 conta do Instagram", async () => {
    const o2 = await createUser({ email: uniqueEmail("ig-o2") });
    const ws2 = (await createWorkspaceAs(o2, "Insta2")).id;
    const b = async () => (await asUser(o2, (db) => db.query<{ s: string }>("select public.begin_oauth($1, 'instagram') as s", [ws2]), { commit: true })).rows[0]!.s;
    const c = (st: string, acc: object) => asUser(o2, (db) => db.query("select public.connect_instagram_account($1, $2::jsonb)", [st, JSON.stringify(acc)]), { commit: true });
    await c(await b(), account("17841400000000101", "a"));
    await expectPgError(c(await b(), account("17841400000000102", "b")), ["P0001", "23514", "54000"]);
  });

  it("tokens nunca são legíveis por usuários", async () => {
    await expectPgError(asUser(owner, (db) => db.query("select * from public.social_account_tokens")), DENIED);
  });
});
