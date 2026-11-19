import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { ProbeError, evaluateCompatibility, parseFfprobe, thumbnailPathFor } from "@reelsflow/domain";
import { ffprobeJson, makeThumbnail } from "../ffmpeg";
import type { Handler } from "./types";

type MediaRow = {
  id: string;
  workspace_id: string;
  uploaded_by: string | null;
  name: string;
  storage_path: string;
  status: string;
  deleted_at: string | null;
};

const PROBE_FAILURE_REASONS: Record<ProbeError["code"], string> = {
  no_video_stream: "invalid_video",
  invalid_output: "invalid_video",
  invalid_dimensions: "invalid_video",
};

/**
 * Extrai metadados, gera thumbnail e avalia compatibilidade. Idempotente:
 * pode ser reexecutado após queda do worker sem efeitos duplicados.
 */
export const handleProbe: Handler = async (job, deps, ctx) => {
  const { db, storage, log } = deps;
  const { rows } = await db.query<MediaRow>(
    "select id, workspace_id, uploaded_by, name, storage_path, status, deleted_at from public.media_assets where id = $1",
    [job.media_asset_id],
  );
  const media = rows[0];
  if (!media || media.deleted_at || !["uploaded", "processing"].includes(media.status)) {
    log.info("probe skipped", { job_id: job.id, media_id: job.media_asset_id, status: media?.status ?? "missing" });
    return;
  }
  if (media.status === "uploaded") {
    await db.query("update public.media_assets set status = 'processing' where id = $1", [media.id]);
  }

  const dir = await mkdtemp(path.join(deps.tmpDir, "rf-probe-"));
  try {
    const ext = path.extname(media.storage_path).slice(1);
    const local = path.join(dir, `original.${ext}`);
    await storage.download(media.storage_path, local);

    let probe;
    try {
      probe = parseFfprobe(await ffprobeJson(deps.ffmpeg, local));
    } catch (err) {
      // ffprobe falha (código != 0) em arquivos que não são mídia: erro permanente.
      const permanent = err instanceof ProbeError || (err as { code?: unknown }).code === 1;
      if (!permanent) throw err;
      const reason = err instanceof ProbeError ? PROBE_FAILURE_REASONS[err.code] : "invalid_video";
      await markFailed(deps, media, reason);
      log.warn("probe invalid media", { job_id: job.id, media_id: media.id, reason });
      return;
    }

    const thumbLocal = path.join(dir, "thumb.jpg");
    await makeThumbnail(deps.ffmpeg, local, thumbLocal, probe.durationMs);
    const thumbPath = thumbnailPathFor(media.storage_path);
    await storage.upload(thumbPath, thumbLocal, "image/jpeg");

    const compat = evaluateCompatibility(probe, ext);
    await db.query(
      `update public.media_assets
          set status = 'ready', failure_reason = null, duration_ms = $2, width = $3, height = $4, rotation = $5, fps = $6,
              video_codec = $7, audio_codec = $8, has_audio = $9, bitrate = $10, container = $11,
              thumbnail_path = $12, compatibility = $13, probed_at = now()
        where id = $1 and status = 'processing'`,
      [
        media.id,
        probe.durationMs,
        probe.width,
        probe.height,
        probe.rotation,
        probe.fps,
        probe.videoCodec,
        probe.audioCodec,
        probe.hasAudio,
        probe.bitrate,
        probe.container,
        thumbPath,
        JSON.stringify(compat),
      ],
    );
    await notifyBatchCompleted(deps, media);
    log.info("probe done", { job_id: job.id, media_id: media.id, duration_ms: probe.durationMs });
  } catch (err) {
    if (ctx.isFinalAttempt) await markFailed(deps, media, "processing_error");
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

async function markFailed(deps: Parameters<Handler>[1], media: MediaRow, reason: string) {
  await deps.db.query(
    "update public.media_assets set status = 'failed', failure_reason = $2 where id = $1 and status in ('uploaded', 'processing')",
    [media.id, reason],
  );
  if (media.uploaded_by) {
    await deps.db.query(
      "insert into public.notifications (workspace_id, user_id, type, payload) values ($1, $2, 'upload.failed', $3)",
      [media.workspace_id, media.uploaded_by, JSON.stringify({ media_id: media.id, name: media.name, reason })],
    );
  }
}

/**
 * Uma notificação por lote (não por vídeo): emitida quando o usuário não tem
 * mais vídeos pendentes no workspace, com a contagem desde a última.
 */
async function notifyBatchCompleted(deps: Parameters<Handler>[1], media: MediaRow) {
  if (!media.uploaded_by) return;
  await deps.db.query(
    `with pending as (
       select 1 from public.media_assets
        where workspace_id = $1 and uploaded_by = $2 and deleted_at is null
          and status in ('uploading', 'uploaded', 'processing')
        limit 1),
     last_notice as (
       select max(created_at) as at from public.notifications
        where workspace_id = $1 and user_id = $2 and type = 'upload.completed'),
     done as (
       select count(*)::int as n from public.media_assets, last_notice
        where workspace_id = $1 and uploaded_by = $2 and status = 'ready' and deleted_at is null
          and probed_at > coalesce(last_notice.at, '-infinity'))
     insert into public.notifications (workspace_id, user_id, type, payload)
     select $1, $2, 'upload.completed', jsonb_build_object('count', done.n)
       from done
      where not exists (select 1 from pending) and done.n > 0`,
    [media.workspace_id, media.uploaded_by],
  );
}
