import { describe, expect, it } from "vitest";
import { ageBucket, median, percentChange, performanceIndicator, periodDelta, periodTotal, rankPosts, sumMetric, type PostLatest, type Snapshot } from "./analytics";

const post = (id: string, over: Partial<PostLatest> = {}): PostLatest => ({
  id,
  socialAccountId: "acc",
  platform: "instagram",
  publishedAt: "2026-11-01T12:00:00Z",
  metricsUpdatedAt: "2026-11-20T12:00:00Z",
  engagementRate: null,
  views: null, reach: null, likes: null, comments: null, shares: null, saves: null, engagement: null, follows: null, profile_views: null, total_watch_ms: null,
  ...over,
});
const snap = (postId: string, day: string, views: number | null): Snapshot => ({
  postId, day, views, reach: null, likes: null, comments: null, shares: null, saves: null, engagement: null, follows: null, profile_views: null, total_watch_ms: null,
});

describe("somas e variações", () => {
  it("ausente não vira zero; informa cobertura", () => {
    expect(sumMetric([post("a", { likes: 3 }), post("b"), post("c", { likes: 0 })], "likes")).toEqual({ value: 3, withData: 2, withoutData: 1 });
    expect(sumMetric([post("a"), post("b")], "shares")).toEqual({ value: null, withData: 0, withoutData: 2 });
  });
  it("variação percentual só com base válida", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(50, 100)).toBe(-50);
    expect(percentChange(10, 0)).toBeNull();
    expect(percentChange(null, 10)).toBeNull();
  });
});

describe("período vs vida do vídeo", () => {
  const old = post("old", { publishedAt: "2026-10-01T10:00:00Z", views: 900 });
  const fresh = post("new", { publishedAt: "2026-11-15T10:00:00Z", views: 200 });
  const snaps = [snap("old", "2026-11-09", 700), snap("old", "2026-11-16", 820), snap("old", "2026-11-20", 900), snap("new", "2026-11-16", 150), snap("new", "2026-11-20", 200)];

  it("post antigo: fim − foto anterior ao início", () => {
    expect(periodDelta(old, snaps, "views", "2026-11-10", "2026-11-20")).toBe(200);
  });
  it("post publicado no período: base zero", () => {
    expect(periodDelta(fresh, snaps, "views", "2026-11-10", "2026-11-20")).toBe(200);
  });
  it("sem foto anterior ao início: desconhecido (não inventa)", () => {
    expect(periodDelta(old, snaps, "views", "2026-11-05", "2026-11-20")).toBeNull();
  });
  it("total do período informa quantos posts têm histórico", () => {
    expect(periodTotal([old, fresh], snaps, "views", "2026-11-10", "2026-11-20")).toEqual({ value: 400, withData: 2, withoutData: 0 });
    expect(periodTotal([old, fresh], snaps, "views", "2026-11-05", "2026-11-20")).toEqual({ value: 200, withData: 1, withoutData: 1 });
  });
  it("queda de contagem na plataforma não gera valor negativo", () => {
    expect(periodDelta(old, [snap("old", "2026-11-09", 950), snap("old", "2026-11-20", 900)], "views", "2026-11-10", "2026-11-20")).toBe(0);
  });
});

describe("ranking", () => {
  it("ordena pela métrica; ausentes vão para o fim", () => {
    const r = rankPosts([post("a", { likes: 5 }), post("b"), post("c", { likes: 9 })], "likes").map((x) => x.post.id);
    expect(r).toEqual(["c", "a", "b"]);
  });
  it("desempenho recente usa só o ganho dos últimos 7 dias", () => {
    const a = post("a", { publishedAt: "2026-10-01T00:00:00Z", views: 10000 });
    const b = post("b", { publishedAt: "2026-10-01T00:00:00Z", views: 3000 });
    const snaps = [snap("a", "2026-11-13", 9950), snap("a", "2026-11-20", 10000), snap("b", "2026-11-13", 1000), snap("b", "2026-11-20", 3000)];
    expect(rankPosts([a, b], "recent", { snapshots: snaps, todayDay: "2026-11-20" }).map((x) => [x.post.id, x.value])).toEqual([["b", 2000], ["a", 50]]);
  });
});

describe("indicador de desempenho", () => {
  const peers = [100, 120, 80, 110, 90].map((v, i) => post(`p${i}`, { views: v }));
  it("acima / dentro / abaixo pela mediana de vídeos da mesma idade", () => {
    expect(median([100, 120, 80, 110, 90])).toBe(100);
    expect(performanceIndicator(post("x", { views: 130 }), [...peers]).label).toBe("above");
    expect(performanceIndicator(post("x", { views: 100 }), [...peers]).label).toBe("within");
    expect(performanceIndicator(post("x", { views: 79 }), [...peers]).label).toBe("below");
  });
  it("menos de 5 comparáveis, outra faixa de idade ou outra conta: dados insuficientes", () => {
    expect(performanceIndicator(post("x", { views: 500 }), peers.slice(0, 4)).label).toBe("insufficient");
    const young = post("x", { views: 500, publishedAt: "2026-11-20T00:00:00Z" });
    expect(ageBucket(young)).toBe("lt1d");
    expect(performanceIndicator(young, peers).label).toBe("insufficient");
    expect(performanceIndicator(post("x", { views: 500, socialAccountId: "outra" }), peers).label).toBe("insufficient");
    expect(performanceIndicator(post("x", { views: null }), peers).label).toBe("insufficient");
  });
});
