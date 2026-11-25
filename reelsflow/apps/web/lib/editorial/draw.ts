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

  if (l.badge) drawBadge(ctx, l.badge);

  // Marca-d'água do próprio usuário (opcional).
  const wm = l.watermarkAnchor;
  if (wm && input.watermark.kind !== "none") {
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0.1, input.watermark.opacity));
    if (input.watermark.kind === "logo" && input.watermark.logo) {
      // Proporção sempre preservada: se a logo for larga demais para o espaço, reduz altura e largura juntas.
      const ratio = input.watermark.logo.width / input.watermark.logo.height;
      const w = Math.min(wm.maxWidth, ratio * wm.size * 1.6);
      const h = w / ratio;
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
    if (l.height > l.width) drawReelsOverlay(ctx, l);
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

/**
 * Selo de identidade visual (próprio): círculo âmbar com estrela branca de 5 pontas.
 * Propositalmente diferente do selo oficial de verificação (azul com visto) para não se passar por ele.
 */
function drawBadge(ctx: Ctx, b: { x: number; y: number; w: number; h: number }): void {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = b.w / 2;
  ctx.save();
  ctx.fillStyle = "#F5A524";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 === 0 ? r * 0.62 : r * 0.26;
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = cx + rr * Math.cos(ang), py = cy + rr * Math.sin(ang);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * SIMULAÇÃO APROXIMADA da interface dos Reels sobre o card (só na prévia; nunca no arquivo final).
 * Coordenadas no canvas 1080×1920, tiradas de um print de iPhone (tela mais alta que 9:16): faixas
 * laterais cortadas, abas no topo, coluna de botões à direita, perfil/legenda e barra de navegação na base.
 */
function drawReelsOverlay(ctx: Ctx, l: CardLayout): void {
  const k = l.width / 1080;
  const font = l.fontFamily;
  ctx.save();
  // Laterais que somem em telas altas.
  ctx.fillStyle = "rgba(220, 38, 38, 0.18)";
  ctx.fillRect(0, 0, 96 * k, l.height);
  ctx.fillRect(l.width - 96 * k, 0, 96 * k, l.height);
  // Faixas de risco (margens aprovadas: 285 px em cima, 400 px embaixo) — onde a interface pode cobrir.
  ctx.fillStyle = "rgba(220, 38, 38, 0.14)";
  ctx.fillRect(96 * k, 0, l.width - 192 * k, 285 * k);
  ctx.fillRect(96 * k, l.height - 400 * k, l.width - 192 * k, 400 * k);
  // Topo (abas) e base (barra do app).
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.fillRect(0, 0, l.width, 188 * k);
  ctx.fillRect(0, 1737 * k, l.width, l.height - 1737 * k);
  // Gradiente escuro atrás de perfil/legenda.
  ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
  ctx.fillRect(0, 1540 * k, l.width, 197 * k);
  ctx.fillStyle = "#FFFFFF";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.font = `600 ${Math.round(40 * k)}px ${font}`;
  ctx.fillText("Reels      Amigos", l.width / 2, 120 * k);
  // Coluna de botões (curtir, comentar, repostar, enviar, mais).
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  for (const y of [1162, 1262, 1369, 1469, 1569]) {
    ctx.beginPath();
    ctx.arc(917 * k, y * k, 35 * k, 0, Math.PI * 2);
    ctx.fill();
  }
  // Linha de perfil e legenda.
  ctx.beginPath();
  ctx.arc(167 * k, 1596 * k, 38 * k, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "left";
  ctx.font = `600 ${Math.round(34 * k)}px ${font}`;
  ctx.fillText("nome_do_perfil  •  Seguir", 227 * k, 1596 * k);
  ctx.font = `400 ${Math.round(32 * k)}px ${font}`;
  ctx.fillText("Legenda do post aparece aqui…", 129 * k, 1675 * k);
  // Referência central 1080×1350 (285 px acima e abaixo).
  ctx.setLineDash([18 * k, 10 * k]);
  ctx.strokeStyle = "rgba(14, 165, 233, 0.95)";
  ctx.lineWidth = 3 * k;
  ctx.strokeRect(1.5 * k, 285 * k, l.width - 3 * k, 1350 * k);
  ctx.setLineDash([]);
  ctx.font = `600 ${Math.round(24 * k)}px ${font}`;
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(14, 165, 233, 1)";
  ctx.fillText("Referência central 1080×1350 (tracejado azul)", 110 * k, 170 * k);
  // Rótulo.
  ctx.font = `600 ${Math.round(26 * k)}px ${font}`;
  ctx.textAlign = "center";
  ctx.fillStyle = "#FFFFFF";
  ctx.fillText("Simulação aproximada do Instagram — não sai no arquivo final", l.width / 2, 1810 * k);
  ctx.font = `400 ${Math.round(22 * k)}px ${font}`;
  ctx.fillText("Vermelho: faixas de risco · Azul: referência 1080×1350 · Rosa: área segura do card", l.width / 2, 1850 * k);
  ctx.restore();
}
