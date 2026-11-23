import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DENIED, addMember, asUser, createUser, createWorkspaceAs, expectPgError, pool, uniqueEmail } from "./helpers";

afterAll(async () => {
  await pool.end();
});

describe("Tela Dividida — banco", () => {
  let owner: string;
  let editor: string;
  let viewer: string;
  let outsider: string;
  let ws: string;
  let ws2: string;

  beforeAll(async () => {
    owner = await createUser({ email: uniqueEmail("sp-o") });
    editor = await createUser({ email: uniqueEmail("sp-e") });
    viewer = await createUser({ email: uniqueEmail("sp-v") });
    outsider = await createUser({ email: uniqueEmail("sp-x") });
    ws = (await createWorkspaceAs(owner, "Split")).id;
    ws2 = (await createWorkspaceAs(outsider, "Outro")).id;
    for (const w of [ws, ws2]) await pool.query("insert into public.subscriptions (workspace_id, plan) values ($1, 'agency') on conflict (workspace_id) do update set plan = 'agency'", [w]);
    await addMember(ws, editor, "editor");
    await addMember(ws, viewer, "viewer");
  });

  const upload = async (u: string, w: string, mime = "video/mp4", name = "v.mp4") => {
    const m = (
      await asUser(u, (db) => db.query("select * from public.begin_media_upload($1, $2::jsonb)", [w, JSON.stringify([{ name, size: 4321, mime, sha256: "d".repeat(64) }])]), { commit: true })
    ).rows[0] as { media_id: string; storage_path: string };
    await pool.query("insert into storage.objects (bucket_id, name, owner, metadata) values ('media', $1, $2, jsonb_build_object('size', 4321))", [m.storage_path, u]);
    await asUser(u, (db) => db.query("select public.complete_media_upload($1)", [m.media_id]), { commit: true });
    return m.media_id;
  };
  const markReady = (id: string) => pool.query("update public.media_assets set status = 'processing' where id = $1 and status = 'uploaded'; update public.media_assets set status = 'ready' where id = $1", [id]).catch(async () => {
    await pool.query("update public.media_assets set status = 'processing' where id = $1", [id]);
    await pool.query("update public.media_assets set status = 'ready' where id = $1", [id]);
  });
  const newProject = (u: string, w = ws, extra: { top?: string; bottom?: string } = {}) =>
    asUser(
      u,
      async (db) =>
        (
          await db.query<{ id: string }>(
            "insert into public.split_projects (workspace_id, created_by, title, config, top_media_id, bottom_media_id) values ($1, $2, 'Podcast', '{\"ratio\":\"50/50\"}', $3, $4) returning id",
            [w, u, extra.top ?? null, extra.bottom ?? null],
          )
        ).rows[0]!.id,
      { commit: true },
    );

  it("editor cria e edita; viewer só lê; outro workspace não vê", async () => {
    const id = await newProject(editor);
    expect((await asUser(viewer, (db) => db.query("select title from public.split_projects where id = $1", [id]))).rows).toEqual([{ title: "Podcast" }]);
    expect((await asUser(outsider, (db) => db.query("select 1 from public.split_projects where id = $1", [id]))).rowCount).toBe(0);
    await expectPgError(newProject(viewer), DENIED);
    expect((await asUser(viewer, (db) => db.query("update public.split_projects set title = 'x' where id = $1", [id]))).rowCount).toBe(0);
    expect((await asUser(editor, (db) => db.query("update public.split_projects set config = '{\"ratio\":\"60/40\"}' where id = $1", [id]))).rowCount).toBe(1);
  });

  it("origens: só vídeos do MESMO workspace (mídia de outro tenant ou imagem é recusada)", async () => {
    const mine = await upload(editor, ws);
    const theirs = await upload(outsider, ws2);
    const image = await upload(editor, ws, "image/jpeg", "foto.jpg");
    const id = await newProject(editor, ws, { top: mine });
    await expectPgError(asUser(editor, (db) => db.query("update public.split_projects set bottom_media_id = $2 where id = $1", [id, theirs])), DENIED);
    await expectPgError(asUser(editor, (db) => db.query("update public.split_projects set bottom_media_id = $2 where id = $1", [id, image])), DENIED);
    await expectPgError(newProject(editor, ws, { top: theirs }), DENIED);
  });

  it("cliente não declara pronto: só RPC de estado (sem 'ready') e attach; pronto vem da análise do worker", async () => {
    const top = await upload(editor, ws);
    const bottom = await upload(editor, ws);
    const id = await newProject(editor, ws, { top, bottom });
    await expectPgError(asUser(editor, (db) => db.query("update public.split_projects set render_status = 'ready' where id = $1", [id])), DENIED);
    await expectPgError(asUser(editor, (db) => db.query("update public.split_projects set rendered_media_id = $2 where id = $1", [id, top])), DENIED);
    await expectPgError(asUser(editor, (db) => db.query("select public.set_split_render_state($1, 'ready')", [id])), ["22023"]);
    await asUser(editor, (db) => db.query("select public.set_split_render_state($1, 'rendering')", [id]), { commit: true });
    // a própria origem não pode virar "render"
    await expectPgError(asUser(editor, (db) => db.query("select public.attach_split_render($1, $2)", [id, top])), ["22023"]);
    const render = await upload(editor, ws, "video/mp4", "final.mp4");
    expect((await asUser(editor, (db) => db.query("select public.attach_split_render($1, $2) as s", [id, render]), { commit: true })).rows[0].s).toBe("processing");
    expect((await pool.query("select source_split_id from public.media_assets where id = $1", [render])).rows[0].source_split_id).toBe(id);
    await markReady(render);
    expect((await pool.query("select render_status from public.split_projects where id = $1", [id])).rows[0].render_status).toBe("ready");
    // origens intactas (status/arquivo não mudam)
    expect((await pool.query("select count(*)::int n from public.media_assets where id in ($1, $2) and source_split_id is null and status = 'uploaded'", [top, bottom])).rows[0].n).toBe(2);
    // editar depois de pronto volta a rascunho; o render antigo continua na Biblioteca
    await asUser(editor, (db) => db.query("update public.split_projects set config = '{\"ratio\":\"40/60\"}' where id = $1", [id]), { commit: true });
    const after = (await pool.query("select render_status, rendered_media_id from public.split_projects where id = $1", [id])).rows[0];
    expect(after).toEqual({ render_status: "draft", rendered_media_id: render });
    expect((await pool.query("select deleted_at from public.media_assets where id = $1", [render])).rows[0].deleted_at).toBeNull();
  });

  it("render de outro workspace é recusado; outsider não opera o projeto", async () => {
    const id = await newProject(editor);
    const foreign = await upload(outsider, ws2);
    await expectPgError(asUser(editor, (db) => db.query("select public.attach_split_render($1, $2)", [id, foreign])), DENIED);
    await expectPgError(asUser(outsider, (db) => db.query("select public.set_split_render_state($1, 'rendering')", [id])), DENIED);
    await expectPgError(asUser(outsider, (db) => db.query("select public.delete_split_project($1)", [id])), DENIED);
  });

  it("duplicar mantém origens e configuração; excluir mantém origens e render na Biblioteca", async () => {
    const top = await upload(editor, ws);
    const id = await newProject(editor, ws, { top });
    const copy = (await asUser(editor, (db) => db.query("select public.duplicate_split_project($1) as id", [id]), { commit: true })).rows[0].id;
    expect((await pool.query("select title, top_media_id, config->>'ratio' as ratio from public.split_projects where id = $1", [copy])).rows[0]).toEqual({ title: "Cópia de Podcast", top_media_id: top, ratio: "50/50" });
    await asUser(editor, (db) => db.query("select public.delete_split_project($1)", [id]), { commit: true });
    expect((await pool.query("select count(*)::int n from public.split_projects where id = $1", [id])).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int n from public.media_assets where id = $1 and deleted_at is null", [top])).rows[0].n).toBe(1);
  });
});
