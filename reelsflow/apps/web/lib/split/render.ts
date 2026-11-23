"use client";
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  canEncodeAudio,
  type InputAudioTrack,
} from "mediabunny";
import {
  BT709_LIMITED,
  SPLIT_OUTPUT,
  clipLength,
  coverCrop,
  mixPcm,
  outputDuration,
  rgbaToI420Limited,
  sourceTime,
  splitRects,
  validateSplit,
  type SplitConfig,
  type SplitSlot,
} from "@reelsflow/domain";

/**
 * Renderização do ARQUIVO FINAL da Tela Dividida, no navegador (WebCodecs + mediabunny), com as
 * MESMAS funções de layout da prévia (`splitRects`, `coverCrop`, `sourceTime`).
 *  - vídeo: H.264 1080×1920, 30 fps constantes (origens com fps diferentes são amostradas por tempo),
 *    I420 faixa limitada BT.709 (igual ao Card Editorial), faststart;
 *  - áudio: um só vídeo em 100% e AAC → pacotes COPIADOS (sem recodificar, funciona em qualquer navegador);
 *    mistura/volume → PCM mixado e codificado em AAC 48 kHz estéreo (exige codificador AAC no navegador).
 * Os arquivos de origem nunca são alterados.
 */
export class SplitRenderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SplitRenderError";
  }
}

export type SplitSourceInfo = { durationS: number; hasAudio: boolean; width: number; height: number; audioCodec: string | null; videoCodec: string | null };

/** Lê e valida um vídeo de origem (tipo real, decodificável neste navegador, duração). */
export async function probeSplitSource(blob: Blob): Promise<SplitSourceInfo> {
  if (blob.size === 0) throw new SplitRenderError("empty", "O arquivo está vazio.");
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const v = await input.getPrimaryVideoTrack().catch(() => null);
  if (!v) throw new SplitRenderError("no_video", "O arquivo não tem uma faixa de vídeo legível (corrompido ou formato não suportado).");
  if (!(await v.canDecode())) throw new SplitRenderError("video_codec", `Este navegador não decodifica esse vídeo (${v.codec ?? "codec desconhecido"}). Converta para MP4 H.264.`);
  const a = await input.getPrimaryAudioTrack().catch(() => null);
  const durationS = await input.computeDuration();
  if (!(durationS > 0)) throw new SplitRenderError("duration", "Não foi possível ler a duração do vídeo.");
  return { durationS, hasAudio: Boolean(a), width: v.displayWidth, height: v.displayHeight, audioCodec: a?.codec ?? null, videoCodec: v.codec ?? null };
}

export type SplitRenderResult = { blob: Blob; thumbnail: Blob | null; durationS: number; hasAudio: boolean; audioPath: "copy" | "mixed" | "none" };

const RATE = 48_000;

let aacFallback: Promise<void> | null = null;
/**
 * Garante um codificador AAC: o do navegador quando existe; senão, carrega (uma vez, sob demanda)
 * a extensão oficial do mediabunny em WASM (`@mediabunny/aac-encoder`, libavcodec, MPL-2.0).
 * Necessário só para misturar áudios ou mudar o volume; a cópia de áudio não precisa.
 */
export async function canMixAudio(): Promise<boolean> {
  const ok = () => canEncodeAudio("aac", { numberOfChannels: 2, sampleRate: 48_000 });
  if (await ok()) return true;
  aacFallback ??= import("@mediabunny/aac-encoder").then((m) => m.registerAacEncoder()).catch(() => undefined);
  await aacFallback;
  return ok();
}

/** Leitor de PCM em fluxo: entrega blocos estéreo a 48 kHz do trecho (com repetição opcional). */
class PcmReader {
  private iter: AsyncGenerator<AudioSample, void, unknown> | null = null;
  private buf: [Float32Array, Float32Array] = [new Float32Array(0), new Float32Array(0)];
  private pos = 0; // posição fracionária no buffer de origem (resampler linear)
  private srcRate = RATE;
  private done = false;

  constructor(
    private track: InputAudioTrack,
    private start: number,
    private end: number,
    private loop: boolean,
  ) {}

  private open() {
    this.iter = new AudioSampleSink(this.track).samples(this.start, this.end);
  }

  private async pull(): Promise<boolean> {
    if (!this.iter) this.open();
    let r = await this.iter!.next();
    if (r.done && this.loop && this.end - this.start > 0.05) {
      this.open();
      r = await this.iter!.next();
    }
    if (r.done) return false;
    const s = r.value;
    try {
      this.srcRate = s.sampleRate;
      const n = s.numberOfFrames;
      const ch = (i: number) => {
        const out = new Float32Array(n);
        s.copyTo(out, { planeIndex: Math.min(i, s.numberOfChannels - 1), format: "f32-planar" });
        return out;
      };
      const l = ch(0);
      const rr = s.numberOfChannels > 1 ? ch(1) : l;
      // Corta o que ficar antes do início do trecho (o primeiro bloco pode começar um pouco antes).
      const skip = s.timestamp < this.start ? Math.min(n, Math.round((this.start - s.timestamp) * s.sampleRate)) : 0;
      const keep = (a: Float32Array, b: Float32Array) => {
        const tail = b.subarray(skip);
        const out = new Float32Array(a.length + tail.length);
        out.set(a);
        out.set(tail, a.length);
        return out;
      };
      const base = Math.floor(this.pos);
      this.buf = [keep(this.buf[0].subarray(base), l), keep(this.buf[1].subarray(base), rr)];
      this.pos -= base;
    } finally {
      s.close();
    }
    return true;
  }

  /** `frames` quadros a 48 kHz; completa com silêncio quando o trecho acaba. */
  async read(frames: number): Promise<[Float32Array, Float32Array]> {
    const out: [Float32Array, Float32Array] = [new Float32Array(frames), new Float32Array(frames)];
    for (let i = 0; i < frames; i++) {
      const step = this.srcRate / RATE;
      while (!this.done && this.pos + 1 >= this.buf[0].length) {
        if (!(await this.pull())) this.done = true;
      }
      if (this.pos + 1 >= this.buf[0].length) break; // fim: resto é silêncio
      const k = Math.floor(this.pos);
      const f = this.pos - k;
      out[0][i] = this.buf[0][k]! * (1 - f) + this.buf[0][k + 1]! * f;
      out[1][i] = this.buf[1][k]! * (1 - f) + this.buf[1][k + 1]! * f;
      this.pos += step;
    }
    return out;
  }
}

export async function renderSplitVideo(
  cfg: SplitConfig,
  blobs: Record<SplitSlot, Blob>,
  opts: { onProgress?: (p: number) => void; signal?: AbortSignal } = {},
): Promise<SplitRenderResult> {
  if (typeof VideoEncoder === "undefined") {
    throw new SplitRenderError("no_webcodecs", "Este navegador não consegue gerar vídeo. Use o Chrome, Edge ou Safari atualizados no computador.");
  }
  const { width: W, height: H, fps } = SPLIT_OUTPUT;
  const inputs = {
    top: new Input({ source: new BlobSource(blobs.top), formats: ALL_FORMATS }),
    bottom: new Input({ source: new BlobSource(blobs.bottom), formats: ALL_FORMATS }),
  };
  const info = { top: await probeSplitSource(blobs.top), bottom: await probeSplitSource(blobs.bottom) };
  const blocking = validateSplit(cfg, info).filter((i) => i.blocking);
  if (blocking.length) throw new SplitRenderError("blocked", blocking.map((b) => b.message).join(" "));

  const total = outputDuration(cfg, { top: info.top.durationS, bottom: info.bottom.durationS });
  const frames = Math.max(1, Math.round(total * fps));
  const rects = splitRects(cfg.ratio);
  const vTracks = { top: (await inputs.top.getPrimaryVideoTrack())!, bottom: (await inputs.bottom.getPrimaryVideoTrack())! };
  const crops = {
    top: coverCrop({ width: info.top.width, height: info.top.height }, rects.top, cfg.top),
    bottom: coverCrop({ width: info.bottom.width, height: info.bottom.height }, rects.bottom, cfg.bottom),
  };

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const video = new VideoSampleSource({ codec: "avc", bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(video, { frameRate: fps });

  // ---------- plano de áudio
  const mode = cfg.audio.mode;
  type Plan = { kind: "none" } | { kind: "copy"; slot: SplitSlot; track: InputAudioTrack } | { kind: "mix"; tracks: Partial<Record<SplitSlot, InputAudioTrack>> };
  let plan: Plan = { kind: "none" };
  const aTrack = async (s: SplitSlot) => (info[s].hasAudio ? await inputs[s].getPrimaryAudioTrack() : null);
  if (mode === "top" || mode === "bottom") {
    const t = await aTrack(mode);
    const vol = mode === "top" ? cfg.audio.topVolume : cfg.audio.bottomVolume;
    if (t && t.codec === "aac" && Math.abs(vol - 1) < 1e-6) plan = { kind: "copy", slot: mode, track: t };
    else if (t) plan = { kind: "mix", tracks: { [mode]: t } };
  } else if (mode === "mix") {
    const tracks: Partial<Record<SplitSlot, InputAudioTrack>> = {};
    for (const s of ["top", "bottom"] as const) {
      const t = await aTrack(s);
      if (t) tracks[s] = t;
    }
    if (Object.keys(tracks).length) plan = { kind: "mix", tracks };
  }
  if (plan.kind === "mix" && !(await canMixAudio())) {
    throw new SplitRenderError(
      "no_aac_encoder",
      "Este navegador não gera áudio AAC, necessário para misturar ou ajustar o volume. Use o áudio de um só vídeo em 100% ou outro navegador (Chrome/Edge no Windows ou macOS, Safari).",
    );
  }
  let copySource: EncodedAudioPacketSource | null = null;
  let mixSource: AudioSampleSource | null = null;
  if (plan.kind === "copy") {
    copySource = new EncodedAudioPacketSource("aac");
    output.addAudioTrack(copySource);
  } else if (plan.kind === "mix") {
    mixSource = new AudioSampleSource({ codec: "aac", bitrate: 160_000 });
    output.addAudioTrack(mixSource);
  }

  await output.start();
  const abort = () => void output.cancel();
  opts.signal?.addEventListener("abort", abort, { once: true });

  try {
    // ---------- áudio copiado (antes do vídeo: pacotes já codificados, é rápido)
    if (plan.kind === "copy" && copySource) {
      const slot = plan.slot;
      const clip = cfg[slot];
      const dur = info[slot].durationS;
      const len = clipLength(clip, dur);
      const loop = cfg.duration === "loop_other" && slot !== cfg.main;
      const sink = new EncodedPacketSink(plan.track);
      const decoderConfig = await plan.track.getDecoderConfig();
      let first = true;
      let offset = 0; // início desta repetição no tempo final
      while (offset < total - 1e-3) {
        const startPkt = await sink.getPacket(clip.startS);
        let pkt = startPkt ?? (await sink.getFirstPacket());
        while (pkt) {
          const local = pkt.timestamp - clip.startS;
          if (local >= len) break;
          const at = offset + Math.max(0, local);
          if (at >= total) break;
          if (local + pkt.duration > 0) {
            await copySource.add(pkt.clone({ timestamp: at }), first && decoderConfig ? { decoderConfig } : undefined);
            first = false;
          }
          pkt = await sink.getNextPacket(pkt);
        }
        if (!loop || len <= 0.05) break;
        offset += len;
      }
      copySource.close();
    }

    // ---------- vídeo (+ áudio mixado em blocos de 1 s, intercalado para não acumular memória)
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const yuv = new Uint8Array(W * H * 1.5);
    const stamps = (slot: SplitSlot) =>
      (function* () {
        for (let i = 0; i < frames; i++) yield sourceTime(cfg, slot, i / fps, info[slot].durationS);
      })();
    const iters = {
      top: new VideoSampleSink(vTracks.top).samplesAtTimestamps(stamps("top")),
      bottom: new VideoSampleSink(vTracks.bottom).samplesAtTimestamps(stamps("bottom")),
    };
    const readers: Partial<Record<SplitSlot, PcmReader>> = {};
    if (plan.kind === "mix") {
      for (const s of ["top", "bottom"] as const) {
        const t = plan.tracks[s];
        if (!t) continue;
        const clip = cfg[s];
        const end = clip.startS + clipLength(clip, info[s].durationS);
        readers[s] = new PcmReader(t, clip.startS, end, cfg.duration === "loop_other" && s !== cfg.main);
      }
    }
    const gain = { top: plan.kind === "mix" && mode !== "bottom" ? cfg.audio.topVolume : 0, bottom: plan.kind === "mix" && mode !== "top" ? cfg.audio.bottomVolume : 0 };
    let audioDone = 0; // quadros de áudio já entregues
    const totalAudio = Math.round(total * RATE);
    let thumbnail: Blob | null = null;
    const thumbAt = Math.min(frames - 1, fps);

    for (let i = 0; i < frames; i++) {
      if (opts.signal?.aborted) throw new SplitRenderError("canceled", "Renderização cancelada.");
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      for (const s of ["top", "bottom"] as const) {
        const r = await iters[s].next();
        const sample = r.done ? null : r.value;
        if (sample) {
          const c = crops[s];
          const d = rects[s];
          sample.draw(ctx, c.x, c.y, c.w, c.h, d.x, d.y, d.w, d.h);
          sample.close();
        }
      }
      if (i === thumbAt) thumbnail = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), "image/jpeg", 0.85));
      const rgba = ctx.getImageData(0, 0, W, H).data;
      const frame = new VideoSample(rgbaToI420Limited(rgba, W, H, yuv), {
        format: "I420",
        codedWidth: W,
        codedHeight: H,
        timestamp: i / fps,
        duration: 1 / fps,
        colorSpace: BT709_LIMITED,
      });
      await video.add(frame, i % (fps * 2) === 0 ? { keyFrame: true } : undefined);
      frame.close();

      // áudio mixado até o tempo do quadro atual (+1 s de folga)
      if (mixSource) {
        const target = Math.min(totalAudio, Math.round(((i + 1) / fps + 1) * RATE));
        while (audioDone < target) {
          const n = Math.min(RATE / 2, target - audioDone);
          const a = readers.top ? await readers.top.read(n) : null;
          const b = readers.bottom ? await readers.bottom.read(n) : null;
          const l = mixPcm(a?.[0] ?? null, b?.[0] ?? null, gain.top, gain.bottom, n);
          const rr = mixPcm(a?.[1] ?? null, b?.[1] ?? null, gain.top, gain.bottom, n);
          const data = new Float32Array(n * 2);
          data.set(l, 0);
          data.set(rr, n);
          const sample = new AudioSample({ data, format: "f32-planar", numberOfChannels: 2, sampleRate: RATE, timestamp: audioDone / RATE });
          await mixSource.add(sample);
          sample.close();
          audioDone += n;
        }
      }
      opts.onProgress?.((i + 1) / frames);
    }
    video.close();
    mixSource?.close();
    await output.finalize();
    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer || buffer.byteLength === 0) throw new SplitRenderError("empty_output", "O vídeo gerado ficou vazio.");
    return {
      blob: new Blob([buffer], { type: "video/mp4" }),
      thumbnail,
      durationS: frames / fps,
      hasAudio: plan.kind !== "none",
      audioPath: plan.kind === "copy" ? "copy" : plan.kind === "mix" ? "mixed" : "none",
    };
  } catch (e) {
    if (e instanceof SplitRenderError) throw e;
    if (opts.signal?.aborted) throw new SplitRenderError("canceled", "Renderização cancelada.");
    throw new SplitRenderError("encode_failed", `Falha ao gerar o vídeo: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    opts.signal?.removeEventListener("abort", abort);
  }
}
