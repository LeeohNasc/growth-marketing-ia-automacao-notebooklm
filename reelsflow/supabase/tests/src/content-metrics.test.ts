import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DENIED, asUser, createUser, createWorkspaceAs, expectPgError, pool, uniqueEmail } from "./helpers";

afterAll(async () => {
  await pool.end();
});

describe("analytics de conteúdo — banco", () => {
  let owner: string;
  let other: string;
  let ws: string;
  let ws2: string;
  let post: string;

  beforeAll(async () => {
    owner = await createUser({ email: uniqueEmail("m-o") });
    other = await createUser({ email: uniqueEmail("m-x") });
    ws = (await createWorkspaceAs(owner, "Leeoh")).id;
    ws2 = (await createWorkspaceAs(other, "Outro")).id;
    const acc = (await pool.query<{ id: string }>("select public.link_zernio_account($1, 'aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb', 'instagram', 'pipocoumemes', 'Pipocou') as id", [ws])).rows[0]!.id;
    post = (await pool.query<{ id: string }>(
      "insert into public.social_posts (workspace_id, social_account_id, platform, platform_post_id, published_at, origin, views, likes) values ($1,$2,'instagram','17900000000000001',now() - interval '2 days','external',1200,null) returning id",
      [ws, acc],
    )).rows[0]!.id;
    await pool.query("insert into public.social_post_metrics_daily (social_post_id, workspace_id, day, views) values ($1,$2,current_date,1200)", [post, ws]);
    await pool.query("insert into public.metrics_sync_state (social_account_id, workspace_id, status) values ($1,$2,'needs_analytics_scope')", [acc, ws]);
  });

  it("membro lê métricas do próprio workspace; métrica ausente continua NULL", async () => {
    const r = await asUser(owner, (db) => db.query("select views, likes from public.social_posts where workspace_id = $1", [ws]));
    expect(r.rows).toEqual([{ views: "1200", likes: null }]);
    const d = await asUser(owner, (db) => db.query("select count(*)::int as n from public.social_post_metrics_daily"));
    expect(d.rows[0].n).toBe(1);
    const s = await asUser(owner, (db) => db.query("select status from public.metrics_sync_state"));
    expect(s.rows).toEqual([{ status: "needs_analytics_scope" }]);
  });

  it("isolamento: outro tenant não vê nada", async () => {
    for (const t of ["social_posts", "social_post_metrics_daily", "metrics_sync_state"]) {
      const r = await asUser(other, (db) => db.query(`select count(*)::int as n from public.${t}`));
      expect(r.rows[0].n).toBe(0);
    }
    expect(ws2).not.toBe(ws);
  });

  it("navegador não escreve: insert/update/delete negados até para o owner; anônimo não lê", async () => {
    await expectPgError(asUser(owner, (db) => db.query("update public.social_posts set views = 999999 where id = $1", [post])), DENIED);
    await expectPgError(asUser(owner, (db) => db.query("delete from public.social_post_metrics_daily where social_post_id = $1", [post])), DENIED);
    await expectPgError(asUser(owner, (db) => db.query("update public.metrics_sync_state set status = 'ok'")), DENIED);
    await expectPgError(
      asUser(owner, (db) => db.query("insert into public.social_posts (workspace_id, social_account_id, platform, platform_post_id, published_at, origin) select workspace_id, social_account_id, platform, 'x', now(), 'external' from public.social_posts limit 1")),
      DENIED,
    );
    await expectPgError(asUser(null, (db) => db.query("select 1 from public.social_posts")), DENIED);
  });

  it("sem duplicatas e sem valores negativos", async () => {
    const acc = (await pool.query("select social_account_id from public.social_posts where id = $1", [post])).rows[0].social_account_id;
    await expectPgError(pool.query("insert into public.social_posts (workspace_id, social_account_id, platform, platform_post_id, published_at, origin) values ($1,$2,'instagram','17900000000000001',now(),'external')", [ws, acc]), ["23505"]);
    await expectPgError(pool.query("insert into public.social_post_metrics_daily (social_post_id, workspace_id, day) values ($1,$2,current_date)", [post, ws]), ["23505"]);
    await expectPgError(pool.query("update public.social_posts set views = -1 where id = $1", [post]), ["23514"]);
  });
});
