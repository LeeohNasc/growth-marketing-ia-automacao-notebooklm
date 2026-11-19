import type pg from "pg";
import type { Logger } from "./log";
import type { StorageAdapter } from "./storage";

/**
 * Uploads abandonados (status 'uploading' após a expiração): apaga o registro
 * e agenda remoção do arquivo, caso tenha chegado ao storage.
 */
export async function expireStaleUploads(db: pg.Pool, storage: StorageAdapter, log: Logger): Promise<number> {
  const { rows } = await db.query<{ id: string; workspace_id: string; storage_path: string }>(
    `select id, workspace_id, storage_path from public.media_assets
      where status = 'uploading' and upload_expires_at < now()
      order by upload_expires_at limit 100`,
  );
  for (const m of rows) {
    if (await storage.exists(m.storage_path)) {
      await db.query(
        "insert into public.media_jobs (workspace_id, kind, payload) values ($1, 'purge', jsonb_build_object('paths', jsonb_build_array($2::text)))",
        [m.workspace_id, m.storage_path],
      );
    }
    await db.query("delete from public.media_assets where id = $1 and status = 'uploading'", [m.id]);
  }
  if (rows.length) log.info("expired stale uploads", { count: rows.length });
  return rows.length;
}

/** Remove do storage os arquivos de workspaces excluídos. */
export async function processStorageGc(db: pg.Pool, storage: StorageAdapter, log: Logger): Promise<number> {
  const { rows } = await db.query<{ id: string; prefix: string }>(
    "select id::text, prefix from public.storage_gc where done_at is null order by created_at limit 10",
  );
  for (const row of rows) {
    try {
      const files = await storage.list(row.prefix);
      if (files.length) await storage.remove(files);
      await db.query("update public.storage_gc set done_at = now(), last_error = null where id = $1", [row.id]);
      log.info("storage gc done", { gc_id: row.id, files: files.length });
    } catch (err) {
      await db.query("update public.storage_gc set last_error = left($2, 500) where id = $1", [row.id, String(err)]);
      log.error("storage gc failed", { gc_id: row.id, error: String(err) });
    }
  }
  return rows.length;
}
