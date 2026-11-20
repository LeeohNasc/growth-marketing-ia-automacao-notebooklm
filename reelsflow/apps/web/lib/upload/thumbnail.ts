/**
 * Miniatura gerada no navegador durante o envio (o worker na Edge Function não tem ffmpeg).
 * Melhor esforço: se o navegador não decodifica o vídeo (ex.: HEVC no Chrome/Windows),
 * retorna null e o vídeo segue sem miniatura — a análise e a publicação não dependem dela.
 */
export async function makeThumbnail(file: File, opts: { maxSide?: number; timeoutMs?: number } = {}): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const maxSide = opts.maxSide ?? 640;
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;

  const once = (ev: string) =>
    new Promise<void>((resolve, reject) => {
      video.addEventListener(ev, () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("decode")), { once: true });
    });
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.timeoutMs ?? 15_000));

  const work = (async () => {
    await once("loadedmetadata");
    if (!video.videoWidth || !video.videoHeight) return null;
    const target = Number.isFinite(video.duration) ? Math.min(1, video.duration / 10) : 0;
    if (target > 0) {
      const seeked = once("seeked");
      video.currentTime = target;
      await seeked;
    } else {
      await once("loadeddata");
    }
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  })().catch(() => null);

  try {
    return await Promise.race([work, timeout]);
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
