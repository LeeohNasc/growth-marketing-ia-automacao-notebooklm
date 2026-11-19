import "server-only";
import { GraphClient, TokenCipher, type MetaAppConfig } from "@reelsflow/connectors/server";
import { siteUrl } from "@/lib/env";

/** Configuração do app Meta; null quando não configurado (botão de conexão desativado). */
export function metaConfig(): MetaAppConfig | null {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const hasKey = Boolean(process.env.TOKEN_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEYS);
  if (!appId || !appSecret || !hasKey) return null;
  return { appId, appSecret, redirectUri: process.env.META_REDIRECT_URI || siteUrl("/api/oauth/meta/callback") };
}

export function metaGraph() {
  return new GraphClient({ version: process.env.META_GRAPH_VERSION || undefined });
}

export function tokenCipher() {
  return TokenCipher.fromEnv();
}
