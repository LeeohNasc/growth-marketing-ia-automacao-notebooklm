"use client";
import { useEffect, useRef, useState } from "react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { IMPLEMENTED_SECTIONS, NAV_ITEMS, type NavItem } from "@/lib/nav";
import { cn } from "@/lib/utils";

/**
 * Menu lateral. O item clicado é destacado no mesmo instante (sem esperar o servidor) e mostra um
 * indicador enquanto a página carrega; o destaque volta a seguir a URL assim que a navegação termina
 * ou é cancelada.
 */
export function AppNav({ slug, onNavigate }: { slug: string; onNavigate?: () => void }) {
  const pathname = usePathname();
  // Destaque provisório: vale só enquanto a URL for a mesma do momento do clique.
  const [clicked, setClicked] = useState<{ key: string; from: string } | null>(null);
  const pendingKey = clicked && clicked.from === pathname ? clicked.key : null;
  return (
    <nav aria-label="Navegação principal" className="flex flex-col gap-0.5 px-3">
      {NAV_ITEMS.map((item) => {
        const href = `/w/${slug}/${item.key}`;
        const atUrl = pathname === href || pathname.startsWith(`${href}/`);
        const active = pendingKey ? pendingKey === item.key : atUrl;
        return (
          <Link
            key={item.key}
            href={href}
            onClick={(e) => {
              if (!e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0 && !atUrl) setClicked({ key: item.key, from: pathname });
              onNavigate?.();
            }}
            aria-current={atUrl ? "page" : undefined}
            className={cn(
              "group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "bg-primary/15 font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <NavItemContent item={item} active={active} onSettled={() => setClicked((c) => (c?.key === item.key ? null : c))} />
          </Link>
        );
      })}
    </nav>
  );
}

function NavItemContent({ item, active, onSettled }: { item: NavItem; active: boolean; onSettled: () => void }) {
  const { pending } = useLinkStatus();
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !pending) onSettled();
    was.current = pending;
  }, [pending, onSettled]);
  const Icon = item.icon;
  const ready = IMPLEMENTED_SECTIONS.has(item.key);
  return (
    <>
      {pending ? (
        <LoaderCircle className="size-4 shrink-0 text-primary motion-safe:animate-spin" aria-hidden />
      ) : (
        <Icon className={cn("size-4 shrink-0", active && "text-primary")} aria-hidden />
      )}
      <span className="flex-1 truncate">{item.label}</span>
      {pending && <span className="sr-only">(carregando)</span>}
      {!ready && (
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]" aria-label={`Disponível na fase ${item.phase}`}>
          F{item.phase}
        </Badge>
      )}
    </>
  );
}
