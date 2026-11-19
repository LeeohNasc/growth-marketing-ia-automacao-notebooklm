import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar" };

const NOTICES: Record<string, { text: string; variant: "success" | "destructive" }> = {
  "password-updated": { text: "Senha atualizada. Entre com a nova senha.", variant: "success" },
  "account-deleted": { text: "Sua conta foi excluída.", variant: "success" },
  "link-invalid": { text: "O link é inválido ou expirou. Solicite um novo.", variant: "destructive" },
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; notice?: string }> }) {
  const { next, notice } = await searchParams;
  const n = notice ? NOTICES[notice] : undefined;
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Entrar</h1>
        <p className="text-sm text-muted-foreground">Acesse seu painel do ReelsFlow.</p>
      </div>
      {n && <Alert variant={n.variant}>{n.text}</Alert>}
      <LoginForm next={next} />
      <p className="text-center text-sm text-muted-foreground">
        Não tem conta?{" "}
        <Link href="/signup" className="font-medium text-foreground underline-offset-4 hover:underline">
          Criar conta
        </Link>
      </p>
    </div>
  );
}
