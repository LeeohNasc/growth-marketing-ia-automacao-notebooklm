import { ConnectorError, type CheckpointIO, type PublishConnector, type PublishInput, type PublishResult, type RemoteStatus } from "../types";
import { classifyMetaError, type GraphClient } from "./graph";
import { INSTAGRAM_GRAPH_HOST } from "./instagram-login";

type ContainerStatus = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

export type InstagramOptions = {
  /** Intervalo entre consultas do container. A doc recomenda 1×/min por até 5 min. */
  pollIntervalMs?: number;
  /**
   * Tempo esperando o processamento NESTA tentativa. Depois, a tentativa termina com
   * `ig_processing` e o worker volta em ~1 min retomando o MESMO container (checkpoint),
   * sem gastar tentativa. Na Edge Function o limite de tempo por execução exige valor curto.
   */
  pollBudgetMs?: number;
  /** Prazo total de processamento de um container antes de desistir (padrão 30 min). */
  processingDeadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Instagram Reels via **Instagram API with Instagram Login** (graph.instagram.com, v27.0).
 * Permissões: instagram_business_basic + instagram_business_content_publish. Sem Página do Facebook.
 *
 * 0. confere que o token é da conta de destino (GET /me → user_id == conta selecionada);
 * 1. checa cota (content_publishing_limit);
 * 2. cria container (media_type=REELS, video_url público) → checkpoint {container_id};
 * 3. aguarda status_code=FINISHED (retoma o mesmo container entre tentativas);
 * 4. checkpoint fase "publishing" → media_publish(creation_id).
 * A doc não garante idempotência de media_publish: após falha incerta, consulta-se o
 * container (PUBLISHED = já publicado) em vez de publicar de novo.
 */
export class InstagramConnector implements PublishConnector {
  readonly platform = "instagram" as const;
  private readonly pollIntervalMs: number;
  private readonly pollBudgetMs: number;
  private readonly processingDeadlineMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly graph: GraphClient, opts: InstagramOptions = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 15_000;
    this.pollBudgetMs = opts.pollBudgetMs ?? 5 * 60_000;
    this.processingDeadlineMs = opts.processingDeadlineMs ?? 30 * 60_000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
  }

  private get<T>(path: string, token: string, params: Record<string, string | number>) {
    return this.graph.request<T>("GET", path, { host: INSTAGRAM_GRAPH_HOST, token, auth: "query", params });
  }

  private post<T>(path: string, token: string, params: Record<string, string | number | boolean | undefined>) {
    return this.graph.request<T>("POST", path, { host: INSTAGRAM_GRAPH_HOST, token, auth: "bearer", params });
  }

  private token(input: Pick<PublishInput, "credentials">): string {
    const t = input.credentials?.accessToken;
    if (!t) throw new ConnectorError("auth", "Conta sem credenciais. Reconecte a conta.", { code: "missing_token" });
    return t;
  }

  private containerStatus(id: string, token: string) {
    return this.get<{ status_code: ContainerStatus; status?: string }>(id, token, { fields: "status_code,status" });
  }

  /** Garante que o token pertence à conta selecionada: nunca publicar em outra conta. */
  private async assertIdentity(igUser: string, token: string) {
    const r = await this.get<Record<string, unknown> & { data?: Record<string, unknown>[] }>("me", token, { fields: "user_id,username" });
    const me = (Array.isArray(r.data) ? r.data[0] : r) ?? {};
    const id = me.user_id ?? me.id;
    if (id === undefined || String(id) !== igUser) {
      throw new ConnectorError("permanent", "O token armazenado não pertence à conta de destino. Nada foi publicado; reconecte a conta.", {
        code: "ig_account_mismatch",
      });
    }
  }

  async publish(input: PublishInput, io: CheckpointIO): Promise<PublishResult> {
    const token = this.token(input);
    const igUser = input.account.externalAccountId;
    let containerId = typeof input.checkpoint?.container_id === "string" ? input.checkpoint.container_id : null;
    let createdAt = typeof input.checkpoint?.container_created_at === "number" ? input.checkpoint.container_created_at : this.now();

    try {
      await this.assertIdentity(igUser, token);

      // Retomada: o container de uma tentativa anterior pode estar pronto, em processamento ou já publicado.
      let known: { status_code: ContainerStatus; status?: string } | null = null;
      if (containerId) {
        const st = await this.containerStatus(containerId, token);
        if (st.status_code === "PUBLISHED") return await this.resolvePublished(igUser, token, input.checkpoint, input.caption);
        if (st.status_code === "EXPIRED" || st.status_code === "ERROR") containerId = null;
        else known = st; // reaproveitado como primeira leitura do laço abaixo
      }

      if (!containerId) {
        const quota = await this.get<{ data?: { quota_usage?: number; config?: { quota_total?: number } }[] }>(`${igUser}/content_publishing_limit`, token, {
          fields: "quota_usage,config",
        });
        const q = quota.data?.[0];
        if (q?.config?.quota_total !== undefined && q.quota_usage !== undefined && q.quota_usage >= q.config.quota_total) {
          throw new ConnectorError("rate_limited", `Limite de publicações do Instagram atingido (${q.quota_usage}/${q.config.quota_total} em 24 h).`, {
            code: "ig_quota",
            retryAfterSeconds: 3600,
          });
        }
        if (!input.media.url) throw new ConnectorError("transient", "URL temporária do vídeo indisponível.", { code: "media_url" });
        // Criar container não publica nada: no pior caso fica um container órfão que expira em 24 h.
        const created = await this.post<{ id: string }>(`${igUser}/media`, token, {
          media_type: "REELS",
          video_url: input.media.url,
          caption: input.caption || undefined,
          share_to_feed: true,
        });
        containerId = created.id;
        createdAt = this.now();
      }
      await io.save("processing_remote", { container_id: containerId, container_created_at: createdAt });

      // Aguarda o processamento do vídeo pela Meta.
      const deadline = this.now() + this.pollBudgetMs;
      for (;;) {
        const st = known ?? (await this.containerStatus(containerId, token));
        known = null;
        if (st.status_code === "FINISHED") break;
        if (st.status_code === "PUBLISHED") return await this.resolvePublished(igUser, token, { container_id: containerId }, input.caption);
        if (st.status_code === "ERROR") {
          throw new ConnectorError("permanent", `O Instagram rejeitou o vídeo no processamento${st.status ? ` (${st.status})` : ""}.`, { code: "ig_container_error" });
        }
        if (st.status_code === "EXPIRED") throw new ConnectorError("transient", "Container expirado; será recriado.", { code: "ig_container_expired" });
        if (this.now() - createdAt > this.processingDeadlineMs) {
          throw new ConnectorError("permanent", "O Instagram não terminou de processar o vídeo em 30 minutos.", { code: "ig_processing_timeout" });
        }
        if (this.now() >= deadline) {
          throw new ConnectorError("transient", "O Instagram ainda está processando o vídeo; nova verificação em instantes.", { code: "ig_processing", retryAfterSeconds: 60 });
        }
        await this.sleep(this.pollIntervalMs);
      }
    } catch (e) {
      throw classifyMetaError(e, false);
    }

    // Passo que publica: a partir daqui, falha sem resposta clara = estado incerto (reconciliação).
    const requestedAt = new Date(this.now()).toISOString();
    await io.save("publishing", { container_id: containerId, container_created_at: createdAt, publish_requested_at: requestedAt });
    let mediaId: string;
    try {
      const r = await this.post<{ id: string }>(`${igUser}/media_publish`, token, { creation_id: containerId });
      mediaId = r.id;
    } catch (e) {
      const err = classifyMetaError(e, true);
      // Limite, autenticação e rejeição explícita significam que NÃO publicou.
      if (err.errorClass === "rate_limited" || err.errorClass === "auth" || err.errorClass === "permanent") {
        throw new ConnectorError(err.errorClass, err.message, { code: err.code, retryAfterSeconds: err.retryAfterSeconds, sideEffectStarted: false });
      }
      throw err;
    }
    return { externalId: mediaId, permalink: await this.permalink(mediaId, token) };
  }

  /** `permalink` do IG Media ("Permanent URL to the media"). Melhor esforço: o ID já prova a publicação. */
  private async permalink(mediaId: string, token: string): Promise<string | null> {
    try {
      const r = await this.get<{ permalink?: string }>(mediaId, token, { fields: "permalink" });
      return r.permalink ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Container PUBLISHED sem o ID da mídia (falha após media_publish): localiza o Reel entre os
   * mais recentes do perfil, publicado depois do pedido e, se possível, com a mesma legenda.
   */
  private async resolvePublished(igUser: string, token: string, checkpoint: Record<string, unknown> | null, caption?: string): Promise<PublishResult> {
    const since = typeof checkpoint?.publish_requested_at === "string" ? Date.parse(checkpoint.publish_requested_at) - 120_000 : 0;
    try {
      const r = await this.get<{ data: { id: string; permalink?: string; timestamp?: string; caption?: string; media_product_type?: string }[] }>(`${igUser}/media`, token, {
        fields: "id,permalink,timestamp,caption,media_product_type",
        limit: 10,
      });
      const recent = r.data.filter((m) => (!m.timestamp || Date.parse(m.timestamp) >= since) && (!m.media_product_type || m.media_product_type === "REELS"));
      const hit = (caption ? recent.find((m) => (m.caption ?? "") === caption) : undefined) ?? (recent.length === 1 ? recent[0] : undefined);
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
