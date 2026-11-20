import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronRight, Plus } from "lucide-react";
import { ROLE_LABELS } from "@reelsflow/domain";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { listMyWorkspaces, requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Workspaces" };

export default async function WorkspacesPage({ searchParams }: { searchParams: Promise<{ meta?: string; ig?: string }> }) {
  const { meta, ig } = await searchParams;
  const user = await requireUser();
  const workspaces = await listMyWorkspaces(user.id);
  if (workspaces.length === 0) redirect("/onboarding");
  // Avisos do retorno do OAuth (Facebook Login: meta; Instagram Login: ig) vão para Contas Conectadas.
  const metaNotice = meta && /^[a-z_]{1,32}$/.test(meta) ? `?meta=${meta}` : ig && /^[a-z_]{1,32}$/.test(ig) ? `?ig=${ig}` : "";
  if (workspaces.length === 1) redirect(metaNotice ? `/w/${workspaces[0]!.slug}/accounts${metaNotice}` : `/w/${workspaces[0]!.slug}/overview`);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="px-4 py-4 sm:px-6">
        <Logo href="/w" />
      </header>
      <main className="mx-auto grid w-full max-w-lg gap-4 px-4 pb-16 pt-6">
        <h1 className="text-2xl font-semibold tracking-tight">Escolha um workspace</h1>
        <ul className="grid gap-2">
          {workspaces.map((w) => (
            <li key={w.id}>
              <Link
                href={metaNotice ? `/w/${w.slug}/accounts${metaNotice}` : `/w/${w.slug}/overview`}
                className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="grid size-8 place-items-center rounded bg-secondary text-sm font-semibold uppercase">{w.name.slice(0, 1)}</span>
                <span className="flex-1">
                  <span className="block font-medium">{w.name}</span>
                  <span className="block text-xs text-muted-foreground">{ROLE_LABELS[w.role]}</span>
                </span>
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
        <Button asChild variant="outline">
          <Link href="/onboarding">
            <Plus /> Novo workspace
          </Link>
        </Button>
      </main>
    </div>
  );
}
