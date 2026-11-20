import type { GraphClient } from "./graph";

/**
 * Permissões pedidas no Facebook Login (documentação v27.0) — SOMENTE Páginas do Facebook:
 * pages_show_list, pages_read_engagement, pages_manage_posts.
 * Contas do Instagram usam exclusivamente o Instagram Login (instagram-login.ts): um único
 * caminho por plataforma evita que uma conta receba um token do tipo errado.
 */
export const META_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"] as const;

export const REQUIRED_SCOPES = {
  facebook: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
} as const;

export type MetaAppConfig = { appId: string; appSecret: string; redirectUri: string };

export function buildAuthUrl(graph: GraphClient, cfg: Pick<MetaAppConfig, "appId" | "redirectUri">, state: string, opts: { rerequest?: boolean } = {}): string {
  const u = new URL(`https://www.facebook.com/${graph.version}/dialog/oauth`);
  u.searchParams.set("client_id", cfg.appId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", META_SCOPES.join(","));
  if (opts.rerequest) u.searchParams.set("auth_type", "rerequest");
  return u.toString();
}

type TokenResponse = { access_token: string; token_type?: string; expires_in?: number };

/** Troca o code por token e depois por token de longa duração (~60 dias). Somente no servidor. */
export async function exchangeCode(graph: GraphClient, cfg: MetaAppConfig, code: string): Promise<{ token: string; expiresAt: Date | null }> {
  const short = await graph.request<TokenResponse>("GET", "oauth/access_token", {
    params: { client_id: cfg.appId, client_secret: cfg.appSecret, redirect_uri: cfg.redirectUri, code },
  });
  const long = await graph.request<TokenResponse>("GET", "oauth/access_token", {
    params: { grant_type: "fb_exchange_token", client_id: cfg.appId, client_secret: cfg.appSecret, fb_exchange_token: short.access_token },
  });
  return { token: long.access_token, expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null };
}

export type MetaCandidate = {
  key: string; // "facebook:<page-id>"
  platform: "facebook";
  externalId: string;
  name: string;
  avatarUrl: string | null;
  pageId: string;
  pageToken: string;
  canPublish: boolean;
  missingScopes: string[];
};

type PagesResponse = {
  data: {
    id: string;
    name: string;
    access_token: string;
    tasks?: string[];
  }[];
  paging?: { next?: string };
};

/** Usuário, permissões concedidas e Páginas que o usuário administra. */
export async function discoverAccounts(graph: GraphClient, userToken: string): Promise<{ metaUserId: string; userName: string; granted: string[]; candidates: MetaCandidate[] }> {
  const me = await graph.request<{ id: string; name: string }>("GET", "me", { token: userToken, params: { fields: "id,name" } });
  const perms = await graph.request<{ data: { permission: string; status: string }[] }>("GET", "me/permissions", { token: userToken });
  const granted = perms.data.filter((p) => p.status === "granted").map((p) => p.permission);
  const pages: PagesResponse["data"] = [];
  let next: string | undefined;
  let guard = 0;
  do {
    const r: PagesResponse = await graph.request<PagesResponse>("GET", "me/accounts", {
      token: userToken,
      params: next ? undefined : { fields: "id,name,access_token,tasks", limit: 100 },
      rawUrl: next,
    });
    pages.push(...r.data);
    next = r.paging?.next;
  } while (next && ++guard < 10);

  const missing = (need: readonly string[]) => need.filter((s) => !granted.includes(s));
  const candidates: MetaCandidate[] = [];
  for (const p of pages) {
    const canCreate = (p.tasks ?? []).some((t) => t === "CREATE_CONTENT" || t === "MANAGE");
    const fbMissing = missing(REQUIRED_SCOPES.facebook);
    candidates.push({ key: `facebook:${p.id}`, platform: "facebook", externalId: p.id, name: p.name, avatarUrl: null, pageId: p.id, pageToken: p.access_token, canPublish: canCreate && !fbMissing.length, missingScopes: fbMissing });
  }
  return { metaUserId: me.id, userName: me.name, granted, candidates };
}

/** Revoga todas as permissões do app para o usuário (desconexão completa). */
export async function revokeAppPermissions(graph: GraphClient, userToken: string): Promise<void> {
  await graph.request("DELETE", "me/permissions", { token: userToken });
}
