/**
 * Interface mínima de banco usada pelo worker. Implementada por `pg.Pool`
 * (Node/container) e pelo adaptador de postgres.js (Edge Function / Deno).
 */
export interface Db {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R = any>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

type PostgresJs = {
  unsafe(query: string, params?: unknown[], opts?: { prepare?: boolean }): Promise<unknown[] & { count: number }>;
  end(opts?: { timeout?: number }): Promise<void>;
};

/** Adapta um cliente postgres.js à interface `Db` (mesmas consultas, mesmos parâmetros $1..$n). */
export function postgresJsDb(sql: PostgresJs): Db & { end(): Promise<void> } {
  return {
    async query<R>(text: string, values: unknown[] = []) {
      const res = await sql.unsafe(text, values as never[]);
      return { rows: [...res] as R[], rowCount: res.count ?? res.length };
    },
    end: () => sql.end({ timeout: 5 }),
  };
}

/**
 * Opções obrigatórias do postgres.js para equivaler ao `pg`:
 * - prepare:false — o pooler do Supabase (modo transação) não aceita prepared statements;
 * - json: o worker já envia JSON serializado (`JSON.stringify(...)` com `$n::jsonb`). O padrão
 *   do postgres.js serializaria a string de novo, gravando um escalar JSON em vez do objeto.
 */
export const POSTGRES_JS_OPTIONS = {
  prepare: false as const,
  onnotice: () => {},
  types: {
    json: {
      to: 114,
      from: [114, 3802] as number[],
      serialize: (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x)),
      parse: (x: string) => JSON.parse(x),
    },
  },
};
