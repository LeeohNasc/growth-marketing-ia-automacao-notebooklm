/**
 * Tela Dividida (Split Screen) — regras puras de composição, sem I/O.
 * Usadas pela prévia E pelo arquivo final (mesmas contas = mesmo enquadramento).
 *
 * Saída: 1080×1920 (9:16), vídeo superior e inferior empilhados, sem faixas pretas
 * (cada vídeo PREENCHE a sua metade com recorte ajustável — zoom e posição).
 */

export const SPLIT_OUTPUT = { width: 1080, height: 1920, fps: 30 } as const;

export const SPLIT_RATIOS = ["50/50", "60/40", "40/60"] as const;
export type SplitRatio = (typeof SPLIT_RATIOS)[number];

export type SplitSlot = "top" | "bottom";

export type ClipConfig = {
  /** Início do trecho no vídeo de origem (s). */
  startS: number;
  /** Fim do trecho (s); null = até o fim do vídeo. */
  endS: number | null;
  /** 1 = preenche exatamente; até 3×. */
  zoom: number;
  /** Posição do recorte: -1 (esquerda/topo) … 0 (centro) … 1 (direita/base). */
  offsetX: number;
  offsetY: number;
};

export type AudioMode = "top" | "bottom" | "mix" | "mute";
/**
 * Duração do vídeo final (o vídeo "principal" manda):
 * - main: termina quando o principal termina; o outro é cortado (ou congela no último quadro se acabar antes);
 * - loop_other: igual, mas o outro vídeo recomeça do início do trecho quando acaba;
 * - shortest: termina quando o mais curto termina.
 */
export type DurationMode = "main" | "loop_other" | "shortest";

export type SplitConfig = {
  version: 1;
  ratio: SplitRatio;
  /** Qual vídeo é o principal (define a duração). Padrão: superior. */
  main: SplitSlot;
  top: ClipConfig;
  bottom: ClipConfig;
  audio: { mode: AudioMode; topVolume: number; bottomVolume: number };
  duration: DurationMode;
};

export const DEFAULT_CLIP: ClipConfig = { startS: 0, endS: null, zoom: 1, offsetX: 0, offsetY: 0 };

export const DEFAULT_SPLIT: SplitConfig = {
  version: 1,
  ratio: "50/50",
  main: "top",
  top: { ...DEFAULT_CLIP },
  bottom: { ...DEFAULT_CLIP },
  // Padrão pedido: áudio do superior, inferior em silêncio.
  audio: { mode: "top", topVolume: 1, bottomVolume: 0.35 },
  duration: "main",
};

export type SplitRect = { x: number; y: number; w: number; h: number };

/** Áreas de cada vídeo no quadro final. Alturas pares (exigência do H.264 4:2:0). */
export function splitRects(ratio: SplitRatio, out: { width: number; height: number } = SPLIT_OUTPUT): Record<SplitSlot, SplitRect> {
  const share = ratio === "50/50" ? 0.5 : ratio === "60/40" ? 0.6 : 0.4;
  const topH = Math.round((out.height * share) / 2) * 2;
  return {
    top: { x: 0, y: 0, w: out.width, h: topH },
    bottom: { x: 0, y: topH, w: out.width, h: out.height - topH },
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Recorte "cover" da origem para preencher `dst` sem distorcer e sem faixas pretas.
 * zoom > 1 aproxima; offset move o recorte dentro da sobra disponível.
 */
export function coverCrop(src: { width: number; height: number }, dst: { w: number; h: number }, clip: Pick<ClipConfig, "zoom" | "offsetX" | "offsetY">): SplitRect {
  const zoom = clamp(clip.zoom || 1, 1, 3);
  const scale = Math.max(dst.w / src.width, dst.h / src.height) * zoom;
  const w = dst.w / scale;
  const h = dst.h / scale;
  const spareX = src.width - w;
  const spareY = src.height - h;
  const x = (spareX / 2) * (1 + clamp(clip.offsetX, -1, 1));
  const y = (spareY / 2) * (1 + clamp(clip.offsetY, -1, 1));
  return { x, y, w, h };
}

/** Duração útil do trecho escolhido de um vídeo. */
export function clipLength(clip: ClipConfig, sourceDurationS: number): number {
  const start = clamp(clip.startS, 0, sourceDurationS);
  const end = clip.endS === null ? sourceDurationS : clamp(clip.endS, start, sourceDurationS);
  return Math.max(0, end - start);
}

export const other = (s: SplitSlot): SplitSlot => (s === "top" ? "bottom" : "top");

/** Duração final (s), conforme o modo e os trechos. */
export function outputDuration(cfg: SplitConfig, durations: Record<SplitSlot, number>): number {
  const len = { top: clipLength(cfg.top, durations.top), bottom: clipLength(cfg.bottom, durations.bottom) };
  if (cfg.duration === "shortest") return Math.min(len.top, len.bottom);
  return len[cfg.main];
}

/**
 * Instante da ORIGEM a mostrar no tempo `t` do vídeo final.
 * Se o trecho acabou: repete (loop_other, só para o vídeo secundário) ou congela no último quadro.
 */
export function sourceTime(cfg: SplitConfig, slot: SplitSlot, t: number, sourceDurationS: number): number {
  const clip = cfg[slot];
  const len = clipLength(clip, sourceDurationS);
  const start = clamp(clip.startS, 0, sourceDurationS);
  if (len <= 0) return start;
  const loop = cfg.duration === "loop_other" && slot !== cfg.main;
  const local = loop ? t % len : Math.min(t, Math.max(0, len - 1e-3));
  return start + local;
}

export type SplitIssue = { code: string; message: string; blocking: boolean };

/** Validação antes de renderizar (bloqueios) e avisos úteis. */
export function validateSplit(
  cfg: SplitConfig,
  sources: Record<SplitSlot, { durationS: number; hasAudio: boolean; width: number; height: number } | null>,
): SplitIssue[] {
  const out: SplitIssue[] = [];
  const name = { top: "superior", bottom: "inferior" } as const;
  for (const s of ["top", "bottom"] as const) {
    const src = sources[s];
    if (!src) {
      out.push({ code: `missing_${s}`, message: `Escolha o vídeo ${name[s]}.`, blocking: true });
      continue;
    }
    const c = cfg[s];
    if (c.startS < 0 || c.startS >= src.durationS) out.push({ code: `start_${s}`, message: `O início do vídeo ${name[s]} está fora da duração dele.`, blocking: true });
    if (c.endS !== null && c.endS <= c.startS) out.push({ code: `end_${s}`, message: `O fim do trecho do vídeo ${name[s]} precisa ser depois do início.`, blocking: true });
    if (clipLength(c, src.durationS) > 0 && clipLength(c, src.durationS) < 1) out.push({ code: `short_${s}`, message: `O trecho do vídeo ${name[s]} tem menos de 1 segundo.`, blocking: true });
  }
  const top = sources.top;
  const bottom = sources.bottom;
  if (top && bottom) {
    const total = outputDuration(cfg, { top: top.durationS, bottom: bottom.durationS });
    if (total > 0 && total < 3) out.push({ code: "too_short", message: "O vídeo final teria menos de 3 segundos.", blocking: true });
    if (total > 900) out.push({ code: "too_long", message: "O vídeo final passaria de 15 minutos. Encurte o trecho do vídeo principal.", blocking: true });
    const m = cfg.audio.mode;
    if ((m === "top" || m === "mix") && !top.hasAudio) out.push({ code: "audio_top", message: "O vídeo superior não tem áudio.", blocking: m === "top" });
    if ((m === "bottom" || m === "mix") && !bottom.hasAudio) out.push({ code: "audio_bottom", message: "O vídeo inferior não tem áudio.", blocking: m === "bottom" });
    if (cfg.duration === "main") {
      const sec = other(cfg.main);
      const lens = { top: clipLength(cfg.top, top.durationS), bottom: clipLength(cfg.bottom, bottom.durationS) };
      if (lens[sec] < lens[cfg.main]) {
        out.push({ code: "freeze", message: `O vídeo ${name[sec]} é mais curto e vai parar no último quadro. Escolha "repetir" para ele recomeçar.`, blocking: false });
      }
    }
  }
  return out;
}

/** Troca superior ↔ inferior (enquadramento e trechos acompanham o vídeo). */
export function swapSlots(cfg: SplitConfig): SplitConfig {
  const audioMode: AudioMode = cfg.audio.mode === "top" ? "bottom" : cfg.audio.mode === "bottom" ? "top" : cfg.audio.mode;
  return {
    ...cfg,
    ratio: cfg.ratio === "60/40" ? "40/60" : cfg.ratio === "40/60" ? "60/40" : cfg.ratio,
    main: other(cfg.main),
    top: cfg.bottom,
    bottom: cfg.top,
    audio: { mode: audioMode, topVolume: cfg.audio.bottomVolume, bottomVolume: cfg.audio.topVolume },
  };
}

/** Normaliza uma configuração vinda do banco/URL (valores fora da faixa viram o padrão). */
export function normalizeSplit(raw: unknown): SplitConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<SplitConfig>;
  const clip = (c: unknown): ClipConfig => {
    const x = (c && typeof c === "object" ? c : {}) as Partial<ClipConfig>;
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    return {
      startS: Math.max(0, num(x.startS, 0)),
      endS: typeof x.endS === "number" && Number.isFinite(x.endS) ? x.endS : null,
      zoom: clamp(num(x.zoom, 1), 1, 3),
      offsetX: clamp(num(x.offsetX, 0), -1, 1),
      offsetY: clamp(num(x.offsetY, 0), -1, 1),
    };
  };
  const a = (r.audio ?? {}) as Partial<SplitConfig["audio"]>;
  const vol = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? clamp(v, 0, 2) : d);
  return {
    version: 1,
    ratio: SPLIT_RATIOS.includes(r.ratio as SplitRatio) ? (r.ratio as SplitRatio) : "50/50",
    main: r.main === "bottom" ? "bottom" : "top",
    top: clip(r.top),
    bottom: clip(r.bottom),
    audio: {
      mode: (["top", "bottom", "mix", "mute"] as const).includes(a.mode as AudioMode) ? (a.mode as AudioMode) : "top",
      topVolume: vol(a.topVolume, 1),
      bottomVolume: vol(a.bottomVolume, 0.35),
    },
    duration: (["main", "loop_other", "shortest"] as const).includes(r.duration as DurationMode) ? (r.duration as DurationMode) : "main",
  };
}

/**
 * Mistura de dois blocos PCM planares (float32, mesmo sampleRate), com ganho por fonte e
 * limitador simples (evita estouro acima de 0 dBFS). `b` pode ser mais curto/nulo (silêncio).
 */
export function mixPcm(a: Float32Array | null, b: Float32Array | null, gainA: number, gainB: number, length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const v = (a && i < a.length ? a[i]! * gainA : 0) + (b && i < b.length ? b[i]! * gainB : 0);
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return out;
}
