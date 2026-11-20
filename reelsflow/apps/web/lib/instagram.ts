import "server-only";
import { GraphClient, type InstagramAppConfig } from "@reelsflow/connectors/server";
import { siteUrl } from "@/lib/env";

/**
 * Configuração do Instagram Login (somente servidor). null quando incompleta: o botão de
 * conexão fica desativado. O App Secret e a chave de cifra nunca chegam ao navegador.
 *  - INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET: "Instagram App ID/Secret" do painel da Meta
 *    (API setup with Instagram login), diferentes do App ID do Facebook.
 *  - TOKEN_ENCRYPTION_KEY: a MESMA chave configurada no worker (Edge Function).
 */
export function instagramConfig(): InstagramAppConfig | null {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  const hasKey = Boolean(process.env.TOKEN_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEYS);
  if (!appId || !appSecret || !hasKey) return null;
  return { appId, appSecret, redirectUri: process.env.INSTAGRAM_REDIRECT_URI || siteUrl("/api/oauth/instagram/callback") };
}

export function instagramGraph() {
  return new GraphClient({ version: process.env.META_GRAPH_VERSION || undefined });
}
