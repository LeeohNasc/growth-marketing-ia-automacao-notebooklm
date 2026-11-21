import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DENIED, addMember, asUser, createUser, createWorkspaceAs, expectPgError, pool, uniqueEmail } from "./helpers";

afterAll(async () => {
  await pool.end();
});

describe("Card Editorial — banco", () => {
  let owner: string;
  let editor: string;
  let viewer: string;
  let outsider: string;
  let ws: string;
  let ws2: string;

  beforeAll(async () => {
    owner = await createUser({ email: uniqueEmail("ec-o") });
    editor = await createUser({ email: uniqueEmail("ec-e") });
    viewer = await createUser({ email: uniqueEmail("ec-v") });
    outsider = await createUser({ email: uniqueEmail("ec-x") });
    ws = (await createWorkspaceAs(owner, "Cards")).id;
    ws2 = (await createWorkspaceAs(outsider, "Outro")).id;
    await pool.query("insert into public.subscriptions (workspace_id, plan) values ($1, 'agency') on conflict (workspace_id) do update set plan = 'agency'", [ws]);
    await addMember(ws, editor, "editor");
    await addMember(ws, viewer, "viewer");
  });

  const newCard = (u: string, w = ws, extra: Record<string, unknown> = {}) =>
    asUser(
      u,
      async (db) =>
        (
          await db.query<{ id: string }>(
            `insert into public.editorial_cards (workspace_id, created_by, title, page_name, username, headline, format, media_kind)
             values ($1, $2, 'Card', 'Pipocou', 'pipocoumemes', '🚨 VEJA | Manchete', 'feed', $3) returning id`,
            [w, u, extra.kind ?? "image"],
          )
        ).rows[0]!.id,
      { commit: true },
    );

  const uploadJpeg = async (u: string, w = ws) => {
    const m = (
      await asUser(u, (db) => db.query("select * from public.begin_media_upload($1, $2::jsonb)", [w, JSON.stringify([{ name: "card.jpg", size: 1234, mime: "image/jpeg", sha256: "c".repeat(64) }])]), {
        commit: true,
      })
    ).rows[0];
    await asUser(u, (db) => db.query("insert into storage.objects (bucket_id, name, owner, metadata) values ('media', $1, $2, jsonb_build_object('size', 1234))", [m.storage_path, u]), { commit: true });
    await asUser(u, (db) => db.query("select public.complete_media_upload($1)", [m.media_id]), { commit: true });
    return m as { media_id: string; storage_path: string };
  };

  it("editor cria; viewer só lê; outro workspace não vê", async () => {
    const id = await newCard(editor);
    expect((await asUser(viewer, (db) => db.query("select title from public.editorial_cards where id = $1", [id]))).rows).toEqual([{ title: "Card" }]);
    expect((await asUser(outsider, (db) => db.query("select 1 from public.editorial_cards where id = $1", [id]))).rowCount).toBe(0);
    await expectPgError(newCard(viewer), DENIED);
    const upd = await asUser(viewer, (db) => db.query("update public.editorial_cards set headline = 'x' where id = $1", [id]));
    expect(upd.rowCount).toBe(0);
  });

  it("cliente não declara render pronto nem aponta para render arbitrário", async () => {
    const id = await newCard(editor);
    await expectPgError(asUser(editor, (db) => db.query("update public.editorial_cards set render_status = 'ready' where id = $1", [id])), DENIED);
    await expectPgError(
      asUser(editor, (db) =>
        db.query("insert into public.editorial_cards (workspace_id, created_by, title, render_status) values ($1, $2, 'x', 'ready')", [ws, editor]),
      ),
      DENIED,
    );
    await expectPgError(asUser(editor, (db) => db.query("select public.set_card_render_state($1, 'ready')", [id])), ["22023"]);
    expect((await asUser(editor, (db) => db.query("select public.set_card_render_state($1, 'rendering') as s", [id]), { commit: true })).rows[0].s).toBe("rendering");
  });

  it("origens só sob {workspace}/cards/: caminho de outro workspace é recusado", async () => {
    const id = await newCard(editor);
    const ok = `${ws}/cards/${id}/avatar-1.png`;
    await asUser(editor, (db) => db.query("update public.editorial_cards set avatar_path = $2, media_paths = $3 where id = $1", [id, ok, [`${ws}/cards/${id}/foto-1.jpg`]]), { commit: true });
    await expectPgError(asUser(editor, (db) => db.query("update public.editorial_cards set media_paths = $2 where id = $1", [id, [`${ws2}/cards/${id}/x.jpg`]])), ["23514"]);
    await expectPgError(asUser(editor, (db) => db.query("update public.editorial_cards set avatar_path = $2 where id = $1", [id, `${ws}/${id}/original.mp4`])), ["23514"]);
  });

  it("storage: editor envia origem para card do workspace; outsider e card inexistente não", async () => {
    const id = await newCard(editor);
    const put = (u: string, name: string) => asUser(u, (db) => db.query("insert into storage.objects (bucket_id, name, owner, metadata) values ('media', $1, $2, '{}'::jsonb)", [name, u]));
    await put(editor, `${ws}/cards/${id}/avatar-1.png`);
    await expectPgError(put(outsider, `${ws}/cards/${id}/avatar-2.png`), DENIED);
    await expectPgError(put(editor, `${ws}/cards/00000000-0000-0000-0000-000000000000/a.png`), DENIED);
    await expectPgError(put(editor, `${ws}/cards/${id}/../../x.png`), DENIED);
    await expectPgError(put(viewer, `${ws}/cards/${id}/v.png`), DENIED);
  });

  it("imagem final aceita no pipeline (JPEG → .jpg, kind = image)", async () => {
    const m = await uploadJpeg(editor);
    expect(m.storage_path).toMatch(/\/original\.jpg$/);
    const row = (await pool.query("select kind, status from public.media_assets where id = $1", [m.media_id])).rows[0];
    expect(row).toEqual({ kind: "image", status: "uploaded" });
    await expectPgError(
      asUser(editor, (db) => db.query("select * from public.begin_media_upload($1, $2::jsonb)", [ws, JSON.stringify([{ name: "x.png", size: 10, mime: "image/png", sha256: "d".repeat(64) }])])),
      ["22023"],
    );
  });

  it("attach + análise do worker: processing → ready; legenda do card vira legenda padrão; edição invalida", async () => {
    const id = await newCard(editor);
    await asUser(editor, (db) => db.query("update public.editorial_cards set caption = 'Legenda da postagem' where id = $1", [id]), { commit: true });
    const m = await uploadJpeg(editor);
    expect((await asUser(editor, (db) => db.query("select public.attach_card_render($1, $2) as s", [id, m.media_id]), { commit: true })).rows[0].s).toBe("processing");
    expect((await pool.query("select source_card_id, default_caption from public.media_assets where id = $1", [m.media_id])).rows[0]).toEqual({ source_card_id: id, default_caption: "Legenda da postagem" });
    // worker conclui a análise
    await pool.query("update public.media_assets set status = 'processing' where id = $1", [m.media_id]);
    await pool.query("update public.media_assets set status = 'ready' where id = $1", [m.media_id]);
    expect((await pool.query("select render_status, rendered_media_id from public.editorial_cards where id = $1", [id])).rows[0]).toEqual({ render_status: "ready", rendered_media_id: m.media_id });
    // editar o conteúdo depois do render volta a rascunho (o render antigo continua na biblioteca)
    await asUser(editor, (db) => db.query("update public.editorial_cards set headline = 'Nova manchete' where id = $1", [id]), { commit: true });
    expect((await pool.query("select render_status, rendered_media_id from public.editorial_cards where id = $1", [id])).rows[0]).toEqual({ render_status: "draft", rendered_media_id: m.media_id });
    // mudar só a legenda NÃO invalida o render
    const id2 = await newCard(editor);
    const m2 = await uploadJpeg(editor);
    await asUser(editor, (db) => db.query("select public.attach_card_render($1, $2)", [id2, m2.media_id]), { commit: true });
    await asUser(editor, (db) => db.query("update public.editorial_cards set caption = 'outra' where id = $1", [id2]), { commit: true });
    expect((await pool.query("select render_status from public.editorial_cards where id = $1", [id2])).rows[0].render_status).toBe("processing");
  });

  it("render inválido (worker falha) → card em erro com motivo", async () => {
    const id = await newCard(editor);
    const m = await uploadJpeg(editor);
    await asUser(editor, (db) => db.query("select public.attach_card_render($1, $2)", [id, m.media_id]), { commit: true });
    await pool.query("update public.media_assets set status = 'processing' where id = $1", [m.media_id]);
    await pool.query("update public.media_assets set status = 'failed', failure_reason = 'invalid_image' where id = $1", [m.media_id]);
    expect((await pool.query("select render_status, render_error from public.editorial_cards where id = $1", [id])).rows[0]).toEqual({ render_status: "error", render_error: "invalid_image" });
  });

  it("attach recusa: tipo trocado, upload incompleto, mídia de outro workspace", async () => {
    const vid = await newCard(editor, ws, { kind: "video" });
    const img = await uploadJpeg(editor);
    await expectPgError(asUser(editor, (db) => db.query("select public.attach_card_render($1, $2)", [vid, img.media_id])), ["22023"]);
    const card = await newCard(editor);
    const pending = (
      await asUser(editor, (db) => db.query("select * from public.begin_media_upload($1, $2::jsonb)", [ws, JSON.stringify([{ name: "p.jpg", size: 9, mime: "image/jpeg", sha256: "e".repeat(64) }])]), { commit: true })
    ).rows[0];
    await expectPgError(asUser(editor, (db) => db.query("select public.attach_card_render($1, $2)", [card, pending.media_id])), ["22023"]);
    const foreign = await uploadJpeg(outsider, ws2);
    await expectPgError(asUser(editor, (db) => db.query("select public.attach_card_render($1, $2)", [card, foreign.media_id])), DENIED);
    await expectPgError(asUser(outsider, (db) => db.query("select public.attach_card_render($1, $2)", [card, foreign.media_id])), DENIED);
  });

  it("conta de destino precisa ser do mesmo workspace", async () => {
    const acc = (await pool.query("insert into public.social_accounts (workspace_id, platform, external_account_id, display_name) values ($1, 'mock', 'm-1', 'Simulada') returning id", [ws2])).rows[0].id;
    const id = await newCard(editor);
    await expectPgError(asUser(editor, (db) => db.query("update public.editorial_cards set social_account_id = $2 where id = $1", [id, acc])), DENIED);
  });

  it("duplicar: novo rascunho com as mesmas origens; excluir só limpa arquivos órfãos", async () => {
    const id = await newCard(editor);
    const shared = `${ws}/cards/${id}/foto-1.jpg`;
    const own = `${ws}/cards/${id}/avatar-1.png`;
    await asUser(editor, (db) => db.query("update public.editorial_cards set media_paths = $2, avatar_path = $3 where id = $1", [id, [shared], own]), { commit: true });
    const copy = (await asUser(editor, (db) => db.query("select public.duplicate_editorial_card($1) as id", [id]), { commit: true })).rows[0].id;
    const c = (await pool.query("select title, render_status, media_paths, created_by from public.editorial_cards where id = $1", [copy])).rows[0];
    expect(c).toMatchObject({ title: "Cópia de Card", render_status: "draft", media_paths: [shared], created_by: editor });
    // a cópia usa outro avatar: o avatar original vira órfão; a foto continua compartilhada
    await asUser(editor, (db) => db.query("update public.editorial_cards set avatar_path = $2 where id = $1", [copy, `${ws}/cards/${copy}/avatar-2.png`]), { commit: true });
    await asUser(editor, (db) => db.query("select public.delete_editorial_card($1)", [id]), { commit: true });
    const job = (await pool.query("select payload from public.media_jobs where kind = 'purge' and workspace_id = $1 order by created_at desc limit 1", [ws])).rows[0];
    expect(job.payload.paths).toEqual([own]);
    expect((await pool.query("select count(*)::int n from public.editorial_cards where id = $1", [id])).rows[0].n).toBe(0);
    await expectPgError(asUser(viewer, (db) => db.query("select public.delete_editorial_card($1)", [copy])), DENIED);
  });
});
