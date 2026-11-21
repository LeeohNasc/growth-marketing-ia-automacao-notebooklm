import { describe, expect, it } from "vitest";
import {
  CARD_FORMATS,
  computeCardLayout,
  cardPublishRestrictions,
  ellipsize,
  fitMedia,
  headlineLength,
  wrapText,
  type CardContent,
  type TextMeasurer,
} from "./layout";

/** Medidor determinístico: cada grafema = 0,55 × tamanho da fonte (emoji conta como 1). */
const measure: TextMeasurer = (text, font) => {
  const size = Number(/(\d+)px/.exec(font)![1]);
  const n = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)).length;
  return n * size * 0.55;
};
const base: CardContent = { format: "feed", pageName: "Pipocou", username: "pipocoumemes", headline: "🚨 VEJA | Manchete curta", mediaKind: "image", fit: "cover" };

describe("layout do Card Editorial", () => {
  it.each(Object.entries(CARD_FORMATS))("%s: dimensões exatas, escala proporcional e mídia preenchendo a largura", (fmt, dim) => {
    const l = computeCardLayout({ ...base, format: fmt as CardContent["format"] }, {}, measure);
    expect([l.width, l.height]).toEqual([dim.width, dim.height]);
    expect(l.u).toBe(1);
    expect(l.media.x).toBe(0);
    expect(l.media.w).toBe(dim.width);
    expect(l.media.y).toBeGreaterThan(l.avatar.y + l.avatar.h);
    expect(l.media.y + l.media.h).toBeLessThanOrEqual(dim.height);
    expect(l.blocking).toEqual([]);
  });

  it("nome e @ lado a lado quando cabem; manchete abaixo do nome, alinhada à coluna de texto", () => {
    const l = computeCardLayout(base, {}, measure);
    expect(l.username.y).toBe(l.name.y);
    expect(l.username.x).toBeGreaterThan(l.name.x);
    expect(l.headline.lines[0]!.x).toBe(l.name.x);
    expect(l.headline.lines[0]!.y).toBeGreaterThan(l.name.y);
    expect(l.avatar.x + l.avatar.w).toBeLessThan(l.name.x);
  });

  it("nome e @ longos: @ desce de linha, reticências, e a manchete começa abaixo deles (sem sobrepor)", () => {
    const l = computeCardLayout({ ...base, pageName: "Portal de Notícias Muito Longo Mesmo Com Nome Enorme Demais", username: "usuario_com_nome_muito_grande_x" }, {}, measure);
    expect(l.username.y).toBeGreaterThan(l.name.y);
    expect(measure(l.name.text, l.name.font)).toBeLessThanOrEqual(l.name.maxWidth);
    expect(l.name.text.endsWith("…")).toBe(true);
    expect(l.headline.lines[0]!.y - l.headline.lineHeight).toBeGreaterThanOrEqual(l.username.y);
    expect(l.warnings.map((w) => w.code)).toContain("page_name_truncated");
  });

  it("manchete longa: quebra natural, nenhuma linha passa da coluna, nada é truncado", () => {
    const headline = "🚨 VEJA | Grupo é flagrado com notas de R$ 100 durante votação em Brasília; vídeo viraliza e caso será investigado pela polícia federal nesta semana";
    const l = computeCardLayout({ ...base, headline }, {}, measure);
    expect(l.headline.lines.length).toBeGreaterThan(2);
    for (const line of l.headline.lines) expect(measure(line.text, line.font)).toBeLessThanOrEqual(line.maxWidth + 0.001);
    expect(l.headline.lines.map((x) => x.text).join(" ").replace(/\s+/g, " ")).toBe(headline);
  });

  it("overflow: bloqueia exportação (não trunca); redução EXPLÍCITA da fonte resolve quando possível", () => {
    const headline = Array.from({ length: 12 }, () => "Linha longa de manchete").join("\n");
    const big = computeCardLayout({ ...base, format: "square", headline }, {}, measure);
    expect(big.blocking.map((b) => b.code)).toContain("headline_overflow");
    const smaller = computeCardLayout({ ...base, format: "square", headline }, { headlineScale: 0.7 }, measure);
    expect(smaller.headline.lines.length).toBe(12);
    expect(smaller.blocking.map((b) => b.code)).not.toContain("headline_overflow");
    expect(smaller.headline.scale).toBe(0.7);
  });

  it("acentos, emoji composto e quebras de linha preservados", () => {
    const lines = wrapText("Ação 👨‍👩‍👧 já\n\nfim", 1000, "400 42px x", measure);
    expect(lines).toEqual(["Ação 👨‍👩‍👧 já", "", "fim"]);
    // emoji composto nunca é partido ao reticenciar
    expect(ellipsize("👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧", 50, "400 42px x", measure)).toMatch(/^(👨‍👩‍👧)*…$/u);
    expect(headlineLength("👨‍👩‍👧ã")).toBe(2);
  });

  it("validações: limite de 280, @ inválido, campos vazios", () => {
    const l = computeCardLayout({ ...base, headline: "a".repeat(281), username: "@@ inválido!", pageName: " " }, {}, measure);
    const codes = l.blocking.map((b) => b.code);
    expect(codes).toEqual(expect.arrayContaining(["headline_too_long", "username_invalid", "page_name_required"]));
    expect(computeCardLayout({ ...base, username: "@pipocoumemes" }, {}, measure).username.text).toBe("@pipocoumemes");
  });

  it("duas imagens: slots iguais, divisória discreta no meio, sem sobreposição", () => {
    const l = computeCardLayout({ ...base, mediaKind: "image_pair" }, {}, measure);
    const [a, b] = l.slots as [typeof l.media, typeof l.media];
    expect(l.divider).not.toBeNull();
    expect(a.x + a.w).toBe(l.divider!.x);
    expect(l.divider!.x + l.divider!.w).toBe(b.x);
    expect(Math.abs(a.w - b.w)).toBeLessThanOrEqual(1);
    expect(b.x + b.w).toBe(l.width);
  });

  it("vertical 9:16: cabeçalho e base respeitam a área segura dos Reels", () => {
    const l = computeCardLayout({ ...base, format: "vertical" }, { bottomPadding: 0 }, measure);
    expect(l.avatar.y).toBeGreaterThanOrEqual(1920 * 0.1);
    expect(l.media.y + l.media.h).toBeLessThanOrEqual(1920 * 0.8);
  });

  it("respiro configurável e marca-d'água no respiro quando há espaço", () => {
    const a = computeCardLayout(base, { bottomPadding: 0 }, measure);
    const b = computeCardLayout(base, { bottomPadding: 120, watermark: { kind: "username", position: "bottom-right", opacity: 0.6 } }, measure);
    expect(a.media.y + a.media.h).toBe(1350);
    expect(b.media.y + b.media.h).toBe(1350 - 120);
    expect(b.watermarkAnchor!.y).toBeGreaterThan(b.media.y + b.media.h);
    expect(b.watermarkAnchor!.align).toBe("right");
  });
});

describe("enquadramento sem distorção", () => {
  const slot = { x: 0, y: 300, w: 1080, h: 900 };
  it("cover: preenche o slot, recorta mantendo a proporção da origem e respeita o ponto focal", () => {
    const r = fitMedia({ width: 1920, height: 1080 }, slot, "cover", { x: 0, y: 0.5 });
    expect([r.dx, r.dy, r.dw, r.dh]).toEqual([0, 300, 1080, 900]);
    expect(r.sw / r.sh).toBeCloseTo(1080 / 900, 6);
    expect(r.sx).toBe(0); // focal à esquerda
    const right = fitMedia({ width: 1920, height: 1080 }, slot, "cover", { x: 1, y: 0.5 });
    expect(right.sx + right.sw).toBeCloseTo(1920, 6);
  });
  it("contain: mostra tudo, centralizado, mesma proporção (sem esticar)", () => {
    const r = fitMedia({ width: 1080, height: 1920 }, slot, "contain");
    expect(r.dw / r.dh).toBeCloseTo(1080 / 1920, 6);
    expect(r.dh).toBe(900);
    expect(r.dx).toBeCloseTo((1080 - r.dw) / 2, 6);
  });
});

describe("restrições de publicação", () => {
  it("imagem 9:16 avisa sobre o feed do Instagram; vídeo não", () => {
    expect(cardPublishRestrictions("vertical", "image").map((r) => r.code)).toContain("ig_feed_image_ratio");
    expect(cardPublishRestrictions("vertical", "video")).toEqual([]);
    expect(cardPublishRestrictions("feed", "image_pair").map((r) => r.code)).toEqual(["image_needs_zernio"]);
  });
});

import { evaluateImageCompatibility } from "../media";
describe("compatibilidade de imagem", () => {
  it("4:5 e 1:1 JPEG: Instagram (feed) e Facebook com aviso de via Zernio; TikTok/YouTube não", () => {
    for (const [w, h] of [[1080, 1350], [1080, 1080]] as const) {
      const c = evaluateImageCompatibility({ width: w, height: h, format: "jpeg" }, 500_000);
      expect(c.kind).toBe("image");
      expect(c.platforms.instagram_reels.status).toBe("warning");
      expect(c.platforms.facebook_reels.status).toBe("warning");
      expect(c.platforms.tiktok.status).toBe("error");
      expect(c.platforms.youtube_shorts.status).toBe("error");
    }
  });
  it("9:16 ou acima de 8 MB: erro no Instagram", () => {
    expect(evaluateImageCompatibility({ width: 1080, height: 1920, format: "jpeg" }).platforms.instagram_reels.issues.map((i) => i.code)).toContain("image_ratio");
    expect(evaluateImageCompatibility({ width: 1080, height: 1350, format: "jpeg" }, 9 * 1024 * 1024).platforms.instagram_reels.status).toBe("error");
  });
});

import { rgbaToI420Limited } from "./yuv";
describe("RGBA → I420 faixa limitada BT.709", () => {
  const px = (r: number, g: number, b: number, w = 2, h = 2) => Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => [r, g, b, 255][i % 4]!);
  it("branco = (235,128,128); preto = (16,128,128); cinza neutro mantém croma 128", () => {
    expect(Array.from(rgbaToI420Limited(px(255, 255, 255), 2, 2))).toEqual([235, 235, 235, 235, 128, 128]);
    expect(Array.from(rgbaToI420Limited(px(0, 0, 0), 2, 2))).toEqual([16, 16, 16, 16, 128, 128]);
    const g = rgbaToI420Limited(px(128, 128, 128), 2, 2);
    expect([g[4], g[5]]).toEqual([128, 128]);
  });
  it("vermelho e azul puros: valores BT.709 de referência", () => {
    expect(Array.from(rgbaToI420Limited(px(255, 0, 0), 2, 2))).toEqual([63, 63, 63, 63, 102, 240]);
    expect(Array.from(rgbaToI420Limited(px(0, 0, 255), 2, 2))).toEqual([32, 32, 32, 32, 240, 118]);
  });
  it("tamanho do buffer e recusa de dimensões ímpares", () => {
    expect(rgbaToI420Limited(px(1, 2, 3, 4, 2), 4, 2).length).toBe(8 + 2 + 2);
    expect(() => rgbaToI420Limited(px(0, 0, 0, 3, 2), 3, 2)).toThrow();
  });
});

import { isCompatible } from "../scheduling/plan";
describe("agendamento de imagem por tipo de conta", () => {
  const imageItem = { campaignMediaId: "c", mediaId: "m", name: "card", compatibility: { kind: "image", rulesVersion: "x", platforms: { instagram_reels: { status: "warning", issues: [] } } } } as never;
  it("imagem: só contas via Zernio (ou simuladas); conector direto recusa antes de agendar", () => {
    expect(isCompatible(imageItem, "instagram", "zernio")).toBe(true);
    expect(isCompatible(imageItem, "instagram", "native")).toBe(false);
    expect(isCompatible(imageItem, "instagram")).toBe(false);
    expect(isCompatible(imageItem, "mock")).toBe(true);
  });
});
