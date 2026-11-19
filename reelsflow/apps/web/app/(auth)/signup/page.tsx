import type { Metadata } from "next";
import Link from "next/link";
import { SignUpForm } from "./signup-form";

export const metadata: Metadata = { title: "Criar conta" };

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Criar conta</h1>
        <p className="text-sm text-muted-foreground">Você receberá um e-mail para confirmar o cadastro.</p>
      </div>
      <SignUpForm next={next} />
      <p className="text-center text-sm text-muted-foreground">
        Já tem conta?{" "}
        <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
          Entrar
        </Link>
      </p>
    </div>
  );
}
