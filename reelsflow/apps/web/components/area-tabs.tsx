"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { locate } from "@/lib/nav";
import { cn } from "@/lib/utils";

/**
 * Abas da área atual (ex.: Calendário → Calendário · Lista · Publicadas · Campanhas). Cada aba é uma tela
 * que já existia, no mesmo endereço; nada some, só fica agrupado. Áreas com uma única tela não mostram abas.
 */
export function AreaTabs({ slug }: { slug: string }) {
  const pathname = usePathname();
  const here = locate(pathname, slug);
  if (!here || here.item.sections.length < 2) return null;
  return (
    <nav aria-label={`Seções de ${here.item.label}`} className="-mx-4 -mt-6 mb-6 overflow-x-auto border-b px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <ul className="flex min-w-max gap-1">
        {here.item.sections.map((s) => {
          const active = s.path === here.section.path;
          return (
            <li key={s.path}>
              <Link
                href={`/w/${slug}/${s.path}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
