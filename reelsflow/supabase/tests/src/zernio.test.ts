import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DENIED, addMember, asUser, createUser, createWorkspaceAs, expectPgError, pool, uniqueEmail } from "./helpers";

afterAll(async () => {
  await pool.end();
});

const ACC = "6b00e99db2568bfa4f7a2643";
const PROFILE = "6b00e219a6e2ffc97925922b";
const link = (ws: string, acc = ACC, profile = PROFILE) =>
  pool.query<{ id: string }>("select public.link_zernio_account($1, $2, $3, 'instagram', 'pipocoumemes', '🍿 Pipocou | Humor e Memes') as id", [ws, acc, profile]);

describe("contas Zernio — banco", () => {
  let owner: string;
  let admin: string;
  let otherOwner: string;
  let ws: string;
  let ws2: string;

  beforeAll(async () => {
    owner = await createUser({ email: uniqueEmail("z-o") });
    admin = await createUser({ email: uniqueEmail("z-a") });
    otherOwner = await createUser({ email: uniqueEmail("z-x") });
    ws = (await createWorkspaceAs(owner, "Leeoh")).id;
    ws2 = (await createWorkspaceAs(otherOwner, "Outro")).id;
    await addMember(ws, admin, "admin");
  });

  it("vínculo só pelo serviço: nenhum usuário (nem owner) consegue chamar link_zernio_account", async () => {
    for (const u of [owner, admin, otherOwner]) {
      await expectPgError(asUser(u, (db) => db.query("select public.link_zernio_account($1, $2, $3, 'instagram', 'x', 'x')", [ws, ACC, PROFILE])), DENIED);
    }
  });

  it("vincula a conta: provider zernio, perfil esperado, @, ativa, capacidade de publicar; idempotente", async () => {
    const id = (await link(ws)).rows[0]!.id;
    expect((await link(ws)).rows[0]!.id).toBe(id); // repetir não duplica
    const a = (await pool.query("select * from public.social_accounts where id = $1", [id])).rows[0];
    expect(a).toMatchObject({ workspace_id: ws, platform: "instagram", external_account_id: ACC, provider: "zernio", provider_profile_id: PROFILE, status: "active", display_name: "🍿 Pipocou | Humor e Memes" });
    expect(a.settings).toMatchObject({ username: "pipocoumemes" });
    const cap = (await pool.query("select granted from public.social_account_capabilities where social_account_id = $1 and capability = 'reels_publish'", [id])).rows[0];
    expect(cap.granted).toBe(true);
    // aparece para os membros do workspace (seleção de destino nas campanhas usa esta leitura)
    const seen = await asUser(owner, (db) => db.query("select id, provider from public.social_accounts where workspace_id = $1", [ws]));
    expect(seen.rows).toEqual([{ id, provider: "zernio" }]);
  });

  it("isolamento: a mesma conta Zernio não pode estar ativa em outro workspace; outro tenant não a vê", async () => {
    await expectPgError(link(ws2), ["23505"]);
    const other = await asUser(otherOwner, (db) => db.query("select id from public.social_accounts where external_account_id = $1", [ACC]));
    expect(other.rowCount).toBe(0);
  });

  it("admin do workspace não altera provider, perfil nem o ID da conta", async () => {
    const id = (await pool.query("select id from public.social_accounts where workspace_id = $1 and provider = 'zernio'", [ws])).rows[0].id;
    for (const col of ["provider = 'native'", `provider_profile_id = 'bbbbbbbbbbbbbbbbbbbbbbbb'`, "external_account_id = 'x'"]) {
      await expectPgError(asUser(admin, (db) => db.query(`update public.social_accounts set ${col} where id = $1`, [id])), DENIED);
    }
    // ...mas pode pausar/ajustar como qualquer conta
    await asUser(admin, (db) => db.query("update public.social_accounts set paused = true where id = $1", [id]), { commit: true });
    await pool.query("update public.social_accounts set paused = false where id = $1", [id]);
  });

  it("dados inválidos são recusados; conta zernio exige perfil", async () => {
    await expectPgError(link(ws, "nao-hex"), ["22023"]);
    await expectPgError(pool.query("select public.link_zernio_account($1, $2, $3, 'mock', 'x', 'x')", [ws, ACC, PROFILE]), ["22023"]);
    await expectPgError(
      pool.query("insert into public.social_accounts (workspace_id, platform, external_account_id, display_name, provider) values ($1, 'instagram', $2, 'x', 'zernio')", [ws2, "c".repeat(24)]),
      ["23514"],
    );
  });

  it("dados existentes preservados: contas antigas ficam provider = native", async () => {
    const r = await pool.query("select count(*)::int n from public.social_accounts where provider = 'native' and provider_profile_id is not null");
    expect(r.rows[0].n).toBe(0);
    const d = await pool.query("select column_default from information_schema.columns where table_name = 'social_accounts' and column_name = 'provider'");
    expect(d.rows[0].column_default).toContain("native");
  });
});
