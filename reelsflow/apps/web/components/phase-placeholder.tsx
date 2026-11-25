import { Construction } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { NavItem } from "@/lib/nav";

/** Estado honesto para telas cujo backend ainda não existe: nada de dados fictícios. */
export function PhasePlaceholder({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <div className="mx-auto max-w-2xl">
      <Card>
        <CardHeader className="items-start gap-3">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-lg bg-primary/15 text-primary">
              <Icon className="size-5" aria-hidden />
            </span>
          </div>
          <CardTitle className="text-xl">{item.label}</CardTitle>
          <CardDescription>{item.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            <Construction className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              Esta área ainda não está disponível. Até lá, nenhum dado é exibido para não apresentar informações que não
              existem.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
