"use client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sha256File } from "@/lib/upload/hash";
import { SplitRenderError } from "./render";

/**
 * Envia um vídeo para a Biblioteca pelo mesmo caminho verificado de qualquer mídia:
 * SHA-256 → begin_media_upload (limites do plano) → upload → complete_media_upload.
 * O worker analisa o arquivo depois (tipo real, codec, duração). Nunca sobrescreve: sempre mídia nova.
 */
export const MAX_SPLIT_BYTES = 50 * 1024 * 1024; // limite atual do armazenamento por arquivo

export async function uploadToLibrary(
  supabase: SupabaseClient,
  args: { workspaceId: string; blob: Blob; name: string; mime?: "video/mp4" | "video/quicktime"; thumbnail?: Blob | null; onStep?: (s: "hashing" | "uploading" | "finalizing") => void },
): Promise<{ mediaId: string }> {
  const { workspaceId, blob } = args;
  if (blob.size > MAX_SPLIT_BYTES) {
    throw new SplitRenderError("too_large", `O arquivo tem ${(blob.size / 1024 / 1024).toFixed(0)} MB; o limite atual é 50 MB por arquivo. Encurte o trecho ou use um vídeo menor.`);
  }
  args.onStep?.("hashing");
  const digest = await sha256File(blob);
  const mime = args.mime ?? "video/mp4";
  const name = `${args.name.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "Tela dividida"}.${mime === "video/mp4" ? "mp4" : "mov"}`;
  const { data: begun, error: beginErr } = await supabase.rpc("begin_media_upload", {
    p_workspace: workspaceId,
    p_files: [{ name, size: blob.size, mime, sha256: digest }],
  });
  const row = (begun as { media_id: string; storage_path: string }[] | null)?.[0];
  if (beginErr || !row) {
    throw new SplitRenderError("begin", beginErr?.message.includes("plan limit") ? "O limite do plano para mídias foi atingido." : "Não foi possível registrar o arquivo na Biblioteca.");
  }
  args.onStep?.("uploading");
  const { error: upErr } = await supabase.storage.from("media").upload(row.storage_path, blob, { contentType: mime, upsert: false });
  if (upErr) {
    await supabase.rpc("cancel_media_upload", { p_media: row.media_id });
    throw new SplitRenderError("upload", "Falha ao enviar o arquivo. Verifique a conexão e tente novamente.");
  }
  if (args.thumbnail) {
    await supabase.storage.from("media").upload(`${workspaceId}/${row.media_id}/thumb.jpg`, args.thumbnail, { contentType: "image/jpeg", upsert: false });
  }
  args.onStep?.("finalizing");
  const { data: completed, error: compErr } = await supabase.rpc("complete_media_upload", { p_media: row.media_id });
  if (compErr || completed === "failed") throw new SplitRenderError("complete", "O arquivo recebido não confere com o enviado. Tente novamente.");
  return { mediaId: row.media_id };
}
