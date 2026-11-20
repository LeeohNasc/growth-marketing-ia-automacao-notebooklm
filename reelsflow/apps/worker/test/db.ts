import pg from "pg";
import postgres from "postgres";
import { POSTGRES_JS_OPTIONS, postgresJsDb, type Db } from "../src/db";

/**
 * Banco dos testes: `pg` por padrão; WORKER_DB_DRIVER=postgresjs usa o mesmo
 * driver da Edge Function (postgres.js), para provar que as consultas funcionam nos dois.
 */
export function makeDb(max = 6): Db & { end(): Promise<void> } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL não definido — use `pnpm test:db` na raiz.");
  if (process.env.WORKER_DB_DRIVER === "postgresjs") {
    // postgres.js não aceita "postgresql://u@/db?host=/sock"; decompõe a URL de socket.
    const m = url.match(/^postgres(?:ql)?:\/\/([^@]+)@\/([^?]+)\?host=([^&]+)&port=(\d+)$/);
    const opts = { ...POSTGRES_JS_OPTIONS, max };
    const sql = m
      ? postgres({ ...opts, user: m[1], database: m[2], host: decodeURIComponent(m[3]!), port: Number(m[4]) })
      : postgres(url, opts);
    return postgresJsDb(sql as never);
  }
  return new pg.Pool({ connectionString: url, max });
}
