// ReelsFlow · exclusão da própria conta (LGPD). verify_jwt ligado: só usuário autenticado.
// A service role é injetada pelo runtime da Supabase e nunca chega ao navegador nem ao app web.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });

  // Cliente do próprio usuário: auth.uid() nas RPCs é ele.
  const asUser = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authError } = await asUser.auth.getUser(token);
  if (authError || !auth.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { data: blockers, error: blockersError } = await asUser.rpc("account_deletion_blockers");
  if (blockersError) return Response.json({ error: "check_failed" }, { status: 500 });
  if (Array.isArray(blockers) && blockers.length > 0) {
    return Response.json({ error: "sole_owner", workspaces: blockers.map((b: { workspace_name: string }) => b.workspace_name) }, { status: 409 });
  }

  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await admin.auth.admin.deleteUser(auth.user.id);
  if (error) return Response.json({ error: "delete_failed" }, { status: 500 });
  return Response.json({ deleted: true });
});
