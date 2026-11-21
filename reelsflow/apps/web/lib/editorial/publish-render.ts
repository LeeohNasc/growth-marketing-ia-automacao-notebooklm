"use client";
import { createSHA256 } from "hash-wasm";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CardRenderError } from "./export";

/**
 * Envia o ARQUIVO FINAL renderizado pelo mesmo caminho de qualquer mídia do ReelsFlow:
 * SHA-256 → begin_media_upload → upload → (miniatura do vídeo) → complete_media_upload
 * → attach_card_render. O card só fica "pronto" quando o worker analisar o arquivo
 * (tipo real, dimensões, codec, duração) — e só então pode ser agendado.
 */
async function sha256(blob: Blob): Promise<string> {
  const h = await createSHA256();
  h.init();
  const chunk = 4 * 1024 * 1024;
  for (let i = 0; i < blob.size; i += chunk) h.update(new Uint8Array(await blob.slice(i, i + chunk).arrayBuffer()));
  return h.digest("hex");
}

export type FinalRender = { blob: Blob; mime: "image/jpeg" | "video/mp4"; thumbnail?: Blob | null };

export async function uploadFinalRender(
  supabase: SupabaseClient,
  args: { workspaceId: string; cardId: string; title: string; render: FinalRender; onStep?: (s: "hashing" | "uploading" | "finalizing") => void },
): Promise<{ mediaId: string; status: string }> {
  const { workspaceId, cardId, render } = args;
  args.onStep?.("hashing");
  const digest = await sha256(render.blob);
  const ext = render.mime === "video/mp4" ? "mp4" : "jpg";
  const name = `${args.title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "Card Editorial"}.${ext}`;
  const { data: begun, error: beginErr } = await supabase.rpc("begin_media_upload", {
    p_workspace: workspaceId,
    p_files: [{ name, size: render.blob.size, mime: render.mime, sha256: digest }],
  });
  const row = (begun as { media_id: string; storage_path: string }[] | null)?.[0];
  if (beginErr || !row) {
    throw new CardRenderError("begin", beginErr?.message.includes("plan limit") ? "O limite do plano para mídias foi atingido." : "Não foi possível registrar o arquivo final.");
  }
  args.onStep?.("uploading");
  const { error: upErr } = await supabase.storage.from("media").upload(row.storage_path, render.blob, { contentType: render.mime, upsert: false });
  if (upErr) {
    await supabase.rpc("cancel_media_upload", { p_media: row.media_id });
    throw new CardRenderError("upload", "Falha ao enviar o arquivo final. Tente novamente; nada foi publicado.");
  }
  if (render.mime === "video/mp4" && render.thumbnail) {
    // Miniatura opcional (o worker na Edge Function não gera miniatura de vídeo).
    await supabase.storage.from("media").upload(`${workspaceId}/${row.media_id}/thumb.jpg`, render.thumbnail, { contentType: "image/jpeg", upsert: false });
  }
  args.onStep?.("finalizing");
  const { data: completed, error: compErr } = await supabase.rpc("complete_media_upload", { p_media: row.media_id });
  if (compErr || completed === "failed") throw new CardRenderError("complete", "O arquivo recebido não confere com o renderizado. Renderize novamente.");
  const { data: status, error: attErr } = await supabase.rpc("attach_card_render", { p_card: cardId, p_media: row.media_id });
  if (attErr) throw new CardRenderError("attach", "Não foi possível ligar o arquivo final ao card.");
  return { mediaId: row.media_id, status: String(status) };
}

/** Acompanha a análise do servidor até "pronto" ou "erro" (sem segurar a página para sempre). */
export async function waitForRenderVerdict(
  supabase: SupabaseClient,
  cardId: string,
  opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<{ status: string; error: string | null }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  for (;;) {
    const { data } = await supabase.from("editorial_cards").select("render_status, render_error").eq("id", cardId).maybeSingle();
    const st = (data as { render_status?: string; render_error?: string | null } | null) ?? null;
    if (st && (st.render_status === "ready" || st.render_status === "error")) return { status: st.render_status, error: st.render_error ?? null };
    if (Date.now() > deadline || opts.signal?.aborted) return { status: st?.render_status ?? "processing", error: null };
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 3000));
  }
}
