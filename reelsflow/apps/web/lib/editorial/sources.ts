"use client";
import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CardRenderError, loadImageDrawable } from "./export";
import type { Drawable } from "./draw";

/**
 * Arquivos de ORIGEM do card (avatar, fotos, vídeo, logo). Nunca são publicados: só alimentam a
 * renderização. Validação aqui (tipo real pelos bytes, tamanho, dimensão, duração) + no servidor
 * (bucket: MIME/tamanho; banco: caminho dentro de {workspace}/cards/). O arquivo FINAL ainda passa
 * pela análise do worker antes de poder ser agendado.
 */
export type SourceKind = "avatar" | "image" | "video" | "logo";

const LIMITS: Record<SourceKind, { maxBytes: number; minSide: number; types: string[]; label: string }> = {
  avatar: { maxBytes: 5 * 1024 * 1024, minSide: 96, types: ["image/png", "image/jpeg", "image/webp"], label: "PNG, JPG ou WebP até 5 MB" },
  logo: { maxBytes: 5 * 1024 * 1024, minSide: 32, types: ["image/png", "image/jpeg", "image/webp"], label: "PNG, JPG ou WebP até 5 MB" },
  image: { maxBytes: 20 * 1024 * 1024, minSide: 320, types: ["image/png", "image/jpeg", "image/webp"], label: "PNG, JPG ou WebP até 20 MB" },
  video: { maxBytes: 50 * 1024 * 1024, minSide: 320, types: ["video/mp4", "video/quicktime"], label: "MP4 ou MOV até 50 MB, de 3 s a 15 min" },
};
export const sourceHint = (k: SourceKind) => LIMITS[k].label;
export const sourceAccept = (k: SourceKind) => LIMITS[k].types.join(",");

/** Tipo REAL pelo conteúdo (não pela extensão nem pelo `accept` do navegador). */
export async function sniffType(file: Blob): Promise<string | null> {
  const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const at = (i: number, s: string) => s.split("").every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b[0] === 0x89 && at(1, "PNG")) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  if (at(4, "ftyp")) return at(8, "qt  ") ? "video/quicktime" : "video/mp4";
  if (at(4, "moov") || at(4, "wide") || at(4, "mdat") || at(4, "free")) return "video/quicktime";
  return null;
}

export type LoadedSource = { kind: SourceKind; blob: Blob; type: string; drawable: Drawable | null; width: number; height: number; durationS: number | null };

export async function validateSource(kind: SourceKind, file: Blob): Promise<LoadedSource> {
  const lim = LIMITS[kind];
  if (file.size === 0) throw new CardRenderError("empty", "O arquivo está vazio.");
  if (file.size > lim.maxBytes) throw new CardRenderError("too_large", `Arquivo grande demais. Use ${lim.label}.`);
  const type = await sniffType(file);
  if (!type || !lim.types.includes(type)) throw new CardRenderError("bad_type", `Formato não aceito. Use ${lim.label}.`);
  if (kind === "video") {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack().catch(() => null);
    if (!track) throw new CardRenderError("no_video", "O arquivo não tem uma faixa de vídeo legível (corrompido?).");
    if (!(await track.canDecode())) throw new CardRenderError("video_codec", "Este navegador não decodifica esse vídeo (ex.: HEVC). Converta para MP4 H.264.");
    const durationS = await input.computeDuration();
    if (durationS < 3 || durationS > 900) throw new CardRenderError("duration", "O vídeo precisa ter entre 3 segundos e 15 minutos.");
    const w = track.displayWidth, h = track.displayHeight;
    if (Math.min(w, h) < lim.minSide) throw new CardRenderError("too_small", `Resolução muito baixa (mínimo ${lim.minSide} px no lado menor).`);
    return { kind, blob: file, type, drawable: null, width: w, height: h, durationS };
  }
  const drawable = await loadImageDrawable(file);
  if (Math.min(drawable.width, drawable.height) < lim.minSide) {
    throw new CardRenderError("too_small", `Imagem pequena demais (mínimo ${lim.minSide} px no lado menor).`);
  }
  return { kind, blob: file, type, drawable, width: drawable.width, height: drawable.height, durationS: null };
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov" };

/** Envia a origem para {workspace}/cards/{card}/{tipo}-{aleatório}.{ext} (nome novo a cada envio). */
export async function uploadSource(supabase: SupabaseClient, workspaceId: string, cardId: string, src: LoadedSource): Promise<string> {
  const path = `${workspaceId}/cards/${cardId}/${src.kind}-${crypto.randomUUID().slice(0, 12)}.${EXT[src.type]}`;
  const { error } = await supabase.storage.from("media").upload(path, src.blob, { contentType: src.type, upsert: false });
  if (error) throw new CardRenderError("upload", "Não foi possível enviar o arquivo. Verifique a conexão e tente novamente.");
  return path;
}

/**
 * Usa um vídeo que já está na Biblioteca como origem do card: o arquivo é COPIADO dentro do armazenamento
 * (nada é reenviado do aparelho). Se a cópia não for permitida, cai no envio normal do arquivo já baixado.
 */
export async function copySource(supabase: SupabaseClient, workspaceId: string, cardId: string, src: LoadedSource, fromPath: string): Promise<string> {
  const path = `${workspaceId}/cards/${cardId}/${src.kind}-${crypto.randomUUID().slice(0, 12)}.${EXT[src.type]}`;
  if (fromPath.startsWith(`${workspaceId}/`)) {
    const { error } = await supabase.storage.from("media").copy(fromPath, path);
    if (!error) return path;
  }
  return uploadSource(supabase, workspaceId, cardId, src);
}

/** Baixa uma origem já salva (URL assinada de curta duração) como Blob — sem "contaminar" o canvas. */
export async function fetchSource(kind: SourceKind, url: string): Promise<LoadedSource> {
  const res = await fetch(url);
  if (!res.ok) throw new CardRenderError("fetch", "Não foi possível carregar um arquivo salvo do card.");
  return validateSource(kind, await res.blob());
}
