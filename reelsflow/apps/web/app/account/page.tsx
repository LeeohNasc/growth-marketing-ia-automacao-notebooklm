import type { Metadata } from "next";
import Link from "next/link";
import { DEFAULT_TIMEZONE } from "@reelsflow/domain";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getProfile, requireUser } from "@/lib/session";
import { DeleteAccountForm, ProfileForm } from "./account-forms";

export const metadata: Metadata = { title: "Minha conta" };

export default async function AccountPage() {
  const user = await requireUser();
  const profile = await getProfile(user.id);
  const email = user.email ?? "";
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-4 py-4 sm:px-6">
        <Logo href="/w" />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button asChild variant="ghost" size="sm">
            <Link href="/w">Voltar ao painel</Link>
          </Button>
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-2xl gap-6 px-4 pb-16 pt-4">
        <h1 className="text-2xl font-semibold tracking-tight">Minha conta</h1>
        <Card>
          <CardHeader>
            <CardTitle>Perfil</CardTitle>
            <CardDescription>E-mail: {email}</CardDescription>
          </CardHeader>
          <CardContent>
            <ProfileForm displayName={profile?.display_name ?? ""} timezone={profile?.default_timezone ?? DEFAULT_TIMEZONE} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Segurança</CardTitle>
            <CardDescription>Ao trocar a senha, todas as sessões abertas são encerradas.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/reset-password">Alterar senha</Link>
            </Button>
          </CardContent>
        </Card>
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle>Excluir conta</CardTitle>
            <CardDescription>
              Remove seu perfil, seus acessos e os workspaces em que você é o único membro. Não é possível desfazer.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DeleteAccountForm email={email} />
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
