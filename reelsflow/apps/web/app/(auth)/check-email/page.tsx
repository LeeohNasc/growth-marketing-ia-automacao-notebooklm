import type { Metadata } from "next";
import Link from "next/link";
import { MailCheck } from "lucide-react";

export const metadata: Metadata = { title: "Verifique seu e-mail" };

export default async function CheckEmailPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { type } = await searchParams;
  const recovery = type === "recovery";
  return (
    <div className="grid gap-4 text-center">
      <MailCheck className="mx-auto size-10 text-primary" aria-hidden />
      <h1 className="text-2xl font-semibold tracking-tight">Verifique seu e-mail</h1>
      <p className="text-sm text-muted-foreground">
        {recovery
          ? "Se houver uma conta com esse e-mail, enviamos um link para redefinir a senha."
          : "Se o cadastro puder ser concluído, enviamos um link de confirmação. Abra-o para ativar sua conta."}{" "}
        O link expira em pouco tempo; verifique também a caixa de spam.
      </p>
      <Link href="/login" className="text-sm font-medium underline-offset-4 hover:underline">
        Voltar para o login
      </Link>
    </div>
  );
}
