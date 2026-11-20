// ReelsFlow · worker como Edge Function. Disparado a cada minuto pelo pg_cron (pg_net).
// Proteção: verify_jwt desligado + segredo compartilhado no cabeçalho x-worker-secret.
// O segredo é gerado DENTRO do banco (Vault, nome "worker_tick_secret") e nunca sai dele:
// o cron o lê de vault.decrypted_secrets e a função o lê pela própria conexão ao banco.
import postgres from "npm:postgres@3.4.9";
import { runEdgeTick } from "./worker.bundle.js";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

function safeEqual(a: string, b: string) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i]! ^ y[i]!;
  return d === 0;
}

let cachedSecret: string | null = null;
async function tickSecret(dbUrl: string): Promise<string | null> {
  if (cachedSecret) return cachedSecret;
  const sql = postgres(dbUrl, { prepare: false, max: 1 });
  try {
    const rows = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'worker_tick_secret' limit 1`;
    cachedSecret = (rows[0]?.decrypted_secret as string | undefined) ?? null;
    return cachedSecret;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST" || !req.headers.get("x-worker-secret")) return new Response("forbidden", { status: 403 });
  const dbUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!dbUrl) return new Response("missing runtime env", { status: 500 });
  const secret = await tickSecret(dbUrl);
  if (!secret || secret.length < 32) return new Response("worker not configured", { status: 503 });
  if (!safeEqual(req.headers.get("x-worker-secret") ?? "", secret)) {
    return new Response("forbidden", { status: 403 });
  }
  const env = {
    databaseUrl: dbUrl,
    supabaseUrl: Deno.env.get("SUPABASE_URL")!,
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    tokenEncryptionKey: Deno.env.get("TOKEN_ENCRYPTION_KEY") || undefined,
    graphVersion: Deno.env.get("META_GRAPH_VERSION") || undefined,
    simulatedAccounts: Deno.env.get("ENABLE_SIMULATED_ACCOUNTS") !== "false",
  };
  if (!env.databaseUrl || !env.supabaseUrl || !env.serviceRoleKey) {
    return new Response("missing runtime env", { status: 500 });
  }
  const id = crypto.randomUUID();
  const work = runEdgeTick(env, postgres, id).catch((e) => {
    console.error(JSON.stringify({ level: "error", msg: "tick failed", invocation: id, error: String(e) }));
  });
  // Responde já (o pg_net tem timeout curto) e segue processando em segundo plano.
  if (typeof EdgeRuntime !== "undefined") {
    EdgeRuntime.waitUntil(work);
    return Response.json({ accepted: true, invocation: id }, { status: 202 });
  }
  await work;
  return Response.json({ done: true, invocation: id });
});
