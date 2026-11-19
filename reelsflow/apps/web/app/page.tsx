import Link from "next/link";
import { CalendarClock, ShieldCheck, UploadCloud } from "lucide-react";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";

const FEATURES = [
  { icon: UploadCloud, title: "Envie uma vez", text: "Selecione dezenas de vídeos de uma só vez e acompanhe o progresso de cada um." },
  { icon: CalendarClock, title: "Defina as regras", text: "Escolha frequência, horários e legendas padrão. O calendário é gerado automaticamente." },
  { icon: ShieldCheck, title: "APIs oficiais", text: "Conexão por OAuth oficial. Nunca pedimos a senha das suas redes sociais." },
];

export default function HomePage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Logo />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button asChild variant="ghost">
            <Link href="/login">Entrar</Link>
          </Button>
          <Button asChild>
            <Link href="/signup">Criar conta</Link>
          </Button>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-4 py-16 sm:px-6">
        <p className="text-sm font-medium text-primary">Publicação automática de vídeos curtos</p>
        <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
          Seus vídeos. Suas regras. Tudo no automático.
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-muted-foreground">
          Envie seus vídeos uma única vez, configure os horários e deixe o ReelsFlow organizar e publicar seu conteúdo
          nas redes sociais conectadas.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/signup">Começar agora</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/login">Já tenho conta</Link>
          </Button>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          Em desenvolvimento. Integrações com redes sociais dependem de aprovação das plataformas.
        </p>
        <ul className="mt-16 grid gap-4 sm:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <li key={title} className="rounded-xl border bg-card p-5">
              <Icon className="size-5 text-primary" aria-hidden />
              <h2 className="mt-3 font-medium">{title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{text}</p>
            </li>
          ))}
        </ul>
      </main>
      <footer className="mx-auto flex w-full max-w-6xl gap-4 px-4 py-6 text-sm text-muted-foreground sm:px-6">
        <a href="/privacy" className="hover:underline">
          Privacidade
        </a>
        <a href="/terms" className="hover:underline">
          Termos
        </a>
      </footer>
    </div>
  );
}
