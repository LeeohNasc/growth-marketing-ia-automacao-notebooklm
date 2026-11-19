import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL não definido — use `pnpm test:db` na raiz.");

export const pool = new pg.Pool({ connectionString: url, max: 4 });

export type Db = pg.PoolClient;

/** Cria usuário em auth.users (como superusuário). */
export async function createUser(opts: { email: string; confirmed?: boolean; displayName?: string }): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into auth.users (email, email_confirmed_at, raw_user_meta_data)
     values ($1, case when $2 then now() else null end, jsonb_build_object('display_name', $3::text))
     returning id`,
    [opts.email, opts.confirmed ?? true, opts.displayName ?? ""],
  );
  return rows[0]!.id;
}

/**
 * Executa `fn` como o papel `authenticated` com `auth.uid() = userId`,
 * dentro de uma transação que é sempre desfeita — salvo `commit: true`.
 */
export async function asUser<T>(userId: string | null, fn: (db: Db) => Promise<T>, opts: { commit?: boolean } = {}): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (userId) {
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
      await client.query("set local role authenticated");
    } else {
      await client.query("set local role anon");
    }
    const out = await fn(client);
    await client.query(opts.commit ? "commit" : "rollback");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Executa como superusuário (setup de cenário). */
export async function asAdmin<T>(fn: (db: pg.Pool) => Promise<T>): Promise<T> {
  return fn(pool);
}

export async function createWorkspaceAs(userId: string, name = "Workspace Teste"): Promise<{ id: string; slug: string }> {
  return asUser(
    userId,
    async (db) => {
      const { rows } = await db.query<{ id: string; slug: string }>(
        "select id, slug from public.create_workspace($1, 'America/Sao_Paulo')",
        [name],
      );
      return rows[0]!;
    },
    { commit: true },
  );
}

export async function addMember(workspaceId: string, userId: string, role: "viewer" | "editor" | "admin" | "owner") {
  await pool.query("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [
    workspaceId,
    userId,
    role,
  ]);
}

let seq = 0;
export function uniqueEmail(prefix: string): string {
  seq += 1;
  return `${prefix}.${Date.now()}.${seq}.${Math.random().toString(36).slice(2, 8)}@test.local`;
}

/** Espera que a promessa rejeite com erro Postgres cujo código está em `codes`. */
export async function expectPgError(p: Promise<unknown>, codes: string[]): Promise<string> {
  try {
    await p;
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (codes.includes(code)) return code;
    throw new Error(`Erro inesperado (${code}): ${(err as Error).message}`);
  }
  throw new Error(`Esperava erro ${codes.join("|")}, mas a operação foi aceita.`);
}

/** 42501 = insufficient_privilege / violação de RLS em insert/with check. */
export const DENIED = ["42501"];
