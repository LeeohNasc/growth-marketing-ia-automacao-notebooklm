import { ConnectorError } from "../types";

/** Versão da Graph API usada (documentação consultada em 2026-11-19). Sobrescreva com META_GRAPH_VERSION. */
export const DEFAULT_GRAPH_VERSION = "v27.0";

export type MetaErrorBody = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
  fbtrace_id?: string;
};

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly body: MetaErrorBody,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

/** Códigos de limite documentados em "Rate Limiting" (Graph API). */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002]);
/** Token inválido/expirado/revogado (OAuthException 190) e permissões ausentes (10, 200–299). */
const isAuthCode = (code?: number) => code === 190 || code === 102 || code === 10 || (code !== undefined && code >= 200 && code <= 299);

/**
 * Converte erro da Graph API em ConnectorError.
 * `sideEffectStarted` informa se a chamada que falhou pode ter publicado.
 */
export function classifyMetaError(err: unknown, sideEffectStarted: boolean): ConnectorError {
  if (err instanceof ConnectorError) return err;
  if (err instanceof MetaApiError) {
    const code = err.body.code;
    const tag = `meta_${code ?? err.httpStatus}${err.body.error_subcode ? `_${err.body.error_subcode}` : ""}`;
    if (code !== undefined && RATE_LIMIT_CODES.has(code)) {
      return new ConnectorError("rate_limited", err.message, { code: tag, retryAfterSeconds: err.retryAfterSeconds ?? 900, sideEffectStarted: false });
    }
    if (isAuthCode(code)) return new ConnectorError("auth", err.message, { code: tag });
    if (err.body.is_transient || code === 1 || code === 2 || err.httpStatus >= 500) {
      // 5xx no passo que publica pode ter publicado: o chamador decide pelo flag.
      return new ConnectorError(sideEffectStarted ? "unknown" : "transient", err.message, { code: tag, sideEffectStarted });
    }
    return new ConnectorError("permanent", err.message, { code: tag });
  }
  const msg = err instanceof Error ? err.message : String(err);
  const timeout = (err as { name?: string })?.name === "AbortError" || /timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed/i.test(msg);
  return new ConnectorError(timeout ? "timeout" : "unknown", msg, { sideEffectStarted });
}

/** Lê `estimated_time_to_regain_access` (minutos) do cabeçalho X-Business-Use-Case-Usage. */
export function retryAfterFromHeaders(h: Headers): number | null {
  const raw = h.get("x-business-use-case-usage");
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, { estimated_time_to_regain_access?: number }[]>;
    const minutes = Math.max(0, ...Object.values(data).flat().map((x) => x.estimated_time_to_regain_access ?? 0));
    return minutes > 0 ? minutes * 60 : null;
  } catch {
    return null;
  }
}

export type GraphOptions = { version?: string; fetchImpl?: typeof fetch; timeoutMs?: number };

/** Cliente mínimo da Graph API: versão fixa, timeout, erros estruturados. Tokens nunca vão para logs. */
export class GraphClient {
  readonly version: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  constructor(opts: GraphOptions = {}) {
    this.version = opts.version ?? DEFAULT_GRAPH_VERSION;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  url(path: string, host = "graph.facebook.com") {
    return `https://${host}/${this.version}/${path.replace(/^\//, "")}`;
  }

  async request<T>(method: "GET" | "POST" | "DELETE", path: string, opts: { token?: string; params?: Record<string, string | number | boolean | undefined>; host?: string; headers?: Record<string, string>; rawUrl?: string } = {}): Promise<T> {
    const url = new URL(opts.rawUrl ?? this.url(path, opts.host));
    const params = Object.entries(opts.params ?? {}).filter(([, v]) => v !== undefined) as [string, string | number | boolean][];
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let body: string | undefined;
    // Token no cabeçalho (formato "OAuth <token>", usado na documentação da Meta), nunca na URL.
    if (opts.token && !headers.Authorization) headers.Authorization = `OAuth ${opts.token}`;
    if (method === "GET" || method === "DELETE") {
      for (const [k, v] of params) url.searchParams.set(k, String(v));
    } else if (params.length) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(params.map(([k, v]) => [k, String(v)] as [string, string])).toString();
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: ctrl.signal });
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
    if (!res.ok || (json && typeof json === "object" && "error" in json)) {
      const e = ((json as { error?: MetaErrorBody } | null)?.error ?? {}) as MetaErrorBody;
      throw new MetaApiError(e.message ?? `HTTP ${res.status}`, res.status, e, retryAfterFromHeaders(res.headers));
    }
    return json as T;
  }
}
