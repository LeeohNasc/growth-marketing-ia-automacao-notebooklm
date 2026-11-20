import { ProbeError, type MediaProbe } from "@reelsflow/domain";

/**
 * Leitor mínimo de MP4/MOV (ISO BMFF) para extrair metadados sem ffmpeg.
 * Lê só os cabeçalhos das caixas de topo e a caixa `moov` (índice), via
 * leituras por faixa — funciona com o índice no início (faststart) ou no fim.
 * Usado no worker que roda como Edge Function (sem binários nativos).
 */
export interface ByteReader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

const MAX_MOOV_BYTES = 32 * 1024 * 1024;

const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);

type Box = { type: string; start: number; headerSize: number; size: number };

/** Itera as caixas filhas de `buf[from..to)`. */
function* boxes(view: DataView, buf: Uint8Array, from: number, to: number): Generator<Box> {
  let off = from;
  while (off + 8 <= to) {
    let size = view.getUint32(off);
    const type = fourcc(buf, off + 4);
    let header = 8;
    if (size === 1) {
      if (off + 16 > to) return;
      size = Number(view.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) {
      size = to - off;
    }
    if (size < header || off + size > to) return;
    yield { type, start: off, headerSize: header, size };
    off += size;
  }
}

const CODECS: Record<string, string> = {
  avc1: "h264",
  avc3: "h264",
  hvc1: "hevc",
  hev1: "hevc",
  av01: "av1",
  vp09: "vp9",
  vp08: "vp8",
  mp4v: "mpeg4",
  mp4a: "aac",
  ".mp3": "mp3",
  Opus: "opus",
  "ac-3": "ac3",
  "ec-3": "eac3",
  alac: "alac",
  lpcm: "pcm",
  sowt: "pcm",
  twos: "pcm",
};

type Track = { handler: string; codec: string | null; width: number; height: number; rotation: number; timescale: number; duration: number; samples: number; sampleDuration: number };

function parseTrak(view: DataView, buf: Uint8Array, box: Box): Track {
  const t: Track = { handler: "", codec: null, width: 0, height: 0, rotation: 0, timescale: 0, duration: 0, samples: 0, sampleDuration: 0 };
  const walk = (b: Box) => {
    const body = b.start + b.headerSize;
    const end = b.start + b.size;
    switch (b.type) {
      case "mdia":
      case "minf":
      case "stbl":
        for (const c of boxes(view, buf, body, end)) walk(c);
        break;
      case "tkhd": {
        const v = buf[body]!;
        const m = body + 4 + (v === 1 ? 32 : 20) + 8 + 2 + 2 + 2 + 2; // após version/flags, tempos, reserved, layer, alt group, volume, reserved
        const a = view.getInt32(m) / 65536;
        const bb = view.getInt32(m + 4) / 65536;
        t.rotation = ((Math.round((Math.atan2(bb, a) * 180) / Math.PI) % 360) + 360) % 360;
        t.width = view.getUint32(m + 36) / 65536;
        t.height = view.getUint32(m + 40) / 65536;
        break;
      }
      case "mdhd": {
        const v = buf[body]!;
        if (v === 1) {
          t.timescale = view.getUint32(body + 20);
          t.duration = Number(view.getBigUint64(body + 24));
        } else {
          t.timescale = view.getUint32(body + 12);
          t.duration = view.getUint32(body + 16);
        }
        break;
      }
      case "hdlr":
        // MOV tem um segundo hdlr em `minf` (tipo de dados: "alis"/"url "); vale o de `mdia`, que vem antes.
        if (!t.handler) t.handler = fourcc(buf, body + 8);
        break;
      case "stsd": {
        const first = boxes(view, buf, body + 8, end).next();
        if (!first.done) t.codec = CODECS[first.value.type] ?? first.value.type.trim().toLowerCase();
        break;
      }
      case "stts": {
        const n = view.getUint32(body + 4);
        let samples = 0;
        let dur = 0;
        for (let i = 0; i < n && body + 8 + i * 8 + 8 <= end; i++) {
          const count = view.getUint32(body + 8 + i * 8);
          const delta = view.getUint32(body + 12 + i * 8);
          samples += count;
          dur += count * delta;
        }
        t.samples = samples;
        t.sampleDuration = dur;
        break;
      }
    }
  };
  for (const c of boxes(view, buf, box.start + box.headerSize, box.start + box.size)) walk(c);
  return t;
}

/** Localiza a caixa `moov` lendo apenas os cabeçalhos das caixas de topo. */
async function readMoov(reader: ByteReader): Promise<Uint8Array> {
  let off = 0;
  for (let guard = 0; off + 8 <= reader.size && guard < 1000; guard++) {
    const head = await reader.read(off, Math.min(16, reader.size - off));
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size = view.getUint32(0);
    const type = fourcc(head, 4);
    if (size === 1 && head.byteLength >= 16) size = Number(view.getBigUint64(8));
    else if (size === 0) size = reader.size - off;
    if (size < 8) break;
    if (type === "moov") {
      if (size > MAX_MOOV_BYTES) throw new ProbeError("invalid_output");
      return reader.read(off, size);
    }
    off += size;
  }
  throw new ProbeError("invalid_output");
}

export async function probeMp4(reader: ByteReader): Promise<MediaProbe> {
  if (reader.size < 16) throw new ProbeError("invalid_output");
  const first = await reader.read(0, 12);
  const brand = fourcc(first, 4);
  if (!["ftyp", "moov", "mdat", "free", "wide", "skip", "pnot"].includes(brand)) throw new ProbeError("invalid_output");

  const moov = await readMoov(reader);
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  let movieDuration = 0;
  const tracks: Track[] = [];
  for (const b of boxes(view, moov, 8, moov.byteLength)) {
    if (b.type === "mvhd") {
      const body = b.start + b.headerSize;
      const v = moov[body]!;
      const ts = view.getUint32(body + (v === 1 ? 20 : 12));
      const d = v === 1 ? Number(view.getBigUint64(body + 24)) : view.getUint32(body + 16);
      movieDuration = ts ? d / ts : 0;
    } else if (b.type === "trak") {
      tracks.push(parseTrak(view, moov, b));
    }
  }

  const video = tracks.find((t) => t.handler === "vide" && t.width > 0 && t.height > 0);
  if (!video) throw new ProbeError("no_video_stream");
  const audio = tracks.find((t) => t.handler === "soun");
  const swap = video.rotation === 90 || video.rotation === 270;
  const durationS = movieDuration || (video.timescale ? video.duration / video.timescale : 0);
  const fps = video.sampleDuration && video.timescale ? Math.round((video.samples / (video.sampleDuration / video.timescale)) * 1000) / 1000 : null;
  const w = Math.round(video.width);
  const h = Math.round(video.height);
  if (w <= 0 || h <= 0) throw new ProbeError("invalid_dimensions");

  return {
    durationMs: Math.round(durationS * 1000),
    width: swap ? h : w,
    height: swap ? w : h,
    rotation: video.rotation,
    fps,
    videoCodec: video.codec ?? "unknown",
    audioCodec: audio?.codec ?? null,
    hasAudio: Boolean(audio),
    bitrate: durationS > 0 ? Math.round((reader.size * 8) / durationS) : null,
    // Mesma forma do ffprobe: a extensão original desambigua MP4 × MOV na compatibilidade.
    container: "mov,mp4,m4a,3gp,3g2,mj2",
  };
}

/** Leitor por faixas HTTP (Range) — para URLs assinadas do storage. */
export async function httpRangeReader(url: string, fetchImpl: typeof fetch = fetch): Promise<ByteReader> {
  const head = await fetchImpl(url, { headers: { Range: "bytes=0-0" } });
  const range = head.headers.get("content-range");
  const size = range ? Number(range.split("/")[1]) : Number(head.headers.get("content-length"));
  await head.body?.cancel();
  if (!Number.isFinite(size) || size <= 0) throw new Error("tamanho do arquivo indisponível");
  return {
    size,
    async read(offset, length) {
      const res = await fetchImpl(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
      if (res.status !== 206 && res.status !== 200) throw new Error(`leitura por faixa falhou: HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      // Servidor que ignora Range devolve o arquivo todo (200): recorta.
      return res.status === 200 ? buf.subarray(offset, offset + length) : buf;
    },
  };
}

/** Leitor sobre um buffer em memória (testes). */
export function bufferReader(buf: Uint8Array): ByteReader {
  return { size: buf.byteLength, read: async (o, l) => buf.subarray(o, o + l) };
}
