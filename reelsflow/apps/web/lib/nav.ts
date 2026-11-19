import {
  Bell,
  CalendarDays,
  ChartColumn,
  CreditCard,
  FileStack,
  Film,
  History,
  LayoutDashboard,
  ListOrdered,
  Megaphone,
  Settings,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Fase do roadmap em que a tela ganha funcionalidade real. */
  phase: number;
  description: string;
};

/** Os 13 itens do menu lateral do PRD, na ordem definida. */
export const NAV_ITEMS: NavItem[] = [
  { key: "overview", label: "Visão Geral", icon: LayoutDashboard, phase: 1, description: "Resumo do workspace." },
  { key: "library", label: "Biblioteca de Vídeos", icon: Film, phase: 2, description: "Todos os vídeos enviados, com metadados, compatibilidade e histórico." },
  { key: "upload", label: "Upload em Massa", icon: Upload, phase: 2, description: "Envio de dezenas de vídeos com progresso, retomada e detecção de duplicados." },
  { key: "calendar", label: "Calendário", icon: CalendarDays, phase: 3, description: "Publicações por dia, semana, mês ou lista, com reagendamento por arrastar." },
  { key: "queue", label: "Fila de Publicações", icon: ListOrdered, phase: 3, description: "Monitoramento operacional de cada publicação, tentativas e erros." },
  { key: "campaigns", label: "Campanhas", icon: Megaphone, phase: 3, description: "Conjuntos de vídeos distribuídos automaticamente por um modelo." },
  { key: "templates", label: "Modelos de Publicação", icon: FileStack, phase: 3, description: "Frequência, horários, legendas e redes reutilizáveis." },
  { key: "accounts", label: "Contas Conectadas", icon: Users, phase: 4, description: "Contas Instagram e Páginas do Facebook conectadas por OAuth oficial." },
  { key: "history", label: "Histórico", icon: History, phase: 3, description: "Publicações concluídas e falhas, com links para o conteúdo publicado." },
  { key: "analytics", label: "Analytics", icon: ChartColumn, phase: 5, description: "Métricas reais das plataformas, quando autorizadas." },
  { key: "notifications", label: "Notificações", icon: Bell, phase: 1, description: "Avisos sobre uploads, campanhas, publicações e contas." },
  { key: "settings", label: "Configurações", icon: Settings, phase: 1, description: "Nome, fuso horário padrão e membros do workspace." },
  { key: "billing", label: "Assinatura", icon: CreditCard, phase: 5, description: "Plano atual e uso medido. Cobrança real ainda não integrada." },
];

export const IMPLEMENTED_SECTIONS = new Set(["overview", "notifications", "settings", "billing"]);

export function findNavItem(key: string) {
  return NAV_ITEMS.find((i) => i.key === key);
}
