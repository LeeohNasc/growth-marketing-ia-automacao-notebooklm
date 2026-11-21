import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, QUALITY_HIGH, VideoSample } from "mediabunny";
import { BT709_LIMITED, CARD_FORMATS, rgbaToI420Limited, type CardContent, type CardStyle, type FocalPoint } from "@reelsflow/domain";
import { drawCard, imageDrawable, layoutFor, type Drawable } from "./draw";
import { ensureCardFonts } from "./fonts";

/**
 * Renderização do ARQUIVO FINAL (não é a prévia em HTML): a composição inteira — avatar, nome, @,
 * manchete e mídia — é desenhada no canvas pela mesma função da prévia e exportada.
 *  - imagem: JPEG (publicação) ou PNG (download), na resolução exata do formato;
 *  - vídeo: MP4 H.264 (4:2:0), faststart, mesma duração do vídeo de origem; o áudio AAC original é
 *    COPIADO sem recodificar (sincronia e qualidade preservadas).
 * Roda no navegador (WebCodecs): o servidor do ReelsFlow não tem codificador de vídeo.
 */
export class CardRenderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CardRenderError";
  }
}

export type CardRenderInput = {
  content: CardContent;
  style: Partial<CardStyle>;
  focal: FocalPoint[];
  avatar: Drawable | null;
  media: (Drawable | null)[];
  logo: Drawable | null;
};

function newCanvas(w: number, h: number, readback = false): { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D } {
  // Mesmo tipo de canvas da prévia (HTMLCanvasElement): mesmo rasterizador, inclusive no
  // antisserrilhado da borda do avatar. OffscreenCanvas só fora do documento (ex.: worker).
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", readback ? { willReadFrequently: true } : undefined);
    if (ctx) return { canvas, ctx };
  }
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (ctx) return { canvas, ctx };
  }
  throw new CardRenderError("no_canvas", "Este navegador não permite desenhar o card.");
}

const toBlob = async (canvas: OffscreenCanvas | HTMLCanvasElement, type: string, quality?: number): Promise<Blob> =>
  typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas
    ? canvas.convertToBlob({ type, quality })
    : new Promise((resolve, reject) => (canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), type, quality));

const watermarkFor = (input: CardRenderInput) => ({
  kind: input.style.watermark?.kind ?? "none",
  opacity: input.style.watermark?.opacity ?? 0.7,
  text: "@" + input.content.username.replace(/^@+/, ""),
  logo: input.logo,
});

/** Bloqueia o que a prévia mostra como problema: nunca exportar truncado em silêncio. */
function assertExportable(input: CardRenderInput, layoutBlocking: { message: string }[]) {
  if (layoutBlocking.length) throw new CardRenderError("blocked", layoutBlocking.map((b) => b.message).join(" "));
  const need = input.content.mediaKind === "image_pair" ? 2 : 1;
  if (input.content.mediaKind !== "video" && input.media.slice(0, need).some((m) => !m)) {
    throw new CardRenderError("media_missing", need === 2 ? "Envie as duas imagens antes de renderizar." : "Envie a imagem antes de renderizar.");
  }
}

export async function renderCardImage(input: CardRenderInput, type: "image/jpeg" | "image/png" = "image/jpeg"): Promise<Blob> {
  await ensureCardFonts();
  const { width, height } = CARD_FORMATS[input.content.format];
  const { canvas, ctx } = newCanvas(width, height);
  const layout = layoutFor(ctx, input.content, input.style);
  assertExportable(input, layout.blocking);
  drawCard(ctx, { layout, fit: input.content.fit, focal: input.focal, avatar: input.avatar, media: input.media, watermark: watermarkFor(input) });
  return toBlob(canvas, type, type === "image/jpeg" ? 0.92 : undefined);
}

export type VideoRenderResult = { blob: Blob; width: number; height: number; durationS: number; hasAudio: boolean };

export async function renderCardVideo(
  input: CardRenderInput,
  source: Blob,
  opts: { onProgress?: (p: number) => void; signal?: AbortSignal } = {},
): Promise<VideoRenderResult> {
  if (typeof VideoEncoder === "undefined") {
    throw new CardRenderError("no_webcodecs", "Este navegador não consegue gerar vídeo. Use o Chrome, Edge ou Safari atualizados no computador.");
  }
  await ensureCardFonts();
  const { width, height } = CARD_FORMATS[input.content.format];
  const { ctx } = newCanvas(width, height, true);
  const layout = layoutFor(ctx, input.content, input.style);
  assertExportable(input, layout.blocking);
  const yuv = new Uint8Array(width * height * 1.5);

  const media = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
  const vTrack = await media.getPrimaryVideoTrack().catch(() => null);
  if (!vTrack) throw new CardRenderError("no_video", "O arquivo não tem uma faixa de vídeo legível.");
  if (!(await vTrack.canDecode())) {
    throw new CardRenderError(
      "video_codec",
      `Este navegador não decodifica o vídeo de origem (${vTrack.codec ?? "codec desconhecido"}). Converta para MP4 H.264 ou use outro navegador.`,
    );
  }
  const aTrack = await media.getPrimaryAudioTrack().catch(() => null);
  const durationS = await media.computeDuration();

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
  const watermark = watermarkFor(input);
  const conversion = await Conversion.init({
    input: media,
    output,
    showWarnings: false,
    video: {
      codec: "avc",
      quality: QUALITY_HIGH,
      processedWidth: width,
      processedHeight: height,
      process: (sample) => {
        const frame: Drawable = {
          width: sample.displayWidth,
          height: sample.displayHeight,
          draw: (c, sx, sy, sw, sh, dx, dy, dw, dh) => sample.draw(c, sx, sy, sw, sh, dx, dy, dw, dh),
        };
        drawCard(ctx, { layout, fit: input.content.fit, focal: input.focal, avatar: input.avatar, media: [frame], watermark });
        // RGB → I420 faixa limitada BT.709 aqui (não no codificador): MP4 sai yuv420p "tv".
        const rgba = ctx.getImageData(0, 0, width, height).data;
        return new VideoSample(rgbaToI420Limited(rgba, width, height, yuv), {
          format: "I420",
          codedWidth: width,
          codedHeight: height,
          timestamp: sample.timestamp,
          duration: sample.duration,
          colorSpace: BT709_LIMITED,
        });
      },
    },
    // AAC de origem é copiado (sem recodificar). Outro codec só se o navegador souber gerar AAC.
    audio: { codec: "aac" },
  });

  const dropped = conversion.discardedTracks;
  if (!conversion.isValid || dropped.some((d) => d.track.type === "video")) {
    throw new CardRenderError("invalid_conversion", "Não foi possível preparar o vídeo para renderização neste navegador.");
  }
  if (aTrack && dropped.some((d) => d.track.type === "audio")) {
    throw new CardRenderError(
      "audio_codec",
      `O áudio do vídeo (${aTrack.codec ?? "desconhecido"}) não pode ser mantido em AAC neste navegador. Use um vídeo com áudio AAC (padrão de câmeras e celulares).`,
    );
  }
  conversion.onProgress = (p) => opts.onProgress?.(p);
  const abort = () => void conversion.cancel();
  opts.signal?.addEventListener("abort", abort, { once: true });
  try {
    await conversion.execute();
  } catch (e) {
    if (opts.signal?.aborted) throw new CardRenderError("canceled", "Renderização cancelada.");
    throw new CardRenderError("encode_failed", `Falha ao gerar o vídeo: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    opts.signal?.removeEventListener("abort", abort);
  }
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer || buffer.byteLength === 0) throw new CardRenderError("empty_output", "O vídeo gerado ficou vazio.");
  return { blob: new Blob([buffer], { type: "video/mp4" }), width, height, durationS, hasAudio: Boolean(aTrack) };
}

/** Decodifica uma imagem (respeitando a orientação EXIF) para desenhar no canvas. */
export async function loadImageDrawable(blob: Blob): Promise<Drawable> {
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    return imageDrawable(bmp, bmp.width, bmp.height);
  } catch {
    throw new CardRenderError("image_decode", "Não foi possível ler a imagem (arquivo corrompido ou formato não suportado).");
  }
}
