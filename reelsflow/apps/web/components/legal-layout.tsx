import { Logo } from "@/components/logo";

export function LegalLayout({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-3xl items-center px-4 py-4 sm:px-6">
        <Logo />
      </header>
      <main className="mx-auto grid max-w-3xl gap-4 px-4 pb-16 sm:px-6">
        <div role="note" className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">
          Rascunho elaborado sem revisão jurídica. Deve ser revisado por advogado, completado com os dados do controlador e o contato do
          encarregado (DPO) antes do uso em produção ou do envio ao App Review.
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">Última atualização: {updated}</p>
        <article className="grid gap-4 text-sm leading-relaxed [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc">{children}</article>
      </main>
    </div>
  );
}
