import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Destino de toda página/ação que encontrou um cookie de sessão que o servidor do Auth recusa
 * (sessão encerrada em outro dispositivo, usuário bloqueado ou excluído).
 *
 * Por que existe: o proxy (middleware) confere só a assinatura e a validade do JWT — sem ida à
 * rede — e trata esse usuário como logado; as páginas validam com getUser(), que detecta a
 * revogação. Sem limpar o cookie, /login → /w → /login… vira um ciclo até o JWT expirar (≤ 1 h).
 *
 * Segurança: aceita GET (é destino de redirect), mas só limpa o cookie se o Auth CONFIRMAR que a
 * sessão não vale mais — um link de terceiros não consegue deslogar quem tem sessão válida (CSRF).
 * Falha de rede/5xx do Auth não desloga ninguém: responde 503 com "tentar novamente".
 */
export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (data.user && !error) return noStore(NextResponse.redirect(new URL("/w", origin), { status: 303 }));

  const status = typeof (error as { status?: unknown } | null)?.status === "number" ? (error as { status: number }).status : 0;
  if (status >= 400 && status < 500) {
    // O Auth recusou a sessão (ou não há sessão): remove a sessão DESTE dispositivo. O cookie é
    // apagado antes da chamada ao Auth, então funciona mesmo com a sessão já revogada no servidor.
    await supabase.auth.signOut({ scope: "local" });
    return noStore(NextResponse.redirect(new URL("/login?notice=session-ended", origin), { status: 303 }));
  }

  return noStore(
    new NextResponse(
      `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Não foi possível validar sua sessão</title>` +
        `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5">` +
        `<h1 style="font-size:1.25rem">Não foi possível validar sua sessão agora</h1>` +
        `<p>O serviço de login não respondeu. Você continua conectado; tente de novo em instantes.</p>` +
        `<p><a href="/w">Tentar novamente</a></p></body></html>`,
      { status: 503, headers: { "content-type": "text/html; charset=utf-8", "retry-after": "10" } },
    ),
  );
}

function noStore(res: NextResponse) {
  res.headers.set("cache-control", "no-store");
  return res;
}
