import type { Metadata } from "next";
import { Logo } from "@/components/logo";
import { requireUser } from "@/lib/session";
import { ResetForm } from "./reset-form";

export const metadata: Metadata = { title: "Nova senha" };

export default async function ResetPasswordPage() {
  await requireUser();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="px-4 py-4 sm:px-6">
        <Logo />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-6 sm:items-center sm:pt-0">
        <div className="grid w-full max-w-sm gap-6">
          <div className="grid gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">Definir nova senha</h1>
            <p className="text-sm text-muted-foreground">Depois de salvar, você precisará entrar novamente em todos os dispositivos.</p>
          </div>
          <ResetForm />
        </div>
      </main>
    </div>
  );
}
