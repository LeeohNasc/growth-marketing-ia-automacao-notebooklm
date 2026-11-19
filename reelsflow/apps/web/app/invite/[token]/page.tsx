import type { Metadata } from "next";
import Link from "next/link";
import { ROLE_LABELS } from "@reelsflow/domain";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { AcceptButton } from "./accept-button";

export const metadata: Metadata = { title: "Convite" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const valid = /^[0-9a-f]{48}$/.test(token);
  const supabase = await createClient();
  const [{ data }, user] = await Promise.all([valid ? supabase.rpc("invitation_preview", { p_token: token }) : Promise.resolve({ data: null }), getCurrentUser()]);
  const inv = data?.[0];
  const next = encodeURIComponent(`/invite/${token}`);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="px-4 py-4 sm:px-6">
        <Logo />
      </header>
      <main className="flex flex-1 justify-center px-4 pt-6">
        <Card className="h-fit w-full max-w-md">
          {!inv || !inv.valid ? (
            <CardHeader>
              <CardTitle>Convite indisponível</CardTitle>
              <CardDescription>O convite é inválido, expirou, foi revogado ou já foi usado. Peça um novo ao administrador do workspace.</CardDescription>
            </CardHeader>
          ) : (
            <>
              <CardHeader>
                <CardTitle>Convite para {inv.workspace_name}</CardTitle>
                <CardDescription>
                  Papel: {ROLE_LABELS[inv.role]}. O convite é válido somente para <strong>{inv.email}</strong>.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                {user ? (
                  user.email?.toLowerCase() === inv.email ? (
                    <AcceptButton token={token} />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Você está conectado como {user.email}. Saia e entre com {inv.email} para aceitar.
                    </p>
                  )
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button asChild>
                      <Link href={`/login?next=${next}`}>Entrar para aceitar</Link>
                    </Button>
                    <Button asChild variant="outline">
                      <Link href={`/signup?next=${next}`}>Criar conta com {inv.email}</Link>
                    </Button>
                  </div>
                )}
              </CardContent>
            </>
          )}
        </Card>
      </main>
    </div>
  );
}
