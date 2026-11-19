"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { IMPLEMENTED_SECTIONS, NAV_ITEMS } from "@/lib/nav";
import { cn } from "@/lib/utils";

export function AppNav({ slug, onNavigate }: { slug: string; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Navegação principal" className="flex flex-col gap-0.5 px-3">
      {NAV_ITEMS.map((item) => {
        const href = `/w/${slug}/${item.key}`;
        const active = pathname === href || pathname.startsWith(`${href}/`);
        const Icon = item.icon;
        const ready = IMPLEMENTED_SECTIONS.has(item.key);
        return (
          <Link
            key={item.key}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "bg-primary/15 font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Icon className={cn("size-4 shrink-0", active && "text-primary")} aria-hidden />
            <span className="flex-1 truncate">{item.label}</span>
            {!ready && (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]" aria-label={`Disponível na fase ${item.phase}`}>
                F{item.phase}
              </Badge>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
