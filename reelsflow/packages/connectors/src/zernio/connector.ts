import { ConnectorError, type CheckpointIO, type PublishConnector, type PublishInput, type PublishResult, type RemoteStatus } from "../types";
import { ZernioApiError, zernioId, type ZernioClient, type ZernioPlatform, type ZernioPost, type ZernioPostTarget } from "./client";

/**
 * Publicação pela Zernio (POST /v1/posts com publishNow). O ReelsFlow continua dono do calendário:
 * no horário, o worker pede a publicação imediata; a Zernio publica na rede e devolve o resultado.
 *
 * Garantias contra duplicação:
 *  1. `Idempotency-Key` e `externalId` = "reelsflow-job-<id da publicação>", estáveis entre tentativas:
 *     repetir o pedido em 24 h devolve o MESMO post (HTTP 200), nunca um segundo;
 *  2. checkpoint salvo ANTES do pedido; depois, o id do post Zernio;
 *  3. com o id salvo, novas tentativas só CONSULTAM o post (ou pedem /retry das plataformas que falharam);
 *  4. falha sem resposta no pedido → "incerto" → reconciliação por externalId.
 * Antes do primeiro pedido, confere que a conta pertence ao perfil Zernio vinculado ao workspace.
 */
export type ZernioConnectorOptions = {
  /** Espera pelo resultado dentro da tentativa (a Edge Function tem limite de tempo). */
  pollBudgetMs?: number;
  pollIntervalMs?: number;
  /** Prazo total sem resultado definitivo; depois vira "incerto" (reconciliação), nunca falha cega. */
  processingDeadlineMs?: number;
  /** Máximo de /retry automáticos para falhas transitórias da plataforma/Zernio. */
  maxRemoteRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** Categorias de falha que a própria Zernio documenta como transitórias (seguras para /retry). */
const TRANSIENT_CATEGORIES = new Set(["platform_error", "platform_rate_limit", "quota_exhausted", "system_error"]);
const AUTH_CATEGORIES = new Set(["auth_expired", "account_issue"]);
const PENDING_STATES = new Set(["pending", "processing", "uploading", "publishing", "scheduled"]);

export const zernioJobKey = (jobId: string) => `reelsflow-job-${jobId}`;

type Checkpoint = {
  provider: "zernio";
  idempotency_key: string;
  zernio_post_id?: string;
  requested_at?: number;
  remote_retries?: number;
};

export class ZernioConnector implements PublishConnector {
  readonly platform = "zernio" as const;
  private readonly pollBudgetMs: number;
  private readonly pollIntervalMs: number;
  private readonly processingDeadlineMs: number;
  private readonly maxRemoteRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly client: ZernioClient, opts: ZernioConnectorOptions = {}) {
    this.pollBudgetMs = opts.pollBudgetMs ?? 60_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 10_000;
    this.processingDeadlineMs = opts.processingDeadlineMs ?? 6 * 3600_000;
    this.maxRemoteRetries = opts.maxRemoteRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  async publish(input: PublishInput, io: CheckpointIO): Promise<PublishResult> {
    const key = zernioJobKey(input.jobId);
    const prev = (input.checkpoint ?? {}) as Partial<Checkpoint>;
    let cp: Checkpoint = { provider: "zernio", idempotency_key: key, ...prev };
    const platform = input.account.platform as ZernioPlatform;
    const isImage = input.media.mimeType.startsWith("image/");
    if (isImage && platform !== "instagram" && platform !== "facebook") {
      throw new ConnectorError("permanent", "Imagens só são publicadas no Instagram e no Facebook. Nada foi publicado.", { code: "zernio_image_platform" });
    }

    let post: ZernioPost;
    if (cp.zernio_post_id) {
      // Já pedimos antes: só consultar (nunca criar outro).
      post = await this.call(() => this.client.getPost(cp.zernio_post_id!), false);
    } else {
      await this.assertAccount(input);
      if (!input.media.url) throw new ConnectorError("transient", "URL temporária do vídeo indisponível.", { code: "media_url" });
      // Checkpoint ANTES do efeito externo.
      cp = { ...cp, requested_at: cp.requested_at ?? this.now() };
      await io.save("publishing", cp);
      post = await this.call(
        () =>
          this.client.createPost(
            {
              content: input.caption || undefined,
              // Imagem (ex.: Card Editorial) vira post de feed; vídeo vira Reel (shareToFeed só vale para Reels).
              mediaItems: [{ type: isImage ? "image" : "video", url: input.media.url! }],
              platforms: [
                {
                  platform,
                  accountId: input.account.externalAccountId,
                  ...(platform === "instagram" && !isImage ? { platformSpecificData: { shareToFeed: true } } : {}),
                },
              ],
              profileId: input.account.providerProfileId ?? undefined,
              publishNow: true,
              externalId: key,
            },
            key,
          ),
        true,
      );
      cp = { ...cp, zernio_post_id: post._id };
      await io.save("publishing", cp);
    }

    // Acompanha o resultado dentro do orçamento desta tentativa.
    const deadline = this.now() + this.pollBudgetMs;
    for (;;) {
      const target = this.target(post, input.account.externalAccountId);
      const outcome = await this.evaluate(post, target, cp, io);
      if (outcome.kind === "published") return outcome.result;
      if (outcome.kind === "retried") {
        cp = outcome.cp;
        post = outcome.post ?? post;
      }
      if (this.now() - (cp.requested_at ?? this.now()) > this.processingDeadlineMs) {
        // Pode publicar mais tarde: não declarar falha; a reconciliação acompanha.
        throw new ConnectorError("unknown", "A Zernio ainda não confirmou a publicação; acompanhamento continua pela reconciliação.", {
          code: "zernio_unresolved",
          sideEffectStarted: true,
        });
      }
      if (this.now() >= deadline) {
        throw new ConnectorError("transient", target?.errorMessage ? `Aguardando a Zernio: ${target.errorMessage}` : "Publicação em andamento na Zernio; nova verificação em instantes.", {
          code: "zernio_processing",
          retryAfterSeconds: 60,
        });
      }
      await this.sleep(this.pollIntervalMs);
      post = await this.call(() => this.client.getPost(cp.zernio_post_id!), false);
    }
  }

  /** Conta existe, está ativa, é da plataforma certa e pertence ao perfil vinculado ao workspace. */
  private async assertAccount(input: PublishInput) {
    if (!input.account.providerProfileId) {
      throw new ConnectorError("permanent", "Conta Zernio sem perfil vinculado. Nada foi publicado.", { code: "zernio_profile_missing" });
    }
    const acc = await this.call(() => this.client.getAccount(input.account.externalAccountId), false);
    if (zernioId(acc.profileId) !== input.account.providerProfileId || acc.platform !== input.account.platform) {
      throw new ConnectorError("permanent", "A conta na Zernio não pertence ao perfil deste workspace. Nada foi publicado.", { code: "zernio_account_mismatch" });
    }
    if (acc.isActive === false) throw new ConnectorError("auth", "Conta desativada na Zernio. Reconecte a conta.", { code: "zernio_account_inactive" });
  }

  private target(post: ZernioPost, accountId: string): ZernioPostTarget | undefined {
    return post.platforms?.find((t) => zernioId(t.accountId) === accountId) ?? (post.platforms?.length === 1 ? post.platforms[0] : undefined);
  }

  private async evaluate(
    post: ZernioPost,
    target: ZernioPostTarget | undefined,
    cp: Checkpoint,
    io: CheckpointIO,
  ): Promise<{ kind: "published"; result: PublishResult } | { kind: "pending" } | { kind: "retried"; cp: Checkpoint; post: ZernioPost | null }> {
    const st = target?.status ?? (post.status === "published" ? "published" : post.status);
    if (st === "published") {
      return { kind: "published", result: { externalId: target?.platformPostId || `zernio:${post._id}`, permalink: target?.platformPostUrl || null } };
    }
    if (st === "cancelled" || post.status === "cancelled") {
      throw new ConnectorError("permanent", "O post foi cancelado na Zernio. Nada foi publicado.", { code: "zernio_cancelled" });
    }
    if (st === "failed" || post.status === "failed") {
      const cat = target?.errorCategory ?? "unknown";
      const msg = target?.errorMessage ? `Instagram/Zernio: ${target.errorMessage}` : "A Zernio informou falha na publicação.";
      if (AUTH_CATEGORIES.has(cat)) throw new ConnectorError("auth", `${msg} Reconecte a conta na Zernio.`, { code: `zernio_${cat}` });
      if (TRANSIENT_CATEGORIES.has(cat) && (cp.remote_retries ?? 0) < this.maxRemoteRetries) {
        // Reexecuta SÓ a plataforma que falhou, no mesmo post (sem criar outro).
        const next = { ...cp, remote_retries: (cp.remote_retries ?? 0) + 1 };
        await io.save("publishing", next);
        const again = await this.call(() => this.client.retryPost(post._id), false);
        return { kind: "retried", cp: next, post: again };
      }
      throw new ConnectorError("permanent", msg, { code: `zernio_${cat}` });
    }
    if (PENDING_STATES.has(st) || post.status === "partial") return { kind: "pending" };
    return { kind: "pending" };
  }

  /** Converte erros HTTP da Zernio. `sideEffect`: a chamada pode ter criado o post. */
  private async call<T>(fn: () => Promise<T>, sideEffect: boolean): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw classifyZernioError(e, sideEffect);
    }
  }

  async getStatus(account: PublishInput["account"], checkpoint: Record<string, unknown>): Promise<RemoteStatus> {
    const cp = checkpoint as Partial<Checkpoint>;
    try {
      const post = cp.zernio_post_id
        ? await this.client.getPost(cp.zernio_post_id)
        : cp.idempotency_key
          ? await this.client.findPostByExternalId(cp.idempotency_key)
          : null;
      if (!post) return { state: "not_found" };
      const t = this.target(post, account.externalAccountId);
      const st = t?.status ?? post.status;
      if (st === "published") return { state: "published", externalId: t?.platformPostId || `zernio:${post._id}`, permalink: t?.platformPostUrl || null };
      // Falhou/cancelado de forma definitiva: não publicou; repetir usa a mesma chave (não duplica).
      if (st === "failed" || st === "cancelled") return { state: "not_found" };
      return { state: "processing" };
    } catch {
      return { state: "unknown" };
    }
  }
}

export function classifyZernioError(e: unknown, sideEffect: boolean): ConnectorError {
  if (e instanceof ConnectorError) return e;
  if (!(e instanceof ZernioApiError)) {
    return new ConnectorError(sideEffect ? "unknown" : "transient", e instanceof Error ? e.message : String(e), { sideEffectStarted: sideEffect });
  }
  const tag = `zernio_${e.code ?? e.status}`;
  const opts = { code: tag, retryAfterSeconds: e.retryAfterSeconds ?? undefined };
  // Rede/timeout/5xx no pedido que publica: pode ter criado → incerto (reconciliação + mesma chave).
  if (e.status === 0 || e.status >= 500) {
    return sideEffect ? new ConnectorError(e.type === "timeout" ? "timeout" : "unknown", e.message, { ...opts, sideEffectStarted: true }) : new ConnectorError("transient", e.message, opts);
  }
  if (e.status === 429) return new ConnectorError("rate_limited", e.message, { ...opts, retryAfterSeconds: e.retryAfterSeconds ?? 60 });
  if (e.status === 409 && e.code === "idempotency_conflict") {
    // O mesmo pedido ainda está sendo processado na Zernio: esperar e repetir devolve o post original.
    return new ConnectorError("transient", e.message, { ...opts, retryAfterSeconds: e.retryAfterSeconds ?? 30 });
  }
  if (e.status === 409 && e.code === "duplicate_content") {
    return new ConnectorError("permanent", "Este vídeo com a mesma legenda já foi enviado a esta conta nas últimas 24 h. Nada foi publicado de novo.", opts);
  }
  // Chave da Zernio inválida/revogada: problema de configuração do ReelsFlow, NÃO da conta do usuário.
  if (e.status === 401) return new ConnectorError("transient", "Chave da Zernio inválida ou ausente no servidor.", { ...opts, code: "zernio_api_key", retryAfterSeconds: 900 });
  if (e.status === 402) return new ConnectorError("transient", "A Zernio exige pagamento para esta operação (limite do plano).", { ...opts, retryAfterSeconds: 3600 });
  if (e.status === 403 && /DISCONNECTED|disconnected/.test(`${e.code} ${e.message}`)) return new ConnectorError("auth", "Conta desconectada na Zernio. Reconecte a conta.", opts);
  if (e.status === 404) return new ConnectorError("auth", "Conta ou post não encontrado na Zernio.", opts);
  return new ConnectorError("permanent", e.message, opts);
}
