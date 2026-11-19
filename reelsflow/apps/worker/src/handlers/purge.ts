import type { Handler } from "./types";

/** Remove arquivos do storage e, salvo `keep_row`, o registro do vídeo excluído. */
export const handlePurge: Handler = async (job, { db, storage, log }) => {
  const paths = Array.isArray(job.payload.paths) ? job.payload.paths.filter((p): p is string => typeof p === "string") : [];
  if (job.media_asset_id) {
    const { rows } = await db.query<{ deleted_at: string | null; status: string; thumbnail_path: string | null }>(
      "select deleted_at, status, thumbnail_path from public.media_assets where id = $1",
      [job.media_asset_id],
    );
    const m = rows[0];
    // Restaurado depois de agendado: não apagar.
    if (m && !m.deleted_at && !job.payload.keep_row && m.status !== "failed") {
      log.info("purge skipped (restored)", { job_id: job.id });
      return;
    }
    if (m?.thumbnail_path && !paths.includes(m.thumbnail_path)) paths.push(m.thumbnail_path);
  }
  if (paths.length) await storage.remove(paths);
  if (job.media_asset_id && !job.payload.keep_row) {
    await db.query("delete from public.media_assets where id = $1 and deleted_at is not null", [job.media_asset_id]);
  }
  log.info("purge done", { job_id: job.id, files: paths.length });
};
