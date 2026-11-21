/**
 * RGBA (canvas, sRGB 0–255) → I420 em faixa LIMITADA (TV, Y 16–235 / C 16–240), matriz BT.709.
 * Os codificadores WebCodecs convertem RGB em faixa CHEIA (yuvj420p, "pc"), que algumas redes e
 * players interpretam mal (cores lavadas/estouradas). Convertendo aqui e marcando o quadro como
 * BT.709 limitado, o MP4 sai como yuv420p "tv" — o formato padrão de vídeo.
 * Largura e altura precisam ser pares (todos os formatos do card são).
 */
export const BT709_LIMITED = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false } as const;

export function rgbaToI420Limited(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, out?: Uint8Array): Uint8Array {
  if (width % 2 || height % 2) throw new Error("dimensões precisam ser pares");
  const ySize = width * height;
  const cSize = ySize / 4;
  const buf = out && out.length === ySize + 2 * cSize ? out : new Uint8Array(ySize + 2 * cSize);
  const uOff = ySize;
  const vOff = ySize + cSize;
  const cw = width / 2;
  for (let cy = 0; cy < height / 2; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let rs = 0, gs = 0, bs = 0;
      for (let dy = 0; dy < 2; dy++) {
        const y = cy * 2 + dy;
        for (let dx = 0; dx < 2; dx++) {
          const x = cx * 2 + dx;
          const i = (y * width + x) * 4;
          const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
          // Y' BT.709 em faixa limitada: 16 + 219·(0,2126R + 0,7152G + 0,0722B)/255
          buf[y * width + x] = (16 + (219 * (0.2126 * r + 0.7152 * g + 0.0722 * b)) / 255 + 0.5) | 0;
          rs += r; gs += g; bs += b;
        }
      }
      const r = rs / 4, g = gs / 4, b = bs / 4;
      const yl = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const ci = cy * cw + cx;
      buf[uOff + ci] = Math.min(240, Math.max(16, (128 + (224 * ((b - yl) / 1.8556)) / 255 + 0.5) | 0));
      buf[vOff + ci] = Math.min(240, Math.max(16, (128 + (224 * ((r - yl) / 1.5748)) / 255 + 0.5) | 0));
    }
  }
  return buf;
}
