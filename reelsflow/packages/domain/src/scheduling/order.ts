/**
 * Ordem de distribuição dos vídeos. "upload" (primeiro enviado primeiro) e
 * "oldest" são equivalentes: a data de envio é a única data confiável que temos
 * (não há data de gravação). Mantidos ambos por clareza na interface.
 */
export const ORDER_STRATEGIES = ["upload", "oldest", "newest", "manual", "random"] as const;
export type OrderStrategy = (typeof ORDER_STRATEGIES)[number];

export const ORDER_LABELS: Record<OrderStrategy, string> = {
  upload: "Primeiro enviado primeiro",
  oldest: "Mais antigo primeiro",
  newest: "Mais recente primeiro",
  manual: "Ordem personalizada",
  random: "Aleatória (reproduzível)",
};

export type Orderable = { id: string; createdAt: string; position: number };

/** PRNG determinístico (mulberry32): mesma semente → mesma sequência. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function orderMedia<T extends Orderable>(items: T[], strategy: OrderStrategy, seed = 0): T[] {
  const list = [...items];
  const byCreated = (a: T, b: T) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  switch (strategy) {
    case "upload":
    case "oldest":
      return list.sort(byCreated);
    case "newest":
      return list.sort((a, b) => byCreated(b, a));
    case "manual":
      return list.sort((a, b) => a.position - b.position || byCreated(a, b));
    case "random": {
      // Base estável antes do embaralhamento: o resultado depende só da semente e do conjunto.
      list.sort((a, b) => a.id.localeCompare(b.id));
      const rnd = seededRandom(seed);
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [list[i], list[j]] = [list[j]!, list[i]!];
      }
      return list;
    }
  }
}
