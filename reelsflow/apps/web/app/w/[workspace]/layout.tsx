import { AppNav } from "@/components/app-nav";
import { AreaTabs } from "@/components/area-tabs";
import { Logo } from "@/components/logo";
import { MobileNav } from "@/components/mobile-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { UserMenu } from "@/components/user-menu";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { getProfile, listMyWorkspaces, requireWorkspace } from "@/lib/session";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const { user, workspace, role } = await requireWorkspace(slug);
  const [workspaces, profile] = await Promise.all([listMyWorkspaces(user.id), getProfile(user.id)]);
  const current = { id: workspace.id, name: workspace.name, slug: workspace.slug, role };

  return (
    <div className="flex min-h-dvh">
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground">
        Pular para o conteúdo
      </a>
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r bg-sidebar lg:flex">
        <div className="flex h-14 items-center px-6">
          <Logo href={`/w/${slug}/overview`} />
        </div>
        <div className="px-3 pb-3">
          <WorkspaceSwitcher current={current} workspaces={workspaces} />
        </div>
        <div className="flex-1 overflow-y-auto pb-6">
          <AppNav slug={slug} />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur sm:px-6">
          <MobileNav slug={slug} />
          <span className="truncate text-sm font-medium lg:hidden">{workspace.name}</span>
          {workspace.is_demo && (
            <Badge variant="warning" title="Os dados deste workspace são demonstrativos">
              Ambiente demonstrativo
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <UserMenu name={profile?.display_name ?? ""} email={user.email ?? ""} />
          </div>
        </header>
        <main id="conteudo" className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <AreaTabs slug={slug} />
          {children}
        </main>
      </div>
    </div>
  );
}
