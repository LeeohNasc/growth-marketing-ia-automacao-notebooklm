import { CARD_FORMATS, type CardLayout } from "@reelsflow/domain";
import { drawCard, layoutFor } from "./draw";
import type { CardRenderInput } from "./export";

/**
 * Prévia do editor: mesmo `drawCard` do arquivo final, no canvas da tela com a resolução REAL do
 * formato (o CSS só reduz a exibição). Diferenças em relação ao arquivo: placeholders quando falta
 * mídia e, se ligado, as guias de área segura.
 */
export function renderPreview(canvas: HTMLCanvasElement, input: CardRenderInput, opts: { showSafeArea?: boolean } = {}): CardLayout {
  const { width, height } = CARD_FORMATS[input.content.format];
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas indisponível");
  const layout = layoutFor(ctx, input.content, input.style);
  drawCard(ctx, {
    layout,
    fit: input.content.fit,
    focal: input.focal,
    avatar: input.avatar,
    media: input.media,
    watermark: { kind: input.style.watermark?.kind ?? "none", opacity: input.style.watermark?.opacity ?? 0.7, text: "@" + input.content.username.replace(/^@+/, ""), logo: input.logo },
    preview: true,
    showSafeArea: opts.showSafeArea,
  });
  return layout;
}
