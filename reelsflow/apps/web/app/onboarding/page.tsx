import type { Metadata } from "next";
import Link from "next/link";
import { DEFAULT_TIMEZONE } from "@reelsflow/domain";
import { Logo } from "@/components/logo";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getProfile, listMyWorkspaces, requireUser } from "@/lib/session";
import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = { title: "Criar workspace" };

const STEPS = ["Criar workspace", "Enviar vídeos (Fase 2)", "Conectar redes sociais (Fase 4)"];

export default async function OnboardingPage() {
  const user = await requireUser();
  const [profile, workspaces] = await Promise.all([getProfile(user.id), listMyWorkspaces(user.id)]);
  const first = workspaces.length === 0;
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-4 py-4 sm:px-6">
        <Logo href="/w" />
        {!first && (
          <Link href="/w" className="text-sm text-muted-foreground hover:text-foreground">
            Cancelar
          </Link>
        )}
      </header>
      <main className="flex flex-1 justify-center px-4 pb-16 pt-6">
        <div className="grid w-full max-w-md gap-6">
          {first && (
            <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Etapas">
              {STEPS.map((s, i) => (
                <li key={s} className={i === 0 ? "font-medium text-primary" : undefined}>
                  {i + 1}. {s}
                </li>
              ))}
            </ol>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">{first ? "Bem-vindo ao ReelsFlow" : "Novo workspace"}</CardTitle>
              <CardDescription>
                O workspace reúne vídeos, campanhas e contas conectadas. Dados de workspaces diferentes nunca se misturam.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <OnboardingForm defaultTimezone={profile?.default_timezone ?? DEFAULT_TIMEZONE} />
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
