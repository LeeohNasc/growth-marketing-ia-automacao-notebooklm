import { CalendarDays, ChartColumn, House, Settings, SquarePen, type LucideIcon } from "lucide-react";

/** Uma tela existente dentro de uma área. `path` é relativo a /w/<slug>/ (ex.: "campaigns/new"). */
export type NavSection = { path: string; label: string };

/** Uma das cinco áreas do menu principal. A primeira seção é para onde o item do menu leva. */
export type NavItem = {
  key: string;
  label: string;
  icon: LucideIcon;
  description: string;
  sections: NavSection[];
};

/**
 * Menu principal: 5 áreas. Todas as telas antigas continuam existindo nos mesmos endereços e aparecem
 * como abas dentro da área em que se encaixam (links salvos continuam funcionando).
 */
export const NAV_ITEMS: NavItem[] = [
  {
    key: "overview",
    label: "Início",
    icon: House,
    description: "Próximas publicações, o que já saiu e o que precisa da sua atenção.",
    sections: [
      { path: "overview", label: "Resumo" },
      { path: "notifications", label: "Avisos" },
    ],
  },
  {
    key: "create",
    label: "Criar",
    icon: SquarePen,
    description: "Vídeos, Card Editorial e novas campanhas.",
    sections: [
      { path: "create", label: "Criar publicação" },
      { path: "library", label: "Biblioteca" },
      { path: "campaigns/new", label: "Nova campanha" },
    ],
  },
  {
    key: "calendar",
    label: "Calendário",
    icon: CalendarDays,
    description: "Tudo o que está agendado, saindo agora ou já publicado.",
    sections: [
      { path: "calendar", label: "Calendário" },
      { path: "queue", label: "Lista" },
      { path: "history", label: "Publicadas" },
      { path: "campaigns", label: "Campanhas" },
    ],
  },
  {
    key: "analytics",
    label: "Resultados",
    icon: ChartColumn,
    description: "Como as publicações estão indo.",
    sections: [{ path: "analytics", label: "Resultados" }],
  },
  {
    key: "settings",
    label: "Configurações",
    icon: Settings,
    description: "Contas, padrões de publicação, automações, equipe e assinatura.",
    sections: [
      { path: "settings", label: "Geral" },
      { path: "accounts", label: "Contas" },
      { path: "templates", label: "Padrões de publicação" },
      { path: "automations", label: "Automações" },
      { path: "billing", label: "Assinatura" },
    ],
  },
];

/** Área e seção de um caminho (/w/<slug>/...). A seção mais específica vence ("campaigns/new" > "campaigns"). */
export function locate(pathname: string, slug: string): { item: NavItem; section: NavSection } | null {
  const base = `/w/${slug}/`;
  if (!pathname.startsWith(base)) return null;
  const rest = pathname.slice(base.length);
  let best: { item: NavItem; section: NavSection } | null = null;
  for (const item of NAV_ITEMS) {
    for (const section of item.sections) {
      if (rest === section.path || rest.startsWith(`${section.path}/`)) {
        if (!best || section.path.length > best.section.path.length) best = { item, section };
      }
    }
  }
  return best;
}

export function findNavItem(key: string) {
  return NAV_ITEMS.find((i) => i.key === key);
}
