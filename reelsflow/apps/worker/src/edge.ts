/**
 * Ponto de entrada do worker como Supabase Edge Function (Deno).
 * Um "tick" por invocação (disparada a cada minuto pelo pg_cron). Sem ffmpeg:
 * análise por leitura de faixas do MP4/MOV, miniatura gerada no navegador.
 *
 * O driver de banco (postgres.js) é injetado pelo chamador para que o bundle
 * não dependa de como o runtime resolve pacotes npm.
 */
import { ConnectorRegistry, MockConnector } from "@reelsflow/connectors";
import { FacebookConnector, GraphClient, InstagramConnector, TokenCipher, ZernioClient, ZernioConnector } from "@reelsflow/connectors/server";
import { POSTGRES_JS_OPTIONS, postgresJsDb } from "./db";
import { createLogger } from "./log";
import { PgCredentialProvider } from "./publishing/credentials";
import { PgMockStore } from "./publishing/store";
import { SupabaseStorage } from "./storage";
import { ResendSender } from "./notify/email";
import { tick, type WorkerOptions } from "./worker";

export type EdgeEnv = {
  databaseUrl: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  tokenEncryptionKey?: string;
  graphVersion?: string;
  /** Chave da Zernio (segredo da Edge Function). Sem ela, contas via Zernio aguardam na fila. */
  zernioApiKey?: string;
  /** Simulador de publicação ligado (padrão: sim, enquanto não houver app Meta aprovado). */
  simulatedAccounts?: boolean;
  /** Avisos por e-mail via Resend: só ativos com chave E remetente verificado. */
  resendApiKey?: string;
  emailFrom?: string;
  appUrl?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PostgresFactory = (url: string, opts: any) => any;

export async function runEdgeTick(env: EdgeEnv, postgres: PostgresFactory, invocationId: string) {
  const log = createLogger({ service: "reelsflow-worker-edge", invocation: invocationId }, (l) => console.log(l));
  const db = postgresJsDb(postgres(env.databaseUrl, { ...POSTGRES_JS_OPTIONS, max: 4 }));
  const storage = new SupabaseStorage(env.supabaseUrl, env.serviceRoleKey);
  const graph = new GraphClient({ version: env.graphVersion });
  // Edge Function tem limite de tempo por execução: espera curta pelo processamento do vídeo;
  // se a Meta ainda estiver processando, o próximo tick (1 min) retoma o mesmo container.
  const connectors = new ConnectorRegistry()
    .register(new InstagramConnector(graph, { pollIntervalMs: 10_000, pollBudgetMs: 40_000 }))
    .register(new FacebookConnector(graph));
  if (env.simulatedAccounts !== false) connectors.register(new MockConnector(new PgMockStore(db)));
  const zernio = env.zernioApiKey ? new ZernioClient({ apiKey: env.zernioApiKey }) : null;
  // Espera curta (limite de tempo da Edge Function); se a Zernio ainda estiver publicando,
  // o próximo tick (1 min) consulta o MESMO post, sem gastar tentativa.
  if (zernio) connectors.register(new ZernioConnector(zernio, { pollBudgetMs: 40_000, pollIntervalMs: 10_000 }));
  let cipher: TokenCipher | null = null;
  if (env.tokenEncryptionKey) {
    try {
      cipher = TokenCipher.fromEnv({ TOKEN_ENCRYPTION_KEY: env.tokenEncryptionKey });
    } catch (e) {
      log.warn("token cipher invalid; real publications will wait", { error: String(e) });
    }
  }
  const opts: WorkerOptions = {
    workerId: "edge-worker",
    concurrency: 3,
    // Lease curto: se a função for encerrada pelo limite de tempo, o reaper devolve o job logo.
    leaseSeconds: 120,
    pollMs: 0,
    maintenanceEveryMs: 0,
  };
  const started = Date.now();
  try {
    const processed = await tick(
      {
        db,
        storage,
        log,
        connectors,
        credentials: new PgCredentialProvider(db, cipher),
        instagramTokens: { cipher, graph },
        zernio,
        mediaUrl: (p, ttl) => storage.signedUrl(p, ttl ?? 2 * 3600),
        ffmpeg: { ffprobe: "ffprobe", ffmpeg: "ffmpeg" },
        tmpDir: "/tmp",
        probeMode: "remote",
        email: { sender: env.resendApiKey && env.emailFrom ? new ResendSender({ apiKey: env.resendApiKey, from: env.emailFrom }) : null, appUrl: env.appUrl ?? null },
      },
      opts,
      { lastMaintenance: 0 },
    );
    // Só a PRESENÇA da chave (booleano): o valor nunca vai para logs.
    log.info("tick done", { processed, ms: Date.now() - started, zernio_configured: zernio !== null, email_configured: Boolean(env.resendApiKey && env.emailFrom) });
    return { processed, ms: Date.now() - started };
  } finally {
    await db.end();
  }
}
