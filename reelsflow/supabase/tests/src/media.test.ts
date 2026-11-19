import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DENIED, addMember, asUser, createUser, createWorkspaceAs, expectPgError, pool, uniqueEmail } from "./helpers";

afterAll(async () => {
  await pool.end();
});

const SHA = (c: string) => c.repeat(64).slice(0, 64);
const MB = 1024 * 1024;

type Begun = { media_id: string; storage_path: string };

async function begin(userId: string, ws: string, files: object[], commit = true): Promise<Begun[]> {
  return asUser(
    userId,
    async (db) => (await db.query<Begun>("select * from public.begin_media_upload($1, $2::jsonb)", [ws, JSON.stringify(files)])).rows,
    { commit },
  );
}

/** Simula a conclusão do TUS: o storage grava o objeto como o usuário (RLS se aplica). */
async function putObject(userId: string, path: string, size: number, commit = true) {
  return asUser(
    userId,
    (db) => db.query("insert into storage.objects (bucket_id, name, owner, metadata) values ('media', $1, $2, jsonb_build_object('size', $3::bigint))", [path, userId, size]),
    { commit },
  );
}

const file = (over: Partial<{ name: string; size: number; mime: string; sha256: string }> = {}) => ({
  name: "video.mp4",
  size: 2 * MB,
  mime: "video/mp4",
  sha256: SHA("a"),
  ...over,
});

describe("biblioteca de mídia", () => {
  let owner: string;
  let editor: string;
  let viewer: string;
  let outsider: string;
  let ws: { id: string };
  let other: { id: string };

  beforeAll(async () => {
    owner = await createUser({ email: uniqueEmail("m-owner") });
    editor = await createUser({ email: uniqueEmail("m-editor") });
    viewer = await createUser({ email: uniqueEmail("m-viewer") });
    outsider = await createUser({ email: uniqueEmail("m-out") });
    ws = await createWorkspaceAs(owner, "Mídia");
    other = await createWorkspaceAs(outsider, "Outro");
    await addMember(ws.id, editor, "editor");
    await addMember(ws.id, viewer, "viewer");
  });

  describe("begin_media_upload", () => {
    it("editor registra arquivos com caminho dentro do workspace", async () => {
      const rows = await begin(editor, ws.id, [file({ name: "Meu Reel 01.MP4" })], false);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.storage_path).toBe(`${ws.id}/${rows[0]!.media_id}/original.mp4`);
    });

    it("viewer e não membro são recusados", async () => {
      await expectPgError(begin(viewer, ws.id, [file()], false), DENIED);
      await expectPgError(begin(outsider, ws.id, [file()], false), DENIED);
    });

    it("recusa formato e tamanho inválidos", async () => {
      await expectPgError(begin(editor, ws.id, [file({ mime: "video/x-msvideo" })], false), ["22023"]);
      await expectPgError(begin(editor, ws.id, [file({ size: 51 * MB })], false), ["22023"]);
      await expectPgError(begin(editor, ws.id, [file({ size: 0 })], false), ["22023"]);
      await expectPgError(begin(editor, ws.id, [file({ sha256: "xyz" })], false), ["23514"]);
      await expectPgError(begin(editor, ws.id, [], false), ["22023"]);
    });

    it("respeita limite de plano quando definido", async () => {
      await pool.query("update public.subscriptions set limits = '{\"max_upload_bytes\": 1048576}' where workspace_id = $1", [ws.id]);
      try {
        await expectPgError(begin(editor, ws.id, [file({ size: 2 * MB })], false), ["22023"]);
      } finally {
        await pool.query("update public.subscriptions set limits = '{}' where workspace_id = $1", [ws.id]);
      }
    });
  });

  describe("storage", () => {
    it("grava apenas em caminho pré-registrado e em upload", async () => {
      const [m] = await begin(editor, ws.id, [file({ sha256: SHA("b") })]);
      await putObject(editor, m!.storage_path, 2 * MB);

      // caminho inventado no mesmo workspace
      await expectPgError(putObject(editor, `${ws.id}/qualquer/original.mp4`, 10, false), DENIED);
      // caminho de outro workspace
      await expectPgError(putObject(editor, `${other.id}/x/original.mp4`, 10, false), DENIED);
      // viewer
      const [m2] = await begin(editor, ws.id, [file({ sha256: SHA("c") })]);
      await expectPgError(putObject(viewer, m2!.storage_path, 10, false), DENIED);
      // caminho malformado não quebra a policy
      await expectPgError(putObject(editor, "nao-e-uuid/x.mp4", 10, false), DENIED);
    });

    it("não grava de novo após o upload ser concluído", async () => {
      const [m] = await begin(editor, ws.id, [file({ sha256: SHA("d") })]);
      await putObject(editor, m!.storage_path, 2 * MB);
      await asUser(editor, (db) => db.query("select public.complete_media_upload($1)", [m!.media_id]), { commit: true });
      await pool.query("delete from storage.objects where name = $1", [m!.storage_path]);
      await expectPgError(putObject(editor, m!.storage_path, 2 * MB, false), DENIED);
    });

    it("objetos são visíveis só para membros do workspace", async () => {
      const [m] = await begin(editor, ws.id, [file({ sha256: SHA("e") })]);
      await putObject(editor, m!.storage_path, 2 * MB);
      const seenByViewer = await asUser(viewer, (db) => db.query("select 1 from storage.objects where name = $1", [m!.storage_path]));
      expect(seenByViewer.rowCount).toBe(1);
      const seenByOutsider = await asUser(outsider, (db) => db.query("select 1 from storage.objects where name = $1", [m!.storage_path]));
      expect(seenByOutsider.rowCount).toBe(0);
    });

    it("cliente não apaga nem sobrescreve objetos", async () => {
      const [m] = await begin(editor, ws.id, [file({ sha256: SHA("f") })]);
      await putObject(editor, m!.storage_path, 2 * MB);
      const del = await asUser(owner, (db) => db.query("delete from storage.objects where name = $1", [m!.storage_path]));
      expect(del.rowCount).toBe(0);
      const up = await asUser(owner, (db) => db.query("update storage.objects set metadata = '{}' where name = $1", [m!.storage_path]));
      expect(up.rowCount).toBe(0);
    });
  });

  describe("complete_media_upload", () => {
    it("exige o objeto no storage", async () => {
      const [m] = await begin(editor, ws.id, [file({ sha256: SHA("1") })]);
      await expectPgError(asUser(editor, (db) => db.query("select public.complete_media_upload($1)", [m!.media_id])), ["P0002"]);
    });

    it("tamanho divergente marca falha e agenda limpeza", async () => {
      const [m] = await begin(editor, ws.id, [file({ sha256: SHA("2") })]);
      await putObject(editor, m!.storage_path, 123);
      const r = await asUser(editor, (db) => db.query("select public.complete_media_upload($1) as s", [m!.media_id]), { commit: true });
      expect(r.rows[0]?.s).toBe("failed");
      const jobs = await pool.query("select kind from public.media_jobs where media_asset_id = $1", [m!.media_id]);
      expect(jobs.rows.map((j) => j.kind)).toEqual(["purge"]);
    });

    it("conclui, enfileira probe, mede uso e é idempotente", async () => {
      const before = await pool.query<{ q: string }>(
        "select coalesce(sum(quantity),0) as q from public.usage_records where workspace_id = $1 and metric = 'uploads'",
        [ws.id],
      );
      const [m] = await begin(editor, ws.id, [file({ sha256: SHA("3") })]);
      await putObject(editor, m!.storage_path, 2 * MB);
      const r1 = await asUser(editor, (db) => db.query("select public.complete_media_upload($1) as s", [m!.media_id]), { commit: true });
      const r2 = await asUser(editor, (db) => db.query("select public.complete_media_upload($1) as s", [m!.media_id]), { commit: true });
      expect(r1.rows[0]?.s).toBe("uploaded");
      expect(r2.rows[0]?.s).toBe("uploaded");
      const jobs = await pool.query("select kind, status from public.media_jobs where media_asset_id = $1", [m!.media_id]);
      expect(jobs.rows).toEqual([{ kind: "probe", status: "queued" }]);
      const after = await pool.query<{ q: string }>(
        "select coalesce(sum(quantity),0) as q from public.usage_records where workspace_id = $1 and metric = 'uploads'",
        [ws.id],
      );
      expect(Number(after.rows[0]!.q) - Number(before.rows[0]!.q)).toBe(1);
    });

    it("não membro não conclui upload alheio", async () => {
      const [m] = await begin(editor, ws.id, [file({ sha256: SHA("4") })]);
      await expectPgError(asUser(outsider, (db) => db.query("select public.complete_media_upload($1)", [m!.media_id])), DENIED);
    });
  });

  describe("cancelamento, edição e exclusão", () => {
    it("cancelar remove o registro", async () => {
      const [m] = await begin(editor, ws.id, [file({ sha256: SHA("5") })]);
      await asUser(editor, (db) => db.query("select public.cancel_media_upload($1)", [m!.media_id]), { commit: true });
      expect((await pool.query("select 1 from public.media_assets where id = $1", [m!.media_id])).rowCount).toBe(0);
    });

    it("editor renomeia e edita legenda; viewer não; status e caminho são protegidos", async () => {
      const [m] = await begin(editor, ws.id, [file({ sha256: SHA("6") })]);
      const ok = await asUser(editor, (db) =>
        db.query("update public.media_assets set name = 'Novo nome', default_caption = 'Legenda', default_hashtags = '{#a,#b}' where id = $1", [m!.media_id]),
      );
      expect(ok.rowCount).toBe(1);
      const no = await asUser(viewer, (db) => db.query("update public.media_assets set name = 'x' where id = $1", [m!.media_id]));
      expect(no.rowCount).toBe(0);
      await expectPgError(asUser(owner, (db) => db.query("update public.media_assets set status = 'ready' where id = $1", [m!.media_id])), DENIED);
      await expectPgError(asUser(owner, (db) => db.query("update public.media_assets set storage_path = 'x' where id = $1", [m!.media_id])), DENIED);
      await expectPgError(asUser(owner, (db) => db.query("delete from public.media_assets where id = $1", [m!.media_id])), DENIED);
    });

    it("transição de status inválida é recusada mesmo pelo servidor", async () => {
      const [m] = await begin(editor, ws.id, [file({ sha256: SHA("7") })]);
      await expectPgError(pool.query("update public.media_assets set status = 'ready' where id = $1", [m!.media_id]), ["P0001"]);
    });

    it("exclusão lógica agenda limpeza em 30 dias; restaurar cancela", async () => {
      const [m] = await begin(editor, ws.id, [file({ sha256: SHA("8") })]);
      const n = await asUser(editor, (db) => db.query("select public.delete_media($1::uuid[]) as n", [[m!.media_id]]), { commit: true });
      expect(n.rows[0]?.n).toBe(1);
      const job = await pool.query<{ days: number; paths: string[] }>(
        "select extract(day from run_after - now())::int as days, payload->'paths' as paths from public.media_jobs where media_asset_id = $1 and kind = 'purge'",
        [m!.media_id],
      );
      expect(job.rows[0]!.days).toBeGreaterThanOrEqual(29);
      expect(job.rows[0]!.paths).toEqual([m!.storage_path]);

      const r = await asUser(editor, (db) => db.query("select public.restore_media($1::uuid[]) as n", [[m!.media_id]]), { commit: true });
      expect(r.rows[0]?.n).toBe(1);
      const st = await pool.query("select status from public.media_jobs where media_asset_id = $1 and kind = 'purge'", [m!.media_id]);
      expect(st.rows[0]?.status).toBe("cancelled");
    });

    it("não membro não exclui", async () => {
      const [m] = await begin(editor, ws.id, [file({ sha256: SHA("9") })]);
      await expectPgError(asUser(outsider, (db) => db.query("select public.delete_media($1::uuid[])", [[m!.media_id]])), DENIED);
      await expectPgError(asUser(viewer, (db) => db.query("select public.delete_media($1::uuid[])", [[m!.media_id]])), DENIED);
      await asUser(editor, (db) => db.query("select public.delete_media($1::uuid[])", [[m!.media_id]]), { commit: true });
      await expectPgError(asUser(outsider, (db) => db.query("select public.restore_media($1::uuid[])", [[m!.media_id]])), DENIED);
      await expectPgError(asUser(viewer, (db) => db.query("select public.restore_media($1::uuid[])", [[m!.media_id]])), DENIED);
    });
  });

  describe("isolamento", () => {
    it("não membro não vê vídeos nem detecta duplicados de outro workspace", async () => {
      await begin(editor, ws.id, [file({ sha256: SHA("0") })]);
      const r = await asUser(outsider, (db) => db.query("select 1 from public.media_assets where sha256 = $1", [SHA("0")]));
      expect(r.rowCount).toBe(0);
      const all = await asUser(outsider, (db) => db.query("select 1 from public.media_assets where workspace_id = $1", [ws.id]));
      expect(all.rowCount).toBe(0);
    });

    it("fila técnica e storage_gc não são acessíveis a usuários", async () => {
      await expectPgError(asUser(owner, (db) => db.query("select * from public.media_jobs limit 1")), DENIED);
      await expectPgError(asUser(owner, (db) => db.query("select * from public.storage_gc limit 1")), DENIED);
    });
  });

  describe("coleções", () => {
    it("cria, adiciona, reordena; bloqueia mistura entre workspaces", async () => {
      const [m1, m2] = await begin(editor, ws.id, [file({ sha256: SHA("aa") }), file({ sha256: SHA("bb") })]);
      const col = await asUser(
        editor,
        async (db) =>
          (await db.query<{ id: string }>("insert into public.collections (workspace_id, name, created_by) values ($1, 'Semana 1', $2) returning id", [ws.id, editor]))
            .rows[0]!.id,
        { commit: true },
      );
      await asUser(
        editor,
        (db) =>
          db.query("insert into public.collection_items (collection_id, media_asset_id, workspace_id, position) values ($1,$2,$4,0),($1,$3,$4,1)", [
            col,
            m1!.media_id,
            m2!.media_id,
            ws.id,
          ]),
        { commit: true },
      );
      await asUser(editor, (db) => db.query("select public.reorder_collection($1, $2::uuid[])", [col, [m2!.media_id, m1!.media_id]]), { commit: true });
      const order = await pool.query("select media_asset_id from public.collection_items where collection_id = $1 order by position", [col]);
      expect(order.rows.map((r) => r.media_asset_id)).toEqual([m2!.media_id, m1!.media_id]);

      // vídeo de outro workspace na coleção: recusado
      const [foreign] = await begin(outsider, other.id, [file({ sha256: SHA("cc") })]);
      await expectPgError(
        asUser(editor, (db) =>
          db.query("insert into public.collection_items (collection_id, media_asset_id, workspace_id) values ($1,$2,$3)", [col, foreign!.media_id, ws.id]),
        ),
        DENIED,
      );
      // não membro não vê a coleção
      expect((await asUser(outsider, (db) => db.query("select 1 from public.collections where id = $1", [col]))).rowCount).toBe(0);
      // viewer não cria coleção
      await expectPgError(
        asUser(viewer, (db) => db.query("insert into public.collections (workspace_id, name, created_by) values ($1, 'X', $2)", [ws.id, viewer])),
        DENIED,
      );
    });
  });

  it("excluir workspace agenda limpeza do prefixo no storage", async () => {
    const u = await createUser({ email: uniqueEmail("gc") });
    const w = await createWorkspaceAs(u, "GC");
    await asUser(u, (db) => db.query("delete from public.workspaces where id = $1", [w.id]), { commit: true });
    const gc = await pool.query("select prefix from public.storage_gc where prefix = $1", [`${w.id}/`]);
    expect(gc.rowCount).toBe(1);
  });
});
