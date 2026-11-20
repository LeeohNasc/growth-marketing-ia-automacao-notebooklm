/**
 * Regras de mídia compartilhadas por web (validação antes do envio) e worker
 * (interpretação do ffprobe e compatibilidade por plataforma).
 */

/** MP4/MOV: os formatos aceitos pelo Instagram e pelo Facebook (e lidos pela análise no servidor). */
export const ACCEPTED_VIDEO_TYPES = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
} as const;

export type AcceptedMime = keyof typeof ACCEPTED_VIDEO_TYPES;

const EXT_TO_MIME: Record<string, AcceptedMime> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime" };

/** Limite padrão por arquivo: 50 MB (limite por arquivo do plano Free do Supabase). */
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Supabase exige chunks TUS de exatamente 6 MB. */
export const TUS_CHUNK_SIZE = 6 * 1024 * 1024;

export type FileCheck = { ok: true; mime: AcceptedMime } | { ok: false; reason: string };

/**
 * Validação prévia no navegador. Não substitui o ffprobe: um arquivo com
 * extensão correta pode não ser um vídeo válido (o worker detecta).
 */
export function checkUploadFile(file: { name: string; size: number; type: string }, maxBytes = DEFAULT_MAX_UPLOAD_BYTES): FileCheck {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mime = (file.type in ACCEPTED_VIDEO_TYPES ? file.type : EXT_TO_MIME[ext]) as AcceptedMime | undefined;
  if (!mime) return { ok: false, reason: "Formato não suportado. Use MP4 ou MOV." };
  if (file.size <= 0) return { ok: false, reason: "Arquivo vazio." };
  if (file.size > maxBytes) return { ok: false, reason: `Arquivo maior que o limite de ${formatBytes(maxBytes)}.` };
  if (file.name.length > 255) return { ok: false, reason: "Nome de arquivo muito longo." };
  return { ok: true, mime };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`.replace(".", ",");
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ---------------------------------------------------------------------------
// ffprobe
// ---------------------------------------------------------------------------

export type MediaProbe = {
  durationMs: number;
  /** Dimensões de exibição (já consideram rotação). */
  width: number;
  height: number;
  rotation: number;
  fps: number | null;
  videoCodec: string;
  audioCodec: string | null;
  hasAudio: boolean;
  bitrate: number | null;
  container: string;
};

export class ProbeError extends Error {
  constructor(public readonly code: "no_video_stream" | "invalid_output" | "invalid_dimensions") {
    super(code);
    this.name = "ProbeError";
  }
}

type FfStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number | string }[];
  disposition?: { attached_pic?: number };
};

type FfOutput = { streams?: FfStream[]; format?: { format_name?: string; duration?: string; bit_rate?: string } };

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split("/").map(Number);
  if (!n || !Number.isFinite(n)) return null;
  const v = d ? n / d : n;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : null;
}

/** Interpreta `ffprobe -print_format json -show_format -show_streams`. */
export function parseFfprobe(raw: unknown): MediaProbe {
  if (!raw || typeof raw !== "object") throw new ProbeError("invalid_output");
  const out = raw as FfOutput;
  const streams = out.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  if (!video) throw new ProbeError("no_video_stream");
  const audio = streams.find((s) => s.codec_type === "audio");

  const rawRotation = video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0;
  const rotation = ((Math.round(Number(rawRotation) || 0) % 360) + 360) % 360;
  const w = video.width ?? 0;
  const h = video.height ?? 0;
  if (w <= 0 || h <= 0) throw new ProbeError("invalid_dimensions");
  const swap = rotation === 90 || rotation === 270;

  const duration = Number(out.format?.duration ?? video.duration ?? 0);
  const bitrate = Number(out.format?.bit_rate);

  return {
    durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : 0,
    width: swap ? h : w,
    height: swap ? w : h,
    rotation,
    fps: parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate),
    videoCodec: (video.codec_name ?? "unknown").toLowerCase(),
    audioCodec: audio?.codec_name?.toLowerCase() ?? null,
    hasAudio: Boolean(audio),
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : null,
    container: out.format?.format_name ?? "unknown",
  };
}

// ---------------------------------------------------------------------------
// Compatibilidade por plataforma
// ---------------------------------------------------------------------------

export const PLATFORMS = ["instagram_reels", "facebook_reels", "tiktok", "youtube_shorts"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram_reels: "Instagram Reels",
  facebook_reels: "Facebook Reels",
  tiktok: "TikTok",
  youtube_shorts: "YouTube Shorts",
};

/**
 * Regras de compatibilidade.
 * - Instagram Reels e Facebook Reels: valores CONFIRMADOS na documentação
 *   oficial da Meta (Graph API v27.0, consultada em 2026-11-19) → violações
 *   são ERRO (a plataforma rejeitaria).
 * - TikTok e YouTube Shorts: PRELIMINARES (não confirmados) → apenas AVISO,
 *   exceto contêiner/codec.
 */
export const COMPATIBILITY_RULES_VERSION = "2026-11-19-meta-v27";

type Spec = {
  verified: boolean;
  containers: string[];
  videoCodecs: string[];
  audioCodecs: string[];
  minDurationS?: number;
  maxDurationS?: number;
  maxSizeBytes?: number;
  minFps?: number;
  maxFps?: number;
  maxWidth?: number;
  minShortSide?: number;
  minLongSide?: number;
  durationNote?: string;
  verticalRecommended: boolean;
};

const MB_ = 1024 * 1024;

const SPECS: Record<Platform, Spec> = {
  // ig-user/media "Reel Specifications": MOV/MP4, HEVC/H264, AAC, 23–60 fps, largura máx. 1920, 3 s–15 min, 300 MB.
  instagram_reels: {
    verified: true,
    containers: ["mp4", "mov"],
    videoCodecs: ["h264", "hevc"],
    audioCodecs: ["aac"],
    minDurationS: 3,
    maxDurationS: 900,
    maxSizeBytes: 300 * MB_,
    minFps: 23,
    maxFps: 60,
    maxWidth: 1920,
    verticalRecommended: true,
  },
  // Reels Publishing API: .mp4 recomendado, H.264/H.265/VP9/AV1, AAC, 24–60 fps, 3–90 s, mín. 540×960.
  facebook_reels: {
    verified: true,
    containers: ["mp4", "mov"],
    videoCodecs: ["h264", "hevc", "vp9", "av1"],
    audioCodecs: ["aac"],
    minDurationS: 3,
    maxDurationS: 90,
    minFps: 24,
    maxFps: 60,
    minShortSide: 540,
    minLongSide: 960,
    verticalRecommended: true,
  },
  tiktok: {
    verified: false,
    containers: ["mp4", "mov", "webm"],
    videoCodecs: ["h264", "hevc", "vp8", "vp9"],
    audioCodecs: ["aac", "mp3", "opus", "vorbis"],
    durationNote: "A duração máxima depende da conta e é verificada no momento da publicação.",
    verticalRecommended: true,
  },
  youtube_shorts: {
    verified: false,
    containers: ["mp4", "mov", "webm"],
    videoCodecs: ["h264", "hevc", "vp8", "vp9", "av1"],
    audioCodecs: ["aac", "mp3", "opus", "vorbis"],
    maxDurationS: 180,
    durationNote: "Acima do limite, o YouTube pode tratar como vídeo comum, não como Short.",
    verticalRecommended: true,
  },
};

export type CompatIssue = { level: "error" | "warning"; code: string; message: string };
export type PlatformCompat = { status: "ok" | "warning" | "error"; verified?: boolean; issues: CompatIssue[] };
export type Compatibility = { rulesVersion: string; platforms: Record<Platform, PlatformCompat> };

/** ffprobe reporta "mov,mp4,m4a,3gp,3g2,mj2" para MP4/MOV; usa-se a extensão original para desambiguar. */
function containerOf(probe: MediaProbe, ext: string): string {
  if (probe.container.includes("webm") || probe.container.includes("matroska")) return "webm";
  if (probe.container.includes("mov") || probe.container.includes("mp4")) return ext === "mov" ? "mov" : "mp4";
  return probe.container;
}

export function evaluateCompatibility(probe: MediaProbe, originalExt: string, sizeBytes?: number): Compatibility {
  const container = containerOf(probe, originalExt.toLowerCase());
  const platforms = {} as Record<Platform, PlatformCompat>;
  for (const p of PLATFORMS) {
    const spec = SPECS[p];
    const hard: CompatIssue["level"] = spec.verified ? "error" : "warning";
    const suffix = spec.verified ? "" : " (limite preliminar)";
    const issues: CompatIssue[] = [];
    if (!spec.containers.includes(container)) {
      issues.push({ level: "error", code: "container", message: `Formato ${container.toUpperCase()} não aceito.` });
    }
    if (!spec.videoCodecs.includes(probe.videoCodec)) {
      issues.push({ level: "error", code: "video_codec", message: `Codec de vídeo ${probe.videoCodec.toUpperCase()} não aceito.` });
    }
    if (probe.audioCodec && !spec.audioCodecs.includes(probe.audioCodec)) {
      issues.push({ level: hard, code: "audio_codec", message: `Codec de áudio ${probe.audioCodec.toUpperCase()} não aceito (use AAC).` });
    }
    const secs = probe.durationMs / 1000;
    if (spec.minDurationS && secs < spec.minDurationS) {
      issues.push({ level: hard, code: "too_short", message: `Duração abaixo de ${spec.minDurationS}s${suffix}.` });
    }
    if (spec.maxDurationS && secs > spec.maxDurationS) {
      issues.push({ level: hard, code: "too_long", message: spec.durationNote ?? `Duração acima de ${formatDuration(spec.maxDurationS * 1000)}${suffix}.` });
    }
    if (spec.maxSizeBytes && sizeBytes && sizeBytes > spec.maxSizeBytes) {
      issues.push({ level: hard, code: "too_large", message: `Arquivo acima de ${formatBytes(spec.maxSizeBytes)}.` });
    }
    if (probe.fps != null && ((spec.minFps && probe.fps < spec.minFps - 0.01) || (spec.maxFps && probe.fps > spec.maxFps + 0.01))) {
      issues.push({ level: hard, code: "fps", message: `Taxa de quadros ${probe.fps} fora de ${spec.minFps}–${spec.maxFps} fps.` });
    }
    if (spec.maxWidth && probe.width > spec.maxWidth) {
      issues.push({ level: hard, code: "too_wide", message: `Largura acima de ${spec.maxWidth} px.` });
    }
    if (spec.minShortSide && spec.minLongSide) {
      const short = Math.min(probe.width, probe.height);
      const long = Math.max(probe.width, probe.height);
      if (short < spec.minShortSide || long < spec.minLongSide) {
        issues.push({ level: hard, code: "resolution", message: `Resolução abaixo de ${spec.minShortSide}×${spec.minLongSide}.` });
      }
    }
    if (spec.verticalRecommended && probe.width >= probe.height) {
      issues.push({ level: "warning", code: "not_vertical", message: "Vídeo não vertical; o formato recomendado é 9:16." });
    }
    const status = issues.some((i) => i.level === "error") ? "error" : issues.length ? "warning" : "ok";
    platforms[p] = { status, verified: spec.verified, issues };
  }
  return { rulesVersion: COMPATIBILITY_RULES_VERSION, platforms };
}

export function aspectLabel(width: number | null, height: number | null): string {
  if (!width || !height) return "—";
  const r = width / height;
  const known: [string, number][] = [["9:16", 9 / 16], ["4:5", 4 / 5], ["1:1", 1], ["16:9", 16 / 9], ["4:3", 4 / 3], ["3:4", 3 / 4]];
  const hit = known.find(([, v]) => Math.abs(v - r) < 0.02);
  return hit ? hit[0] : `${width}×${height}`;
}

/** Caminho da thumbnail ao lado do original. */
export function thumbnailPathFor(storagePath: string): string {
  return storagePath.replace(/\/[^/]+$/, "/thumb.jpg");
}

// ---------------------------------------------------------------------------
// Edição de metadados
// ---------------------------------------------------------------------------

/** Normaliza "#a, b  #c" → ["#a", "#b", "#c"] (sem duplicados, máx. 30). */
export function normalizeHashtags(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[\s,;]+/)) {
    const tag = raw.replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (!tag) continue;
    const norm = `#${tag.slice(0, 100)}`;
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
    if (out.length === 30) break;
  }
  return out;
}

export const MEDIA_STATUS_LABELS = {
  uploading: "Enviando",
  uploaded: "Na fila de análise",
  processing: "Analisando",
  ready: "Pronto",
  failed: "Falhou",
} as const;

export const MEDIA_FAILURE_LABELS: Record<string, string> = {
  invalid_video: "O arquivo não é um vídeo válido.",
  processing_error: "Não foi possível analisar o vídeo.",
  size_mismatch: "O arquivo recebido não confere com o original.",
};
