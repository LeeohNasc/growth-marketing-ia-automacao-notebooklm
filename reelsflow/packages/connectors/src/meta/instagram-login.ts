import { ConnectorError } from "../types";
import { MetaApiError, parseJsonSafe, type GraphClient } from "./graph";

/**
 * Instagram API with Instagram Login — autorização e tokens.
 * Documentação consultada em 2026-11-20 (Graph API v27.0):
 *  - business-login: https://www.instagram.com/oauth/authorize → code (1 h, uso único, sufixo "#_")
 *  - code → token curto (1 h): POST https://api.instagram.com/oauth/access_token
 *  - curto → longo (60 dias): GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token
 *  - renovação: GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token
 *    (token com ≥ 24 h, ainda válido, com instagram_business_basic; novo prazo de 60 dias)
 * Não exige Página do Facebook. A conta precisa ser profissional (Business ou Creator).
 */
export const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_content_publish"] as const;
export const INSTAGRAM_GRAPH_HOST = "graph.instagram.com";

export type InstagramAppConfig = { appId: string; appSecret: string; redirectUri: string };

export function buildInstagramAuthUrl(cfg: Pick<InstagramAppConfig, "appId" | "redirectUri">, state: string, opts: { forceReauth?: boolean } = {}): string {
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.searchParams.set("client_id", cfg.appId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", INSTAGRAM_SCOPES.join(","));
  u.searchParams.set("state", state);
  // Sempre pede login: permite conectar uma segunda conta sem herdar a sessão da primeira.
  if (opts.forceReauth ?? true) u.searchParams.set("force_reauth", "true");
  return u.toString();
}

/** A doc avisa: o code volta com "#_" no fim, que não faz parte dele. */
export function cleanInstagramCode(code: string): string {
  return code.replace(/#_$/, "");
}

type ShortTokenBody = { access_token: string; user_id: string | number; permissions?: string | string[] };

/** code → token de curta duração. Somente no servidor (usa o App Secret). */
export async function exchangeInstagramCode(
  cfg: InstagramAppConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ shortToken: string; userId: string; permissions: string[] }> {
  // A documentação envia campos multipart (-F); FormData produz exatamente isso.
  const form = new FormData();
  form.set("client_id", cfg.appId);
  form.set("client_secret", cfg.appSecret);
  form.set("grant_type", "authorization_code");
  form.set("redirect_uri", cfg.redirectUri);
  form.set("code", cleanInstagramCode(code));
  const res = await fetchImpl("https://api.instagram.com/oauth/access_token", { method: "POST", body: form });
  const raw = await res.text();
  let parsed: unknown = null;
  try {
    parsed = raw ? parseJsonSafe(raw) : null;
  } catch {
    parsed = null;
  }
  const json = parsed as
    | { data?: ShortTokenBody[]; error_type?: string; error_message?: string; code?: number; error?: { message?: string; code?: number } }
    | (ShortTokenBody & Record<string, unknown>)
    | null;
  // A doc mostra a resposta dentro de "data": [...]; aceita também o objeto direto.
  const row = (json && "data" in json && Array.isArray(json.data) ? json.data[0] : json) as ShortTokenBody | null;
  if (!res.ok || !row?.access_token || row.user_id === undefined) {
    const j = (json ?? {}) as { error_message?: string; code?: number; error?: { message?: string; code?: number } };
    throw new MetaApiError(j.error_message ?? j.error?.message ?? `HTTP ${res.status}`, res.status, { code: j.code ?? j.error?.code, message: j.error_message }, null);
  }
  const permissions = Array.isArray(row.permissions) ? row.permissions : String(row.permissions ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { shortToken: row.access_token, userId: String(row.user_id), permissions };
}

type LongToken = { access_token: string; token_type?: string; expires_in?: number };

const expiresAt = (seconds?: number) => (seconds && seconds > 0 ? new Date(Date.now() + seconds * 1000) : null);

/** token curto → token de longa duração (60 dias). Somente no servidor (usa o App Secret). */
export async function exchangeInstagramLongLived(graph: GraphClient, cfg: Pick<InstagramAppConfig, "appSecret">, shortToken: string) {
  const r = await graph.request<LongToken>("GET", "access_token", {
    host: INSTAGRAM_GRAPH_HOST,
    unversioned: true,
    params: { grant_type: "ig_exchange_token", client_secret: cfg.appSecret },
    token: shortToken,
    auth: "query",
  });
  return { token: r.access_token, expiresAt: expiresAt(r.expires_in) };
}

/** Renova um token de longa duração (não usa o App Secret). */
export async function refreshInstagramToken(graph: GraphClient, token: string) {
  const r = await graph.request<LongToken>("GET", "refresh_access_token", {
    host: INSTAGRAM_GRAPH_HOST,
    unversioned: true,
    params: { grant_type: "ig_refresh_token" },
    token,
    auth: "query",
  });
  return { token: r.access_token, expiresAt: expiresAt(r.expires_in) };
}

export type InstagramProfile = {
  /** ID da conta profissional (usado em /{ig-id}/media e media_publish). */
  userId: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  accountType: string | null;
};

/** Perfil da conta autorizada pelo token (GET /me). */
export async function fetchInstagramProfile(graph: GraphClient, token: string): Promise<InstagramProfile> {
  const r = await graph.request<Record<string, unknown> & { data?: Record<string, unknown>[] }>("GET", "me", {
    host: INSTAGRAM_GRAPH_HOST,
    params: { fields: "user_id,username,name,account_type,profile_picture_url" },
    token,
    auth: "query",
  });
  // O exemplo da doc devolve {"data":[{...}]}; aceita também o objeto direto.
  const me = (Array.isArray(r.data) ? r.data[0] : r) ?? {};
  const userId = me.user_id ?? me.id;
  if (userId === undefined || typeof me.username !== "string") {
    throw new ConnectorError("permanent", "Resposta inesperada do Instagram ao ler o perfil.", { code: "ig_profile_shape" });
  }
  return {
    userId: String(userId),
    username: me.username,
    name: typeof me.name === "string" && me.name.trim() ? me.name : null,
    avatarUrl: typeof me.profile_picture_url === "string" ? me.profile_picture_url : null,
    accountType: typeof me.account_type === "string" ? me.account_type : null,
  };
}

export function missingInstagramScopes(granted: string[]): string[] {
  return INSTAGRAM_SCOPES.filter((s) => !granted.includes(s));
}
