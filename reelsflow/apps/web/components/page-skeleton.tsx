"use client";
import { usePathname } from "next/navigation";
import { findNavItem } from "@/lib/nav";

/**
 * Esqueleto da área principal, usado como loading.tsx SÓ nas páginas cujo tempo cresce com o volume
 * de dados (Visão Geral, Calendário, Fila, Histórico, Analytics). Nas páginas leves ele não é usado
 * de propósito: o React segura a revelação do conteúdo por ~300 ms depois de mostrar um estado de
 * carregamento, o que deixaria mais lentas páginas que respondem em < 150 ms (medido). Nelas, o
 * retorno imediato é o destaque + indicador no item do menu (AppNav).
 *
 * Estado de carregamento da área principal (o menu lateral e o cabeçalho ficam no layout e não
 * são remontados). Aparece no mesmo instante do clique: o Next pré-carrega este estado junto com
 * a rota, então a troca de tela não espera o servidor.
 *
 * Só mostra o título da seção de destino (texto fixo do menu) e blocos neutros: nenhum dado — de
 * nenhum workspace — é exibido aqui.
 */
export function PageSkeleton() {
  const pathname = usePathname();
  const section = pathname.split("/")[3] ?? "";
  const item = findNavItem(section);
  const narrow = section === "settings" || section === "notifications" || section === "billing";

  return (
    <div className={narrow ? "mx-auto grid max-w-3xl gap-6" : "mx-auto grid max-w-7xl gap-6"} aria-busy="true">
      <span role="status" className="sr-only">
        Carregando{item ? ` ${item.label}` : ""}…
      </span>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-2">
          {item ? (
            <p className="text-2xl font-semibold tracking-tight text-foreground/80" aria-hidden>
              {item.label}
            </p>
          ) : (
            <Bar className="h-8 w-56" />
          )}
          <Bar className="h-4 w-72 max-w-full" />
        </div>
        <Bar className="h-9 w-32" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-hidden>
        {Array.from({ length: 4 }, (_, i) => (
          <Bar key={i} className="h-24" />
        ))}
      </div>
      <Bar className="h-80" />
    </div>
  );
}

function Bar({ className }: { className: string }) {
  return <div className={`rounded-lg bg-muted motion-safe:animate-pulse ${className}`} aria-hidden />;
}
