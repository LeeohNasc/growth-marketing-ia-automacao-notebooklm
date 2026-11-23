import { describe, expect, it } from "vitest";
import type { Compatibility } from "../media";
import { JOB_STATUSES, JOB_TRANSITIONS, canTransition, publicationBackoffSeconds } from "./job-state";
import { orderMedia, seededRandom } from "./order";
import { buildPlan, detectConflicts, type PlanMedia, type PlanTarget } from "./plan";
import { composeCaption, resolveContent } from "./precedence";
import { generateSlots, instantToLocal, localToInstant, scheduleRuleSchema, type ScheduleRule } from "./schedule";

const SP = "America/Sao_Paulo";
const NY = "America/New_York";
const ALL = [1, 2, 3, 4, 5, 6, 7];
const rule = (over: Partial<ScheduleRule> = {}): ScheduleRule => ({ timezone: SP, weekdays: ALL, times: ["09:00", "13:00", "19:00"], startDate: "2026-12-01", ...over });
const NOW = new Date("2026-11-19T12:00:00Z");

describe("generateSlots", () => {
  it("três por dia nos horários locais de São Paulo (UTC-3)", () => {
    const s = generateSlots(rule(), { notBefore: NOW, limit: 4 });
    expect(s.map((x) => x.scheduledAt)).toEqual([
      "2026-12-01T12:00:00Z",
      "2026-12-01T16:00:00Z",
      "2026-12-01T22:00:00Z",
      "2026-12-02T12:00:00Z",
    ]);
    expect(s[0]).toMatchObject({ localDate: "2026-12-01", localTime: "09:00", dstAdjusted: false });
  });

  it("90 vídeos a 3 por dia ocupam exatamente 30 dias", () => {
    const s = generateSlots(rule(), { notBefore: NOW, limit: 90 });
    expect(s).toHaveLength(90);
    expect(new Set(s.map((x) => x.localDate)).size).toBe(30);
    expect(s.at(-1)!.localDate).toBe("2026-12-30");
  });

  it("um por dia, apenas dias úteis", () => {
    const s = generateSlots(rule({ weekdays: [1, 2, 3, 4, 5], times: ["10:30"] }), { notBefore: NOW, limit: 6 });
    // 2026-12-01 é terça; sábado 05 e domingo 06 são pulados
    expect(s.map((x) => x.localDate)).toEqual(["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-07", "2026-12-08"]);
  });

  it("bloqueia horários no passado mesmo com data inicial antiga", () => {
    const s = generateSlots(rule({ startDate: "2026-11-01" }), { notBefore: NOW, limit: 2 });
    // 19/11 12:00Z = 09:00 local → 09:00 de hoje já passou (<=); próximo é 13:00 local
    expect(s[0]!.scheduledAt).toBe("2026-11-19T16:00:00Z");
  });

  it("respeita data final", () => {
    const s = generateSlots(rule({ endDate: "2026-12-02" }), { notBefore: NOW, limit: 100 });
    expect(s).toHaveLength(6);
  });

  it("horário inexistente (início do horário de verão em NY) é deslocado e sinalizado", () => {
    const s = generateSlots({ timezone: NY, weekdays: ALL, times: ["02:30"], startDate: "2027-03-14" }, { notBefore: NOW, limit: 1 });
    expect(s[0]).toMatchObject({ localDate: "2027-03-14", dstAdjusted: true, scheduledAt: "2027-03-14T07:30:00Z" });
  });

  it("horário ambíguo (fim do horário de verão em NY) usa a primeira ocorrência", () => {
    const { instant, dstAdjusted } = localToInstant("2027-11-07", "01:30", NY);
    expect(instant.toString()).toBe("2027-11-07T05:30:00Z"); // EDT (-4)
    expect(dstAdjusted).toBe(false);
  });

  it("mudança de fuso altera o instante, não o horário local", () => {
    const sp = generateSlots(rule({ times: ["09:00"] }), { notBefore: NOW, limit: 1 })[0]!;
    const lis = generateSlots(rule({ times: ["09:00"], timezone: "Europe/Lisbon" }), { notBefore: NOW, limit: 1 })[0]!;
    expect(sp.localTime).toBe(lis.localTime);
    expect(sp.scheduledAt).not.toBe(lis.scheduledAt);
    expect(instantToLocal(lis.scheduledAt, "Europe/Lisbon")).toEqual({ localDate: "2026-12-01", localTime: "09:00" });
  });

  it("valida a regra", () => {
    expect(scheduleRuleSchema.safeParse(rule({ times: ["25:00"] })).success).toBe(false);
    expect(scheduleRuleSchema.safeParse(rule({ weekdays: [] })).success).toBe(false);
    expect(scheduleRuleSchema.safeParse(rule({ endDate: "2026-11-01" })).success).toBe(false);
    const ok = scheduleRuleSchema.parse(rule({ times: ["19:00", "09:00", "09:00"], weekdays: [3, 1, 1] }));
    expect(ok.times).toEqual(["09:00", "19:00"]);
    expect(ok.weekdays).toEqual([1, 3]);
  });
});

describe("orderMedia", () => {
  const items = [
    { id: "c", createdAt: "2026-01-03", position: 0 },
    { id: "a", createdAt: "2026-01-01", position: 2 },
    { id: "b", createdAt: "2026-01-02", position: 1 },
  ];
  it("estratégias determinísticas", () => {
    expect(orderMedia(items, "upload").map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(orderMedia(items, "newest").map((i) => i.id)).toEqual(["c", "b", "a"]);
    expect(orderMedia(items, "manual").map((i) => i.id)).toEqual(["c", "b", "a"]);
  });
  it("aleatória reproduzível pela semente e independente da ordem de entrada", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, createdAt: "x", position: i }));
    const a = orderMedia(many, "random", 42).map((i) => i.id);
    const b = orderMedia([...many].reverse(), "random", 42).map((i) => i.id);
    const c = orderMedia(many, "random", 43).map((i) => i.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(new Set(a).size).toBe(50);
  });
  it("PRNG em [0,1)", () => {
    const r = seededRandom(1);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

const compat = (status: Partial<Record<string, "ok" | "warning" | "error">>): Compatibility =>
  ({
    rulesVersion: "t",
    platforms: {
      instagram_reels: { status: status.instagram_reels ?? "ok", issues: [] },
      facebook_reels: { status: status.facebook_reels ?? "ok", issues: [] },
      tiktok: { status: status.tiktok ?? "ok", issues: [] },
      youtube_shorts: { status: status.youtube_shorts ?? "ok", issues: [] },
    },
  }) as Compatibility;

const media = (n: number, targetId?: string): PlanMedia[] =>
  Array.from({ length: n }, (_, i) => ({ campaignMediaId: `cm${i}`, mediaId: `m${i}`, name: `v${i}`, compatibility: compat({}), targetId }));

const IG: PlanTarget = { targetId: "t-ig", accountId: "acc-ig", platform: "instagram", offsetMinutes: 0 };
const FB: PlanTarget = { targetId: "t-fb", accountId: "acc-fb", platform: "facebook", offsetMinutes: 15 };

describe("buildPlan", () => {
  it("espelhado: mesmo vídeo em todas as redes, com deslocamento por alvo", () => {
    const p = buildPlan({ mode: "mirrored", rule: rule(), targets: [IG, FB], media: media(90), notBefore: NOW });
    expect(p.jobs).toHaveLength(180);
    const first = p.jobs.filter((j) => j.mediaId === "m0");
    expect(first.map((j) => [j.targetId, j.scheduledAt])).toEqual([
      ["t-ig", "2026-12-01T12:00:00Z"],
      ["t-fb", "2026-12-01T12:15:00Z"],
    ]);
    expect(first[0]!.postGroupKey).toBe(first[1]!.postGroupKey);
    expect(p.jobs.filter((j) => j.targetId === "t-ig").at(-1)!.localDate).toBe("2026-12-30");
  });

  it("espelhado: incompatível é pulado apenas na rede afetada", () => {
    const m = media(2);
    m[0]!.compatibility = compat({ instagram_reels: "error" });
    const p = buildPlan({ mode: "mirrored", rule: rule(), targets: [IG, FB], media: m, notBefore: NOW });
    expect(p.skipped).toEqual([{ mediaId: "m0", name: "v0", targetId: "t-ig", reason: "incompatible" }]);
    expect(p.jobs.map((j) => `${j.mediaId}@${j.targetId}`)).toEqual(["m0@t-fb", "m1@t-ig", "m1@t-fb"]);
  });

  it("independente: cada rede com sua fila e seus horários", () => {
    const ig = { ...IG, rule: rule({ times: ["09:00"] }) };
    const fb = { ...FB, offsetMinutes: 0, rule: rule({ times: ["20:00"], weekdays: [6, 7] }) };
    const p = buildPlan({ mode: "independent", rule: rule(), targets: [ig, fb], media: [...media(3, "t-ig"), ...media(2, "t-fb")], notBefore: NOW });
    expect(p.jobs.filter((j) => j.targetId === "t-ig").map((j) => j.localDate)).toEqual(["2026-12-01", "2026-12-02", "2026-12-03"]);
    expect(p.jobs.filter((j) => j.targetId === "t-fb").map((j) => [j.localDate, j.localTime])).toEqual([
      ["2026-12-05", "20:00"],
      ["2026-12-06", "20:00"],
    ]);
    expect(p.jobs.every((j) => j.postGroupKey === null)).toBe(true);
  });

  it("independente: incompatível cede o slot ao próximo vídeo", () => {
    const m = media(3, "t-ig");
    m[0]!.compatibility = compat({ instagram_reels: "error" });
    const p = buildPlan({ mode: "independent", rule: rule({ times: ["09:00"] }), targets: [IG], media: m, notBefore: NOW });
    expect(p.jobs.map((j) => [j.mediaId, j.localDate])).toEqual([
      ["m1", "2026-12-01"],
      ["m2", "2026-12-02"],
    ]);
  });

  it("anexar a campanha existente começa depois do último agendamento", () => {
    const p = buildPlan({
      mode: "mirrored",
      rule: rule(),
      targets: [IG],
      media: media(1),
      notBefore: NOW,
      notBeforeByTarget: { "t-ig": new Date("2026-12-10T22:00:00Z") },
    });
    expect(p.jobs[0]!.scheduledAt).toBe("2026-12-11T12:00:00Z");
  });

  it("data final curta deixa vídeos sem slot, sinalizados", () => {
    const p = buildPlan({ mode: "mirrored", rule: rule({ endDate: "2026-12-01" }), targets: [IG], media: media(5), notBefore: NOW });
    expect(p.jobs).toHaveLength(3);
    expect(p.skipped.filter((s) => s.reason === "no_slot")).toHaveLength(2);
  });

  it("é determinístico", () => {
    const a = buildPlan({ mode: "mirrored", rule: rule(), targets: [IG, FB], media: media(10), notBefore: NOW });
    const b = buildPlan({ mode: "mirrored", rule: rule(), targets: [IG, FB], media: media(10), notBefore: NOW });
    expect(a).toEqual(b);
  });
});

describe("detectConflicts", () => {
  it("aponta publicações da mesma conta mais próximas que o espaçamento", () => {
    const c = detectConflicts(
      [
        { id: "1", accountId: "a", scheduledAt: "2026-12-01T12:00:00Z" },
        { id: "2", accountId: "a", scheduledAt: "2026-12-01T12:10:00Z" },
        { id: "3", accountId: "b", scheduledAt: "2026-12-01T12:05:00Z" },
        { id: "4", accountId: "a", scheduledAt: "2026-12-01T13:00:00Z" },
      ],
      30,
    );
    expect(c).toEqual([{ a: "1", b: "2", accountId: "a", minutesApart: 10 }]);
  });
});

describe("precedência", () => {
  it("vídeo > campanha > conta > global, com origem", () => {
    const r = resolveContent({
      global: { caption: "global", hashtags: ["#g"] },
      account: { caption: "conta" },
      campaign: { caption: "  ", hashtags: ["#c"] },
      media: { caption: null, hashtags: [] },
    });
    expect(r.caption).toEqual({ value: "conta", source: "account" });
    expect(r.hashtags).toEqual({ value: ["#c"], source: "campaign" });
    expect(resolveContent({ media: { caption: "vídeo" }, campaign: { caption: "camp" } }).caption.source).toBe("media");
    expect(resolveContent({}).caption).toEqual({ value: "", source: "none" });
  });
  it("compõe legenda com hashtags e respeita limite", () => {
    expect(composeCaption({ caption: "Olá", hashtags: ["#a", "#b"] }).text).toBe("Olá\n\n#a #b");
    const long = composeCaption({ caption: "x".repeat(2300), hashtags: [] });
    expect(long.text).toHaveLength(2200);
    expect(long.truncated).toBe(true);
  });
});

describe("máquina de estados", () => {
  it("terminais não saem; caminho feliz e incerto válidos", () => {
    expect(JOB_TRANSITIONS.published).toEqual([]);
    expect(JOB_TRANSITIONS.cancelled).toEqual([]);
    for (const [a, b] of [
      ["draft", "scheduled"],
      ["scheduled", "queued"],
      ["queued", "preparing"],
      ["preparing", "uploading"],
      ["uploading", "processing_remote"],
      ["processing_remote", "publishing"],
      ["publishing", "published"],
      ["publishing", "uncertain"],
      ["uncertain", "published"],
      ["failed_retryable", "preparing"],
    ] as const) {
      expect(canTransition(a, b), `${a}->${b}`).toBe(true);
    }
    expect(canTransition("published", "scheduled")).toBe(false);
    expect(canTransition("publishing", "scheduled")).toBe(false);
    expect(canTransition("uncertain", "preparing")).toBe(false); // nunca reenviar sem reconciliar
  });
  it("todos os estados têm transições definidas", () => {
    for (const s of JOB_STATUSES) expect(JOB_TRANSITIONS[s]).toBeDefined();
  });
  it("backoff de publicação", () => {
    const mid = () => 0.5;
    expect(publicationBackoffSeconds(1, { random: mid })).toBe(60);
    expect(publicationBackoffSeconds(3, { random: mid })).toBe(240);
    expect(publicationBackoffSeconds(30, { random: mid })).toBe(3600);
    expect(publicationBackoffSeconds(1, { retryAfterSeconds: 900 })).toBe(900);
  });
});

describe("reconciliação espaçada", () => {
  it("consultas crescem até 1 h; revisão só depois de ~1 dia", async () => {
    const { reconcileDelaySeconds, reconcileWindowSeconds, RECONCILE_MAX_ATTEMPTS } = await import("./job-state");
    expect([0, 1, 2, 3, 6, 7, 20].map(reconcileDelaySeconds)).toEqual([30, 60, 120, 240, 1920, 3600, 3600]);
    expect(RECONCILE_MAX_ATTEMPTS).toBe(30);
    const w = reconcileWindowSeconds();
    expect(w).toBeGreaterThan(20 * 3600);
    expect(w).toBeLessThan(30 * 3600);
  });
});
