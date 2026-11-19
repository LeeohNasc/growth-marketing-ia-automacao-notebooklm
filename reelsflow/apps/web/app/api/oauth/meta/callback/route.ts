import { NextResponse, type NextRequest } from "next/server";
import { discoverAccounts, exchangeCode } from "@reelsflow/connectors/server";
import { metaConfig, metaGraph, tokenCipher } from "@/lib/meta";
import { createClient } from "@/lib/supabase/server";

/**
 * Retorno do Facebook Login. Valida a sessão e o state (no banco), troca o code
 * por token de longa duração, descobre Páginas/Instagram e guarda os candidatos
 * com tokens CIFRADOS. O usuário escolhe as contas na tela seguinte.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const go = (path: string) => NextResponse.redirect(new URL(path, origin));
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return go("/login");

  const state = searchParams.get("state") ?? "";
  const code = searchParams.get("code");
  if (searchParams.get("error") || !code || !/^[0-9a-f]{64}$/.test(state)) return go("/w?meta=denied");

  const cfg = metaConfig();
  if (!cfg) return go("/w?meta=not_configured");
  // Valida o state ANTES de usar o code: impede login CSRF e uso de code alheio.
  const { data: valid } = await supabase.rpc("check_oauth_state", { p_state: state });
  if (!valid) return go("/w?meta=invalid_state");
  const graph = metaGraph();
  try {
    const { token } = await exchangeCode(graph, cfg, code);
    const found = await discoverAccounts(graph, token);
    const cipher = tokenCipher();
    const pending = {
      meta_user_id: found.metaUserId,
      user_name: found.userName,
      granted: found.granted,
      candidates: found.candidates.map((c) => ({
        key: c.key,
        platform: c.platform,
        external_id: c.externalId,
        name: c.name,
        avatar_url: c.avatarUrl,
        page_id: c.pageId,
        can_publish: c.canPublish,
        missing_scopes: c.missingScopes,
        // Contexto da cifra = conta de destino: o token não pode ser usado em outra conta.
        page_token: cipher.seal(c.pageToken, `${c.platform}:${c.externalId}`),
      })),
    };
    const { data: slug, error } = await supabase.rpc("complete_oauth", { p_state: state, p_pending: pending });
    if (error || !slug) return go("/w?meta=invalid_state");
    return go(`/w/${slug}/accounts/connect?state=${state}`);
  } catch {
    return go("/w?meta=error");
  }
}
