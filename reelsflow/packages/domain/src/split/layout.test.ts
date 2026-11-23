import { describe, expect, it } from "vitest";
import { DEFAULT_SPLIT, coverCrop, mixPcm, normalizeSplit, outputDuration, sourceTime, splitRects, swapSlots, validateSplit, type SplitConfig } from "./layout";

const cfg = (over: Partial<SplitConfig> = {}): SplitConfig => ({ ...DEFAULT_SPLIT, top: { ...DEFAULT_SPLIT.top }, bottom: { ...DEFAULT_SPLIT.bottom }, ...over });
const src = (durationS: number, hasAudio = true) => ({ durationS, hasAudio, width: 1920, height: 1080 });

describe("áreas da tela dividida", () => {
  it("50/50 = 1080×960 + 1080×960; 60/40 e 40/60 com alturas pares e sem sobra", () => {
    expect(splitRects("50/50")).toEqual({ top: { x: 0, y: 0, w: 1080, h: 960 }, bottom: { x: 0, y: 960, w: 1080, h: 960 } });
    for (const r of ["60/40", "40/60"] as const) {
      const { top, bottom } = splitRects(r);
      expect(top.h % 2).toBe(0);
      expect(bottom.h % 2).toBe(0);
      expect(top.h + bottom.h).toBe(1920);
    }
    expect(splitRects("60/40").top.h).toBe(1152);
    expect(splitRects("40/60").top.h).toBe(768);
  });
});

describe("recorte cover", () => {
  it("vídeo horizontal 16:9 numa metade 1080×960: preenche a altura, corta as laterais, sem distorcer", () => {
    const c = coverCrop({ width: 1920, height: 1080 }, { w: 1080, h: 960 }, { zoom: 1, offsetX: 0, offsetY: 0 });
    expect(c.h).toBeCloseTo(1080);
    expect(c.w / c.h).toBeCloseTo(1080 / 960);
    expect(c.x).toBeCloseTo((1920 - c.w) / 2);
  });
  it("vídeo vertical 9:16: preenche a largura e corta em cima/embaixo; offset move dentro da sobra", () => {
    const base = { zoom: 1, offsetX: 0 };
    const mid = coverCrop({ width: 1080, height: 1920 }, { w: 1080, h: 960 }, { ...base, offsetY: 0 });
    const top = coverCrop({ width: 1080, height: 1920 }, { w: 1080, h: 960 }, { ...base, offsetY: -1 });
    const bot = coverCrop({ width: 1080, height: 1920 }, { w: 1080, h: 960 }, { ...base, offsetY: 1 });
    expect(mid.w).toBeCloseTo(1080);
    expect(top.y).toBe(0);
    expect(bot.y + bot.h).toBeCloseTo(1920);
    expect(mid.y).toBeCloseTo(480);
  });
  it("zoom 2× pega metade da área; nunca sai da origem (valores fora da faixa são limitados)", () => {
    const c = coverCrop({ width: 1920, height: 1080 }, { w: 1080, h: 960 }, { zoom: 2, offsetX: 5, offsetY: -5 });
    expect(c.h).toBeCloseTo(540);
    expect(c.x + c.w).toBeCloseTo(1920);
    expect(c.y).toBe(0);
  });
});

describe("tempo", () => {
  it("duração: principal manda; shortest usa o menor; trechos respeitados", () => {
    expect(outputDuration(cfg(), { top: 40, bottom: 12 })).toBe(40);
    expect(outputDuration(cfg({ main: "bottom" }), { top: 40, bottom: 12 })).toBe(12);
    expect(outputDuration(cfg({ duration: "shortest" }), { top: 40, bottom: 12 })).toBe(12);
    expect(outputDuration(cfg({ top: { ...DEFAULT_SPLIT.top, startS: 5, endS: 25 } }), { top: 40, bottom: 12 })).toBe(20);
  });
  it("vídeo secundário mais curto: congela no fim (main) ou recomeça (loop_other)", () => {
    expect(sourceTime(cfg(), "bottom", 20, 12)).toBeCloseTo(12, 2);
    expect(sourceTime(cfg({ duration: "loop_other" }), "bottom", 20, 12)).toBeCloseTo(8);
    // trecho inicial do secundário é respeitado no loop
    expect(sourceTime(cfg({ duration: "loop_other", bottom: { ...DEFAULT_SPLIT.bottom, startS: 2, endS: 6 } }), "bottom", 9, 12)).toBeCloseTo(3);
    // o principal nunca repete
    expect(sourceTime(cfg({ duration: "loop_other" }), "top", 10, 40)).toBe(10);
  });
});

describe("validação", () => {
  it("bloqueia vídeo ausente, trecho inválido, áudio escolhido inexistente, final curto demais", () => {
    expect(validateSplit(cfg(), { top: null, bottom: src(10) }).filter((i) => i.blocking).map((i) => i.code)).toEqual(["missing_top"]);
    const bad = cfg({ top: { ...DEFAULT_SPLIT.top, startS: 8, endS: 5 } });
    expect(validateSplit(bad, { top: src(10), bottom: src(10) }).some((i) => i.code === "end_top")).toBe(true);
    expect(validateSplit(cfg(), { top: src(10, false), bottom: src(10) }).find((i) => i.code === "audio_top")?.blocking).toBe(true);
    expect(validateSplit(cfg({ audio: { ...DEFAULT_SPLIT.audio, mode: "mix" } }), { top: src(10), bottom: src(10, false) }).find((i) => i.code === "audio_bottom")?.blocking).toBe(false);
    expect(validateSplit(cfg({ duration: "shortest" }), { top: src(10), bottom: src(2) }).some((i) => i.code === "too_short")).toBe(true);
  });
  it("avisa (sem bloquear) que o secundário vai congelar", () => {
    const issues = validateSplit(cfg(), { top: src(30), bottom: src(10) });
    expect(issues).toEqual([expect.objectContaining({ code: "freeze", blocking: false })]);
  });
});

describe("troca de posição e normalização", () => {
  it("trocar leva junto enquadramento, trecho, áudio e proporção", () => {
    const c = cfg({ ratio: "60/40", top: { ...DEFAULT_SPLIT.top, zoom: 2 }, audio: { mode: "top", topVolume: 1, bottomVolume: 0.2 } });
    const s = swapSlots(c);
    expect(s).toMatchObject({ ratio: "40/60", main: "bottom", bottom: { zoom: 2 }, audio: { mode: "bottom", topVolume: 0.2, bottomVolume: 1 } });
    expect(swapSlots(s)).toEqual(c);
  });
  it("padrão: áudio do superior e inferior silenciado; lixo vira padrão", () => {
    expect(normalizeSplit({}).audio.mode).toBe("top");
    expect(normalizeSplit({ ratio: "70/30", top: { zoom: 99, offsetX: -9 }, audio: { mode: "x", topVolume: 9 } })).toMatchObject({ ratio: "50/50", top: { zoom: 3, offsetX: -1 }, audio: { mode: "top", topVolume: 2 } });
  });
});

describe("mistura de áudio", () => {
  it("soma com ganho, limita em ±1 e completa a fonte curta com silêncio", () => {
    const out = mixPcm(new Float32Array([0.5, 0.8, 0.2]), new Float32Array([0.5, 0.8]), 1, 0.5, 4);
    expect([...out].map((v) => Number(v.toFixed(2)))).toEqual([0.75, 1, 0.2, 0]);
  });
});
