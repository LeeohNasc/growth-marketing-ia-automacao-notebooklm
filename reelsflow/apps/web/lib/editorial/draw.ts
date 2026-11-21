import { CLASSIC_COLORS, computeCardLayout, fitMedia, type CardContent, type CardLayout, type CardStyle, type FocalPoint, type TextMeasurer } from "@reelsflow/domain";

/**
 * Qualquer coisa desenhável no card: imagem decodificada, quadro de vídeo (VideoSample) ou o
 * elemento <video> da prévia. `draw` recebe o recorte de origem e o destino (como drawImage).
 */
export type Drawable = {
  width: number;
  height: number;
  draw: (ctx: Ctx, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) => void;
};
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function imageDrawable(src: CanvasImageSource, width: number, height: number): Drawable {
  return { width, height, draw: (ctx, sx, sy, sw, sh, dx, dy, dw, dh) => ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) };
}

export type CardDrawInput = {
  layout: CardLayout;
  fit: CardContent["fit"];
  focal: FocalPoint[];
  avatar: Drawable | null;
  media: (Drawable | null)[];
  watermark: { kind: CardStyle["watermark"]["kind"]; opacity: number; text: string; logo: Drawable | null };
  /** Só na prévia: placeholders de mídia ausente. */
  preview?: boolean;
  /** Só na prévia e só se ligado: guias da área segura (nunca no arquivo final). */
  showSafeArea?: boolean;
};

/** Medidor de texto com cache, usando o mesmo motor de fontes do canvas que vai desenhar. */
export function canvasMeasurer(ctx: Ctx): TextMeasurer {
  const cache = new Map<string, number>();
  return (text, font) => {
    const k = font + "\u0000" + text;
    let w = cache.get(k);
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText(text).width;
      cache.set(k, w);
    }
    return w;
  };
}

export function layoutFor(ctx: Ctx, content: CardContent, style: Partial<CardStyle>): CardLayout {
  return computeCardLayout(content, style, canvasMeasurer(ctx));
}

/** Desenha o card inteiro. Usada pela prévia E pelo exportador (imagem e cada quadro do vídeo). */
export function drawCard(ctx: Ctx, input: CardDrawInput): void {
  const { layout: l } = input;
  ctx.save();
  ctx.fillStyle = CLASSIC_COLORS.background;
  ctx.fillRect(0, 0, l.width, l.height);

  // Mídia: recorte por slot, sem distorcer (cover com ponto focal / contain com fundo branco).
  l.slots.forEach((slot, i) => {
    const m = input.media[i] ?? null;
    ctx.save();
    ctx.beginPath();
    ctx.rect(slot.x, slot.y, slot.w, slot.h);
    ctx.clip();
    if (m && m.width > 0 && m.height > 0) {
      const r = fitMedia({ width: m.width, height: m.height }, slot, input.fit, input.focal[i]);
      m.draw(ctx, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
    } else if (input.preview) {
      ctx.fillStyle = CLASSIC_COLORS.placeholder;
      ctx.fillRect(slot.x, slot.y, slot.w, slot.h);
      ctx.fillStyle = CLASSIC_COLORS.username;
      ctx.font = `500 ${Math.round(32 * l.u)}px ${l.fontFamily}`;
      ctx.textAlign = "center";
      ctx.fillText(l.slots.length > 1 ? `Imagem ${i + 1}` : "Foto ou vídeo", slot.x + slot.w / 2, slot.y + slot.h / 2);
    }
    ctx.restore();
  });
  if (l.divider) {
    ctx.fillStyle = CLASSIC_COLORS.divider;
    ctx.fillRect(l.divider.x, l.divider.y, l.divider.w, l.divider.h);
  }

  // Avatar redondo (recorte central).
  const a = l.avatar;
  ctx.save();
  ctx.beginPath();
  ctx.arc(a.x + a.w / 2, a.y + a.h / 2, a.w / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (input.avatar) {
    const r = fitMedia({ width: input.avatar.width, height: input.avatar.height }, a, "cover");
    input.avatar.draw(ctx, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
  } else {
    ctx.fillStyle = CLASSIC_COLORS.placeholder;
    ctx.fillRect(a.x, a.y, a.w, a.h);
    const initial = Array.from(l.name.text.trim())[0]?.toUpperCase() ?? "";
    ctx.fillStyle = CLASSIC_COLORS.username;
    ctx.font = `700 ${Math.round(a.w * 0.42)}px ${l.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initial, a.x + a.w / 2, a.y + a.h / 2 + a.h * 0.03);
  }
  ctx.restore();

  // Textos (fillText: texto puro, nunca HTML).
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  for (const run of [l.name, l.username, ...l.headline.lines]) {
    if (!run.text) continue;
    ctx.font = run.font;
    ctx.fillStyle = run.color;
    ctx.fillText(run.text, run.x, run.y);
  }

  // Marca-d'água do próprio usuário (opcional).
  const wm = l.watermarkAnchor;
  if (wm && input.watermark.kind !== "none") {
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0.1, input.watermark.opacity));
    if (input.watermark.kind === "logo" && input.watermark.logo) {
      const h = wm.size * 1.6;
      const w = Math.min(wm.maxWidth, (input.watermark.logo.width / input.watermark.logo.height) * h);
      const x = wm.align === "right" ? wm.x - w : wm.x;
      input.watermark.logo.draw(ctx, 0, 0, input.watermark.logo.width, input.watermark.logo.height, x, wm.y - h / 2, w, h);
    } else if (input.watermark.text) {
      ctx.font = `600 ${Math.round(wm.size)}px ${l.fontFamily}`;
      ctx.fillStyle = CLASSIC_COLORS.username;
      ctx.textAlign = wm.align;
      ctx.textBaseline = "middle";
      ctx.fillText(input.watermark.text, wm.x, wm.y, wm.maxWidth);
    }
    ctx.restore();
  }

  if (input.preview && input.showSafeArea) {
    ctx.save();
    ctx.setLineDash([12 * l.u, 10 * l.u]);
    ctx.strokeStyle = CLASSIC_COLORS.safeArea;
    ctx.lineWidth = 3 * l.u;
    const s = l.safeArea;
    ctx.strokeRect(s.x, s.y, s.w, s.h);
    ctx.restore();
  }
  ctx.restore();
}
