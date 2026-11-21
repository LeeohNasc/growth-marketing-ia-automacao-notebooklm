import { ConnectorError, type CheckpointIO, type PublishConnector, type PublishInput, type PublishResult, type RemoteStatus } from "../types";
import { classifyMetaError, type GraphClient } from "./graph";

type PhaseStatus = "complete" | "completed" | "in_progress" | "not_started" | "error";
type VideoStatus = {
  status?: {
    video_status?: string;
    uploading_phase?: { status?: PhaseStatus; bytes_transfered?: number };
    processing_phase?: { status?: PhaseStatus; error?: { message?: string } };
    publishing_phase?: { status?: PhaseStatus; publish_status?: "draft" | "error" | "published" | "scheduled" };
  };
};

const done = (s?: PhaseStatus) => s === "complete" || s === "completed"; // a doc usa as duas grafias

export type FacebookOptions = { pollIntervalMs?: number; pollBudgetMs?: number; sleep?: (ms: number) => Promise<void> };

/**
 * Facebook Reels em Páginas (Reels Publishing API, v27.0), com token de Página:
 * 1. POST /{page-id}/video_reels upload_phase=start → video_id (checkpoint);
 * 2. upload em rupload.facebook.com com cabeçalho `file_url` (vídeo hospedado; URL assinada temporária);
 * 3. checkpoint "publishing" → POST /{page-id}/video_reels upload_phase=finish, video_state=PUBLISHED.
 * Não há chave de idempotência: falha incerta no passo 3 → reconciliação por GET /{video-id}?fields=status.
 */
export class FacebookConnector implements PublishConnector {
  readonly platform = "facebook" as const;
  private readonly pollIntervalMs: number;
  private readonly pollBudgetMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly graph: GraphClient, opts: FacebookOptions = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 10_000;
    this.pollBudgetMs = opts.pollBudgetMs ?? 2 * 60_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private token(input: Pick<PublishInput, "credentials">) {
    const t = input.credentials?.accessToken;
    if (!t) throw new ConnectorError("auth", "Conta sem credenciais. Reconecte a conta.", { code: "missing_token" });
    return t;
  }

  private status(videoId: string, token: string) {
    return this.graph.request<VideoStatus>("GET", videoId, { token, params: { fields: "status" } });
  }

  async publish(input: PublishInput, io: CheckpointIO): Promise<PublishResult> {
    if (input.media.mimeType.startsWith("image/")) {
      throw new ConnectorError("permanent", "Imagem não suportada: o conector direto do Facebook publica apenas Reels (vídeo). Use uma conta conectada via Zernio para imagens.", { code: "fb_image_unsupported" });
    }
    const token = this.token(input);
    const pageId = input.account.externalAccountId;
    let videoId = typeof input.checkpoint?.video_id === "string" ? input.checkpoint.video_id : null;
    let uploaded = false;

    try {
      if (videoId) {
        const st = (await this.status(videoId, token)).status;
        if (st?.publishing_phase?.publish_status === "published") return { externalId: videoId, permalink: await this.permalink(videoId, token) };
        if (st?.video_status === "upload_failed" || st?.video_status === "error" || st?.video_status === "expired") videoId = null;
        else uploaded = done(st?.uploading_phase?.status);
      }
      if (!videoId) {
        const started = await this.graph.request<{ video_id: string; upload_url?: string }>("POST", `${pageId}/video_reels`, { token, params: { upload_phase: "start" } });
        videoId = started.video_id;
        await io.save("uploading", { video_id: videoId });
      }
      if (!uploaded) {
        if (!input.media.url) throw new ConnectorError("transient", "URL temporária do vídeo indisponível.", { code: "media_url" });
        await this.graph.request<{ success: boolean }>("POST", `video-upload/${this.graph.version}/${videoId}`, {
          rawUrl: `https://rupload.facebook.com/video-upload/${this.graph.version}/${videoId}`,
          headers: { Authorization: `OAuth ${token}`, file_url: input.media.url },
        });
      }
      await io.save("processing_remote", { video_id: videoId });
    } catch (e) {
      throw classifyMetaError(e, false);
    }

    await io.save("publishing", { video_id: videoId });
    try {
      await this.graph.request<{ success: boolean }>("POST", `${pageId}/video_reels`, {
        token,
        params: { upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", description: input.caption },
      });
    } catch (e) {
      const err = classifyMetaError(e, true);
      if (err.errorClass === "rate_limited" || err.errorClass === "auth" || err.errorClass === "permanent") {
        throw new ConnectorError(err.errorClass, err.message, { code: err.code, retryAfterSeconds: err.retryAfterSeconds, sideEffectStarted: false });
      }
      throw err;
    }

    // A publicação é assíncrona após o finish: acompanha até o orçamento; se ainda processando, a reconciliação conclui.
    const deadline = Date.now() + this.pollBudgetMs;
    for (;;) {
      let st: VideoStatus["status"];
      try {
        st = (await this.status(videoId, token)).status;
      } catch (e) {
        throw classifyMetaError(e, true);
      }
      if (st?.publishing_phase?.publish_status === "published") return { externalId: videoId, permalink: await this.permalink(videoId, token) };
      if (st?.processing_phase?.status === "error" || st?.publishing_phase?.publish_status === "error") {
        throw new ConnectorError("permanent", st.processing_phase?.error?.message ?? "O Facebook rejeitou o vídeo no processamento.", { code: "fb_processing_error", sideEffectStarted: false });
      }
      if (Date.now() >= deadline) throw new ConnectorError("unknown", "Reel enviado; aguardando confirmação do Facebook.", { code: "fb_pending", sideEffectStarted: true });
      await this.sleep(this.pollIntervalMs);
    }
  }

  /** `permalink_url` do vídeo (campo não listado na página de Reels consultada; best-effort). */
  private async permalink(videoId: string, token: string): Promise<string | null> {
    try {
      const r = await this.graph.request<{ permalink_url?: string }>("GET", videoId, { token, params: { fields: "permalink_url" } });
      if (!r.permalink_url) return null;
      return r.permalink_url.startsWith("http") ? r.permalink_url : `https://www.facebook.com${r.permalink_url}`;
    } catch {
      return null;
    }
  }

  async getStatus(_account: PublishInput["account"], checkpoint: Record<string, unknown>, credentials?: PublishInput["credentials"]): Promise<RemoteStatus> {
    const videoId = typeof checkpoint.video_id === "string" ? checkpoint.video_id : null;
    if (!videoId) return { state: "not_found" };
    try {
      const token = this.token({ credentials });
      const st = (await this.status(videoId, token)).status;
      const pub = st?.publishing_phase?.publish_status;
      if (pub === "published") return { state: "published", externalId: videoId, permalink: await this.permalink(videoId, token) };
      if (pub === "error" || st?.processing_phase?.status === "error" || st?.video_status === "upload_failed" || st?.video_status === "expired") return { state: "not_found" };
      if (st?.video_status === "processing" || st?.publishing_phase?.status === "in_progress") return { state: "processing" };
      // Upload feito, mas nunca finalizado como publicado.
      if (pub === "draft" || pub === undefined) return { state: "not_found" };
      return { state: "unknown" };
    } catch {
      return { state: "unknown" };
    }
  }
}
