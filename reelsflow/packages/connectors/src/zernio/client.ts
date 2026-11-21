/**
 * Cliente REST mínimo da API da Zernio (https://zernio.com/llms.txt, OpenAPI 3.1 em
 * https://zernio.com/openapi.yaml; consultados em 2026-11-21).
 *
 * - Base: https://zernio.com/api/v1 · Autenticação: `Authorization: Bearer <ZERNIO_API_KEY>`.
 * - Somente servidor: a chave vem de ZERNIO_API_KEY e nunca aparece em mensagens de erro ou logs.
 * - Fluxo inicial (llms.txt, "First Time Setup"): perfil → link de conexão → contas conectadas.
 *
 * REST em vez do SDK @zernio/node: o worker roda em Deno (Edge Function) e o SDK é 0.x com
 * publicações quase diárias; o cliente enxuto segue o mesmo padrão dos conectores da Meta.
 */

export const ZERNIO_BASE_URL = "https://zernio.com/api/v1";

/** Plataformas de publicação aceitas por GET /v1/connect/{platform} que o ReelsFlow usa. */
export const ZERNIO_SOCIAL_PLATFORMS = ["instagram", "facebook", "tiktok", "youtube"] as const;
export type ZernioPlatform = (typeof ZERNIO_SOCIAL_PLATFORMS)[number];

export type ZernioProfile = {
  _id: string;
  name: string;
  description?: string;
  externalId?: string | null;
  isDefault?: boolean;
  accountCount?: number;
  createdAt?: string;
};

export type ZernioAccount = {
  _id: string;
  platform: string;
  profileId: string | { _id: string };
  username?: string;
  displayName?: string;
  isActive?: boolean;
  profilePicture?: string;
};

/** Erro da API. `type`/`code` são estáveis; `message` é texto humano (não ramificar por ele). */
export class ZernioApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string | null,
    readonly code: string | null,
    readonly details: Record<string, unknown> | null,
    readonly requestId: string | null,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "ZernioApiError";
  }

  /** 408/429/5xx e falhas de rede podem ser repetidas; 4xx de validação/permissão não. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export type ZernioClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type Query = Record<string, string | number | boolean | undefined | null>;

export class ZernioClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ZernioClientOptions) {
    if (!opts.apiKey || !opts.apiKey.trim()) throw new Error("ZERNIO_API_KEY não configurada.");
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl ?? ZERNIO_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Lê a chave de ZERNIO_API_KEY (somente servidor). */
  static fromEnv(env: Record<string, string | undefined> = process.env, opts: Omit<ZernioClientOptions, "apiKey"> = {}): ZernioClient {
    const apiKey = env.ZERNIO_API_KEY;
    if (!apiKey) throw new Error("ZERNIO_API_KEY não configurada.");
    return new ZernioClient({ ...opts, apiKey });
  }

  async request<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, opts: { query?: Query; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: ctrl.signal });
    } catch (e) {
      const timeout = (e as { name?: string })?.name === "AbortError";
      throw new ZernioApiError(timeout ? "Tempo esgotado ao chamar a Zernio." : "Falha de rede ao chamar a Zernio.", 0, timeout ? "timeout" : "network_error", null, null, null, null);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* corpo não-JSON */
    }
    if (!res.ok) {
      const e = (json ?? {}) as { error?: string; type?: string; code?: string; details?: Record<string, unknown> };
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new ZernioApiError(
        redact(e.error ?? `HTTP ${res.status}`, this.apiKey),
        res.status,
        e.type ?? null,
        e.code ?? null,
        e.details ?? null,
        res.headers.get("x-request-id"),
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }
    return json as T;
  }

  // ---------------------------------------------------------------- perfis

  async listProfiles(filter: { externalId?: string; name?: string } = {}): Promise<ZernioProfile[]> {
    const r = await this.request<{ profiles?: ZernioProfile[] }>("GET", "profiles", { query: filter });
    return r.profiles ?? [];
  }

  async createProfile(input: { name: string; description?: string; externalId?: string; color?: string }): Promise<ZernioProfile> {
    const r = await this.request<{ profile: ZernioProfile }>("POST", "profiles", { body: input });
    return r.profile;
  }

  /**
   * Perfil idempotente por `externalId` (id do tenant no ReelsFlow): procura, senão cria.
   * Corrida entre duas criações: a API responde 409 com details.existingProfileId — reaproveita.
   */
  async ensureProfile(input: { name: string; externalId: string; description?: string }): Promise<{ profile: ZernioProfile; created: boolean }> {
    const found = (await this.listProfiles({ externalId: input.externalId })).find((p) => p.externalId === input.externalId);
    if (found) return { profile: found, created: false };
    try {
      return { profile: await this.createProfile(input), created: true };
    } catch (e) {
      const existing = e instanceof ZernioApiError && e.status === 409 ? e.details?.existingProfileId : undefined;
      if (typeof existing === "string") {
        const again = (await this.listProfiles({ externalId: input.externalId }))[0];
        return { profile: again ?? { _id: existing, name: input.name, externalId: input.externalId }, created: false };
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------- conexão de contas

  /**
   * Link de autorização hospedado pela Zernio (GET /v1/connect/{platform}). O usuário abre o
   * `authUrl`, autoriza na rede social e volta para `redirectUrl` com
   * connected/profileId/accountId/username (ou error/error_message).
   */
  async getConnectUrl(platform: ZernioPlatform, profileId: string, opts: { redirectUrl?: string } = {}): Promise<{ authUrl: string; state?: string }> {
    if (!ZERNIO_SOCIAL_PLATFORMS.includes(platform)) throw new Error(`Plataforma não suportada: ${platform}`);
    const r = await this.request<{ authUrl: string; state?: string }>("GET", `connect/${platform}`, {
      query: { profileId, redirect_url: opts.redirectUrl },
    });
    if (!r?.authUrl) throw new ZernioApiError("Resposta da Zernio sem authUrl.", 502, "api_error", "missing_auth_url", null, null, null);
    return r;
  }

  async listAccounts(profileId?: string): Promise<ZernioAccount[]> {
    const r = await this.request<{ accounts?: ZernioAccount[] }>("GET", "accounts", { query: { profileId } });
    return r.accounts ?? [];
  }

  async disconnectAccount(accountId: string): Promise<void> {
    await this.request("DELETE", `accounts/${encodeURIComponent(accountId)}`);
  }
}

/** Garante que a chave nunca vaze em mensagens (ex.: um erro que ecoe o cabeçalho). */
function redact(message: string, key: string): string {
  return key ? message.split(key).join("[redacted]") : message;
}
