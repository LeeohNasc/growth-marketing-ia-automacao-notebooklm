/**
 * Harness de renderização (somente testes): roda o renderizador REAL do Card Editorial
 * (lib/editorial) no navegador e expõe funções para o Playwright gerar e inspecionar arquivos.
 */
import type { CardContent, CardStyle, FocalPoint } from "@reelsflow/domain";
import { layoutFor } from "../lib/editorial/draw";
import { loadImageDrawable, renderCardImage, renderCardVideo, CardRenderError, type CardRenderInput } from "../lib/editorial/export";
import { ensureCardFonts } from "../lib/editorial/fonts";
import { renderPreview } from "../lib/editorial/preview";
import { normalizeSplit } from "@reelsflow/domain";
import { SplitRenderError, canMixAudio, probeSplitSource, renderSplitVideo } from "../lib/split/render";

type Cfg = { content: CardContent; style?: Partial<CardStyle>; focal?: FocalPoint[]; avatar?: string | null; media?: (string | null)[]; logo?: string | null };
type Rect = { x: number; y: number; w: number; h: number };

const fetchBlob = async (url: string) => (await fetch(url)).blob();
async function toInput(cfg: Cfg): Promise<CardRenderInput> {
  return {
    content: cfg.content,
    style: cfg.style ?? {},
    focal: cfg.focal ?? [],
    avatar: cfg.avatar ? await loadImageDrawable(await fetchBlob(cfg.avatar)) : null,
    media: await Promise.all((cfg.media ?? []).map(async (m) => (m ? loadImageDrawable(await fetchBlob(m)) : null))),
    logo: cfg.logo ? await loadImageDrawable(await fetchBlob(cfg.logo)) : null,
  };
}
const b64 = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (data: string, type: string) => new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type });
async function pixels(data: string, type: string) {
  const bmp = await createImageBitmap(fromB64(data, type));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  return { w: bmp.width, h: bmp.height, data: ctx.getImageData(0, 0, bmp.width, bmp.height).data };
}
const errInfo = (e: unknown) => (e instanceof CardRenderError ? { error: e.code, message: e.message } : { error: "unexpected", message: String(e) });

const api = {
  /** Tela Dividida: renderiza com o renderizador REAL e devolve o MP4 (base64) + resumo. */
  async split(raw: unknown, topUrl: string, bottomUrl: string) {
    try {
      const [top, bottom] = await Promise.all([fetchBlob(topUrl), fetchBlob(bottomUrl)]);
      const t0 = performance.now();
      const r = await renderSplitVideo(normalizeSplit(raw), { top, bottom });
      return { data: await b64(r.blob), thumb: r.thumbnail ? await b64(r.thumbnail) : null, durationS: r.durationS, hasAudio: r.hasAudio, audioPath: r.audioPath, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return e instanceof SplitRenderError ? { error: e.code, message: e.message } : { error: "unexpected", message: String(e) };
    }
  },
  async splitProbe(url: string) {
    try {
      return await probeSplitSource(await fetchBlob(url));
    } catch (e) {
      return e instanceof SplitRenderError ? { error: e.code, message: e.message } : { error: "unexpected", message: String(e) };
    }
  },
  canMixAudio: () => canMixAudio(),

  async layout(cfg: Cfg) {
    await ensureCardFonts();
    const ctx = new OffscreenCanvas(10, 10).getContext("2d")!;
    return layoutFor(ctx, cfg.content, cfg.style ?? {});
  },
  async image(cfg: Cfg, type: "image/png" | "image/jpeg" = "image/png") {
    try {
      return { data: await b64(await renderCardImage(await toInput(cfg), type)) };
    } catch (e) {
      return errInfo(e);
    }
  },
  async video(cfg: Cfg, sourceUrl: string) {
    try {
      const r = await renderCardVideo(await toInput(cfg), await fetchBlob(sourceUrl));
      return { data: await b64(r.blob), width: r.width, height: r.height, durationS: r.durationS, hasAudio: r.hasAudio };
    } catch (e) {
      return errInfo(e);
    }
  },
  /** Prévia do editor (renderPreview em <canvas> da página) vs PNG exportado: diferença por pixel. */
  async previewVsExport(cfg: Cfg) {
    const input = await toInput(cfg);
    await ensureCardFonts();
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    renderPreview(canvas, input, { showSafeArea: false });
    const prev = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    const exp = await pixels(await b64(await renderCardImage(input, "image/png")), "image/png");
    let max = 0;
    let differing = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let i = 0; i < prev.length; i++) {
      const d = Math.abs(prev[i]! - exp.data[i]!);
      if (d > max) max = d;
      if (d > 0) {
        differing++;
        const px = (i >> 2) % canvas.width, py = Math.floor((i >> 2) / canvas.width);
        x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
      }
    }
    return { width: canvas.width, height: canvas.height, exportW: exp.w, exportH: exp.h, maxDiff: max, differing, bbox: differing ? { x0, y0, x1, y1 } : null };
  },
  /** Estatísticas de uma região: fração não-branca, fração escura (texto) e fração colorida (foto/emoji). */
  async stats(data: string, type: string, r: Rect) {
    const p = await pixels(data, type);
    let nonWhite = 0, dark = 0, colored = 0, n = 0;
    for (let y = Math.floor(r.y); y < Math.floor(r.y + r.h); y++) {
      for (let x = Math.floor(r.x); x < Math.floor(r.x + r.w); x++) {
        const i = (y * p.w + x) * 4;
        const R = p.data[i]!, G = p.data[i + 1]!, B = p.data[i + 2]!;
        n++;
        if (R < 245 || G < 245 || B < 245) nonWhite++;
        if (R + G + B < 200) dark++;
        if (Math.max(R, G, B) - Math.min(R, G, B) > 60) colored++;
      }
    }
    return { w: p.w, h: p.h, nonWhite: nonWhite / n, dark: dark / n, colored: colored / n };
  },
  /** Diferença média absoluta (0–255) entre duas imagens numa região. */
  async diff(a: string, aType: string, b: string, bType: string, r: Rect) {
    const A = await pixels(a, aType);
    const B = await pixels(b, bType);
    let sum = 0, n = 0;
    for (let y = Math.floor(r.y); y < Math.floor(r.y + r.h); y++) {
      for (let x = Math.floor(r.x); x < Math.floor(r.x + r.w); x++) {
        const i = (y * A.w + x) * 4;
        for (let k = 0; k < 3; k++) sum += Math.abs(A.data[i + k]! - B.data[i + k]!);
        n += 3;
      }
    }
    return sum / n;
  },
};
(window as unknown as { rf: typeof api }).rf = api;
document.body.dataset.ready = "1";
