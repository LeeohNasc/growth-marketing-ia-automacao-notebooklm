import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="text-center">
        <p className="text-sm font-medium text-primary">404</p>
        <h1 className="mt-2 text-2xl font-semibold">Página não encontrada</h1>
        <p className="mt-2 text-muted-foreground">O endereço não existe ou você não tem acesso a ele.</p>
        <Button asChild className="mt-6">
          <Link href="/w">Ir para o painel</Link>
        </Button>
      </div>
    </main>
  );
}
