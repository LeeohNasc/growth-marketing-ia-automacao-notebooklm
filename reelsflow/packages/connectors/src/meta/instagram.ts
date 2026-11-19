import { ConnectorError, type CheckpointIO, type PublishConnector, type PublishInput, type PublishResult, type RemoteStatus } from "../types";
import { classifyMetaError, type GraphClient } from "./graph";

type ContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

export type InstagramOptions = {
  /** Intervalo entre consultas do container (doc: ~1/min; padrão menor para vídeos curtos). */
  pollIntervalMs?: number;
  /** Tempo máximo esperando o processamento numa tentativa (doc: até 5 min). Depois, retoma na próxima tentativa. */
  pollBudgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Instagram Reels via "Instagram API with Facebook Login" (Graph API v27.0):
 * 1. checa cota (content_publishing_limit);
 * 2. cria container (media_type=REELS, video_url público) → checkpoint {container_id};
 * 3. aguarda status_code=FINISHED;
 * 4. checkpoint fase "publishing" → media_publish(creation_id).
 * A doc NÃO garante idempotência de media_publish; após falha incerta, consulta-se
 * o container (PUBLISHED = já publicado), como a própria doc recomenda.
 */
export class InstagramConnector implements PublishConnector {
  readonly platform = "instagram" as const;
  private readonly pollIntervalMs: number;
  private readonly pollBudgetMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly graph: GraphClient, opts: InstagramOptions = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 15_000;
    this.pollBudgetMs = opts.pollBudgetMs ?? 5 * 60_000;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private token(input: Pick<PublishInput, "credentials">): string {
    const t = input.credentials?.accessToken;
    if (!t) throw new ConnectorError("auth", "Conta sem credenciais. Reconecte a conta.", { code: "missing_token" });
    return t;
  }

  private async containerStatus(id: string, token: string) {
    return this.graph.request<{ status_code: ContainerStatus; status?: string }>("GET", id, { token, params: { fields: "status_code,status" } });
  }

  async publish(input: PublishInput, io: CheckpointIO): Promise<PublishResult> {
    const token = this.token(input);
    const igUser = input.account.externalAccountId;
    let containerId = typeof input.checkpoint?.container_id === "string" ? input.checkpoint.container_id : null;

    try {
      // Retomada: o container de uma tentativa anterior pode já estar pronto ou até publicado.
      if (containerId) {
        const st = await this.containerStatus(containerId, token);
        if (st.status_code === "PUBLISHED") return await this.resolvePublished(igUser, token, input.checkpoint);
        if (st.status_code === "EXPIRED" || st.status_code === "ERROR") containerId = null;
      }

      if (!containerId) {
        const quota = await this.graph.request<{ data: { quota_usage: number; config?: { quota_total: number } }[] }>("GET", `${igUser}/content_publishing_limit`, {
          token,
          params: { fields: "quota_usage,config" },
        });
        const q = quota.data[0];
        if (q && q.config && q.quota_usage >= q.config.quota_total) {
          throw new ConnectorError("rate_limited", `Cota de publicações do Instagram atingida (${q.quota_usage}/${q.config.quota_total} em 24 h).`, {
            code: "ig_quota",
            retryAfterSeconds: 3600,
          });
        }
        if (!input.media.url) throw new ConnectorError("transient", "URL temporária do vídeo indisponível.", { code: "media_url" });
        // Criar container não publica nada: se falhar no meio, o pior caso é um container órfão que expira em 24 h.
        const created = await this.graph.request<{ id: string }>("POST", `${igUser}/media`, {
          token,
          params: { media_type: "REELS", video_url: input.media.url, caption: input.caption, share_to_feed: true },
        });
        containerId = created.id;
        await io.save("processing_remote", { container_id: containerId });
      } else {
        await io.save("processing_remote", { container_id: containerId });
      }

      // Aguarda o processamento do vídeo pela Meta.
      const deadline = Date.now() + this.pollBudgetMs;
      for (;;) {
        const st = await this.containerStatus(containerId, token);
        if (st.status_code === "FINISHED") break;
        if (st.status_code === "PUBLISHED") return await this.resolvePublished(igUser, token, { container_id: containerId });
        if (st.status_code === "ERROR") {
          throw new ConnectorError("permanent", `O Instagram rejeitou o vídeo no processamento${st.status ? ` (${st.status})` : ""}.`, { code: "ig_container_error" });
        }
        if (st.status_code === "EXPIRED") throw new ConnectorError("transient", "Container expirado; será recriado.", { code: "ig_container_expired" });
        if (Date.now() >= deadline) {
          throw new ConnectorError("transient", "O Instagram ainda está processando o vídeo; nova verificação em instantes.", { code: "ig_processing", retryAfterSeconds: 60 });
        }
        await this.sleep(this.pollIntervalMs);
      }
    } catch (e) {
      throw classifyMetaError(e, false);
    }

    // Passo que publica: a partir daqui, falha sem resposta clara = estado incerto.
    const requestedAt = new Date().toISOString();
    await io.save("publishing", { container_id: containerId, publish_requested_at: requestedAt });
    let mediaId: string;
    try {
      const r = await this.graph.request<{ id: string }>("POST", `${igUser}/media_publish`, { token, params: { creation_id: containerId } });
      mediaId = r.id;
    } catch (e) {
      const err = classifyMetaError(e, true);
      // Limite de publicação, auth e rejeição explícita significam que NÃO publicou.
      if (err.errorClass === "rate_limited" || err.errorClass === "auth" || err.errorClass === "permanent") {
        throw new ConnectorError(err.errorClass, err.message, { code: err.code, retryAfterSeconds: err.retryAfterSeconds, sideEffectStarted: false });
      }
      throw err;
    }
    return { externalId: mediaId, permalink: await this.permalink(mediaId, token) };
  }

  /** `permalink` do IG Media (campo não listado nas páginas de publicação consultadas; best-effort). */
  private async permalink(mediaId: string, token: string): Promise<string | null> {
    try {
      const r = await this.graph.request<{ permalink?: string }>("GET", mediaId, { token, params: { fields: "permalink" } });
      return r.permalink ?? null;
    } catch {
      return null;
    }
  }

  /** Container PUBLISHED: localiza o media publicado entre os mais recentes do perfil. */
  private async resolvePublished(igUser: string, token: string, checkpoint: Record<string, unknown> | null): Promise<PublishResult> {
    const since = typeof checkpoint?.publish_requested_at === "string" ? Date.parse(checkpoint.publish_requested_at) - 120_000 : 0;
    try {
      const r = await this.graph.request<{ data: { id: string; permalink?: string; timestamp?: string }[] }>("GET", `${igUser}/media`, {
        token,
        params: { fields: "id,permalink,timestamp", limit: 10 },
      });
      const hit = r.data.find((m) => !m.timestamp || Date.parse(m.timestamp) >= since);
      if (hit) return { externalId: hit.id, permalink: hit.permalink ?? null };
    } catch {
      /* sem detalhes: ainda assim está publicado */
    }
    return { externalId: `container:${String(checkpoint?.container_id ?? "")}`, permalink: null };
  }

  async getStatus(account: PublishInput["account"], checkpoint: Record<string, unknown>, credentials?: PublishInput["credentials"]): Promise<RemoteStatus> {
    const containerId = typeof checkpoint.container_id === "string" ? checkpoint.container_id : null;
    if (!containerId) return { state: "not_found" };
    try {
      const token = this.token({ credentials });
      const st = await this.containerStatus(containerId, token);
      if (st.status_code === "PUBLISHED") {
        const r = await this.resolvePublished(account.externalAccountId, token, checkpoint);
        return { state: "published", externalId: r.externalId, permalink: r.permalink };
      }
      if (st.status_code === "IN_PROGRESS") return { state: "processing" };
      // FINISHED (não publicado), ERROR, EXPIRED: a publicação não ocorreu → retry seguro.
      return { state: "not_found" };
    } catch {
      return { state: "unknown" };
    }
  }
}
