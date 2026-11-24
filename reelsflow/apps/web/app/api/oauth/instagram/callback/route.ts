import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeInstagramCode,
  exchangeInstagramLongLived,
  fetchInstagramProfile,
  missingInstagramScopes,
} from "@reelsflow/connectors/server";
import { instagramConfig, instagramGraph } from "@/lib/instagram";
import { tokenCipher } from "@/lib/meta";
import { createClient } from "@/lib/supabase/server";
import { SESSION_ENDED_PATH } from "@/lib/session";

/**
 * Retorno do Instagram Login:
 * 1. sessão do ReelsFlow + state válido (no banco) ANTES de usar o code;
 * 2. code → token curto → token longo (60 dias), no servidor (App Secret nunca sai daqui);
 * 3. GET /me: ID da conta profissional, @, nome, foto; confere que o ID bate com o da troca;
 * 4. token cifrado (AES-256-GCM, contexto "instagram:<id>") e gravado com a conta.
 * Tokens e o App Secret nunca vão para o navegador, logs ou URLs de redirecionamento.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const go = (path: string) => NextResponse.redirect(new URL(path, origin));
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return go(SESSION_ENDED_PATH);

  const state = searchParams.get("state") ?? "";
  const code = searchParams.get("code");
  if (searchParams.get("error") || !code || !/^[0-9a-f]{64}$/.test(state)) return go("/w?ig=denied");

  const cfg = instagramConfig();
  if (!cfg) return go("/w?ig=not_configured");
  const { data: valid } = await supabase.rpc("check_oauth_state", { p_state: state });
  if (!valid) return go("/w?ig=invalid_state");

  let slug: string;
  try {
    const graph = instagramGraph();
    const short = await exchangeInstagramCode(cfg, code);
    const long = await exchangeInstagramLongLived(graph, cfg, short.shortToken);
    const profile = await fetchInstagramProfile(graph, long.token);
    // O token precisa ser da conta que acabou de autorizar.
    if (profile.userId !== short.userId) return go("/w?ig=account_mismatch");
    const missing = missingInstagramScopes(short.permissions);
    const { data, error } = await supabase.rpc("connect_instagram_account", {
      p_state: state,
      p_account: {
        user_id: profile.userId,
        username: profile.username,
        name: profile.name,
        avatar_url: profile.avatarUrl,
        account_type: profile.accountType,
        granted: short.permissions,
        expires_at: long.expiresAt?.toISOString() ?? null,
        token: tokenCipher().seal(long.token, `instagram:${profile.userId}`),
      },
    });
    if (error || !data) {
      return go(error?.message?.includes("plan limit") ? "/w?ig=plan_limit" : "/w?ig=invalid_state");
    }
    slug = data;
    if (missing.length) return go(`/w/${slug}/accounts?ig=missing_scopes`);
  } catch {
    return go("/w?ig=error");
  }
  return go(`/w/${slug}/accounts?ig=connected`);
}
