import type { Db } from "../db";
import type { MockPlatformStore } from "@reelsflow/connectors";

/** Plataforma simulada persistida em Postgres (tabela mock_remote_posts). */
export class PgMockStore implements MockPlatformStore {
  constructor(private readonly db: Db) {}
  async createUpload(accountId: string, uploadRef: string, caption: string) {
    const r = await this.db.query<{ id: string }>(
      `insert into public.mock_remote_posts (social_account_id, upload_ref, caption) values ($1, $2, $3)
       on conflict (upload_ref) do update set upload_ref = excluded.upload_ref returning id`,
      [accountId, uploadRef, caption],
    );
    return r.rows[0]!.id;
  }
  async publish(uploadRef: string) {
    await this.db.query("update public.mock_remote_posts set status = 'published', published_at = now() where upload_ref = $1", [uploadRef]);
  }
  async find(uploadRef: string) {
    const r = await this.db.query<{ id: string; status: "processing" | "published" }>(
      "select id, status from public.mock_remote_posts where upload_ref = $1",
      [uploadRef],
    );
    return r.rows[0] ?? null;
  }
}
