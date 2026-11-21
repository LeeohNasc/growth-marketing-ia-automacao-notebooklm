/** Conteúdo da landing page (pré-lançamento). Dados de demonstração e depoimentos são ILUSTRATIVOS. */

export const NAV = [
  { href: "#como", label: "Como funciona" },
  { href: "#publico", label: "Para quem é" },
  { href: "#planos", label: "Planos" },
  { href: "#faq", label: "Perguntas frequentes" },
] as const;

export const MOBILE_NAV = [{ href: "#demonstracao", label: "Demonstração" }, ...NAV] as const;

export type CalendarStatus = "Agendado" | "Em revisão";
export type CalendarDay = {
  day: string;
  event: { video: string; time: string; status: CalendarStatus; tone: "red" | "graphite" | "amber" } | null;
};

export const CALENDAR: CalendarDay[] = [
  { day: "Seg 18", event: { video: "Corte do podcast", time: "12:00", status: "Agendado", tone: "red" } },
  { day: "Ter 19", event: { video: "Melhores momentos", time: "18:00", status: "Agendado", tone: "graphite" } },
  { day: "Qua 20", event: null },
  { day: "Qui 21", event: { video: "Bastidores", time: "17:00", status: "Em revisão", tone: "amber" } },
  { day: "Sex 22", event: null },
];

export const LIBRARY = [
  { name: "Corte do podcast", duration: "00:42", status: "Na programação", tone: "red" },
  { name: "Bastidores da gravação", duration: "00:27", status: "Pronto para organizar", tone: "neutral" },
] as const;

export const HISTORY = [
  { name: "Dica rápida", when: "Sex · 12h", status: "Publicado", tone: "green" },
  { name: "Resumo da semana", when: "Sáb · 18h", status: "Falha no envio", tone: "red" },
] as const;

export const AUDIENCE = [
  { title: "Criadores", text: "Organize o que já gravou e o que ainda precisa entrar na agenda." },
  { title: "Páginas de memes", text: "Distribua os vídeos da semana pelos horários da página." },
  { title: "Produtores de cortes", text: "Espalhe os melhores trechos de um mesmo episódio ao longo da semana." },
  { title: "Social medias", text: "Revise a programação e acompanhe o andamento das postagens." },
] as const;

export const PRESETS = [
  { label: "1 vídeo por dia", videos: 1, minutes: 4, days: 20 },
  { label: "3 vídeos por dia", videos: 3, minutes: 4, days: 25 },
  { label: "6 vídeos por dia", videos: 6, minutes: 4, days: 25 },
] as const;

export const USE_CASE_STEPS = [
  { title: "Envie os cortes", text: "Reúna os vídeos do episódio na biblioteca." },
  { title: "Distribua na semana", text: "Reserve segunda para o primeiro corte, terça para os melhores momentos e quinta para os bastidores." },
  { title: "Confira o andamento", text: "Veja no calendário quais vídeos estão agendados e quais ainda precisam de revisão." },
] as const;

export const TESTIMONIALS = [
  {
    name: "Marina Vale",
    user: "@marina.exemplo",
    role: "Criador de conteúdo",
    text: "Antes, meus vídeos prontos ficavam espalhados em várias pastas. Com a biblioteca e o calendário no mesmo lugar, consigo olhar a semana inteira e ver onde ainda falta conteúdo.",
  },
  {
    name: "Rafael Prado",
    user: "@rafael.exemplo",
    role: "Social media",
    text: "Na hora de revisar a programação, eu precisava cruzar planilha e mensagens. No painel, bato o olho e vejo o que já está agendado e o que ainda precisa de revisão.",
  },
  {
    name: "Lívia Torres",
    user: "@livia.exemplo",
    role: "Produtor de cortes",
    text: "A parte mais chata era lembrar de voltar para publicar cada corte. Agora separo os trechos do episódio de uma vez e distribuo cada vídeo no calendário da semana.",
  },
] as const;

export type PlanKey = "starter" | "pro" | "business" | "premium";
export const PLANS: { key: PlanKey; name: string; price: string; period: string | null; audience: string; features: string[]; featured?: boolean }[] = [
  { key: "starter", name: "Starter", price: "Grátis", period: null, audience: "Para experimentar", features: ["1 conexão social limitada.", "1 usuário.", "Editor básico."] },
  {
    key: "pro", name: "Pro", price: "R$ 99,90", period: "/mês", audience: "Para criadores individuais",
    features: ["1 conta social · 1 marca.", "1 usuário.", "Card Editorial.", "Agendamento automático.", "Publicação em lote."],
  },
  {
    key: "business", name: "Business", price: "R$ 299,90", period: "/mês", audience: "Para empresas", featured: true,
    features: ["4 contas sociais · 1 marca.", "3 membros.", "Publicação multirrede.", "Biblioteca compartilhada.", "Permissões básicas de equipe."],
  },
  {
    key: "premium", name: "Premium", price: "R$ 799,90", period: "/mês", audience: "Para agências",
    features: ["12 contas sociais · 3 marcas.", "6 membros.", "Permissões avançadas propostas.", "Gestão por cliente, aprovações e relatórios avançados no roteiro de desenvolvimento."],
  },
];

export const COMPARISON: [string, string, string, string, string][] = [
  ["Contas sociais", "1 (limitada)", "1", "4", "12"],
  ["Marcas", "A definir", "1", "1", "3"],
  ["Usuários ou membros", "1", "1", "3", "6"],
  ["Card Editorial", "Editor básico", "Incluído", "Incluído", "Incluído"],
  ["Agendamento automático", "A definir", "Incluído", "Incluído", "Incluído"],
  ["Publicação em lote", "A definir", "Incluída", "Incluída", "Incluída"],
  ["Publicação multirrede", "A definir", "Limitada a 1 conexão", "Incluída", "Incluída"],
  ["Biblioteca compartilhada", "A definir", "—", "Incluída", "A definir"],
  ["Permissões de equipe", "—", "—", "Básicas", "Avançadas"],
  ["Gestão de clientes e marcas", "—", "—", "—", "Planejada"],
  ["Aprovação de conteúdo", "—", "—", "—", "Planejada"],
  ["Relatórios por marca", "—", "—", "Básicos previstos", "Avançados planejados"],
];

export const GLOSSARY = [
  { term: "Conta social", text: "uma conexão com um perfil ou canal em uma rede social." },
  { term: "Marca", text: "um negócio ou cliente que pode ter contas em várias redes." },
  { term: "Workspace", text: "ambiente de trabalho para organizar conteúdo, marcas e permissões." },
] as const;

export const FAQ = [
  { q: "O que é o ReelsFlow?", a: "É uma plataforma para organizar e programar publicações de vídeos curtos. A demonstração mostra a experiência proposta para o painel." },
  { q: "Como funciona o agendamento?", a: "O fluxo proposto parte de vídeos prontos, organiza os horários no calendário e apresenta o status de cada publicação." },
  { q: "Quais redes sociais são compatíveis?", a: "As integrações disponíveis para assinantes ainda precisam ser confirmadas antes da abertura das vendas." },
  { q: "O que acontece se uma publicação falhar?", a: "O histórico ilustrativo mostra como uma falha pode aparecer. O comportamento de reenvio depende da validação do produto em produção." },
  { q: "O ReelsFlow cria vídeos automaticamente?", a: "Esta prévia demonstra o fluxo a partir de vídeos que você já tem." },
  { q: "Como funcionam cobrança e cancelamento?", a: "As condições comerciais serão apresentadas quando houver um fluxo de assinatura disponível." },
] as const;
