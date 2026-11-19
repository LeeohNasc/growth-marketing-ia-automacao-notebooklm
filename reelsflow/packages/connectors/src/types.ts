/**
 * Contrato comum de publicação. Métodos de OAuth/contas (beginAuth,
 * completeAuth, listAccounts, refresh, revoke) entram na Fase 4 junto com o
 * primeiro conector real; nesta fase o contrato cobre publicar e consultar.
 */
export type ConnectorPlatform = "instagram" | "facebook" | "tiktok" | "youtube" | "mock";

export type Phase = "uploading" | "processing_remote" | "publishing";

export type PublishInput = {
  jobId: string;
  attemptNo: number;
  account: { id: string; platform: ConnectorPlatform; externalAccountId: string; settings: Record<string, unknown> };
  media: { storagePath: string; mimeType: string; sizeBytes: number; durationMs: number | null };
  caption: string;
  /** Checkpoint salvo em tentativa anterior (permite continuar sem refazer etapas). */
  checkpoint: Record<string, unknown> | null;
};

/**
 * O conector DEVE chamar `save` antes de cada efeito externo e logo após obter
 * identificadores externos. Se o worker morrer, o checkpoint permite
 * reconciliar em vez de publicar de novo.
 */
export interface CheckpointIO {
  save(phase: Phase, checkpoint: Record<string, unknown>): Promise<void>;
}

export type PublishResult = { externalId: string; permalink: string | null };

export type RemoteStatus =
  | { state: "published"; externalId: string; permalink: string | null }
  | { state: "processing" }
  | { state: "not_found" }
  | { state: "unknown" };

export type ErrorClass = "transient" | "rate_limited" | "auth" | "permanent" | "timeout" | "unknown";

export class ConnectorError extends Error {
  readonly errorClass: ErrorClass;
  readonly code?: string;
  readonly retryAfterSeconds?: number;
  /** true se a falha ocorreu depois de um efeito externo ter começado (pode ter publicado). */
  readonly sideEffectStarted: boolean;
  constructor(errorClass: ErrorClass, message: string, opts: { code?: string; retryAfterSeconds?: number; sideEffectStarted?: boolean } = {}) {
    super(message);
    this.name = "ConnectorError";
    this.errorClass = errorClass;
    this.code = opts.code;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.sideEffectStarted = opts.sideEffectStarted ?? false;
  }
}

export interface PublishConnector {
  readonly platform: ConnectorPlatform;
  publish(input: PublishInput, io: CheckpointIO): Promise<PublishResult>;
  getStatus(account: PublishInput["account"], checkpoint: Record<string, unknown>): Promise<RemoteStatus>;
}

/** Converte erro desconhecido em ConnectorError, preservando se houve efeito externo. */
export function toConnectorError(err: unknown, sideEffectStarted: boolean): ConnectorError {
  if (err instanceof ConnectorError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const isTimeout = /timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg);
  return new ConnectorError(isTimeout ? "timeout" : "unknown", msg, { sideEffectStarted });
}
