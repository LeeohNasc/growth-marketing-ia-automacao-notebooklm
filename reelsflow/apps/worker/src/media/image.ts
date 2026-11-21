import type { ByteReader } from "./mp4";

export type ImageProbe = { format: "jpeg"; width: number; height: number };

export class ImageProbeError extends Error {
  constructor(readonly code: "not_jpeg" | "no_dimensions") {
    super(code);
    this.name = "ImageProbeError";
  }
}

/**
 * Lê só o cabeçalho do JPEG (marcadores até o SOF) para obter largura e altura.
 * Rejeita o que não for JPEG de verdade (MIME real, não a extensão).
 */
export async function probeJpeg(reader: ByteReader): Promise<ImageProbe> {
  const head = await reader.read(0, Math.min(reader.size, 2));
  if (head.length < 2 || head[0] !== 0xff || head[1] !== 0xd8) throw new ImageProbeError("not_jpeg");
  let pos = 2;
  const limit = Math.min(reader.size, 4 * 1024 * 1024); // cabeçalhos ficam no começo; não varre o arquivo
  while (pos + 4 <= limit) {
    const m = await reader.read(pos, 4);
    if (m[0] !== 0xff) throw new ImageProbeError("no_dimensions");
    const marker = m[1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      pos += marker === 0xff ? 1 : 2;
      continue;
    }
    const len = (m[2]! << 8) | m[3]!;
    // SOF0..SOF15, exceto DHT (C4), JPG (C8) e DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const sof = await reader.read(pos + 4, 5);
      const height = (sof[1]! << 8) | sof[2]!;
      const width = (sof[3]! << 8) | sof[4]!;
      if (!width || !height) throw new ImageProbeError("no_dimensions");
      return { format: "jpeg", width, height };
    }
    if (marker === 0xda || marker === 0xd9 || len < 2) break; // início dos dados/fim sem SOF
    pos += 2 + len;
  }
  throw new ImageProbeError("no_dimensions");
}
