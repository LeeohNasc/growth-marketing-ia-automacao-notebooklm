import { ConnectorError, type CheckpointIO, type PublishConnector, type PublishInput, type PublishResult, type RemoteStatus } from "./types";

/**
 * "Plataforma" simulada persistida (implementada pelo worker em Postgres), para
 * que a reconciliação funcione entre reinícios como numa API real.
 */
export interface MockPlatformStore {
  createUpload(accountId: string, uploadRef: string, caption: string): Promise<string>;
  publish(uploadRef: string): Promise<void>;
  find(uploadRef: string): Promise<{ id: string; status: "processing" | "published" } | null>;
}

export const MOCK_BEHAVIORS = [
  "success",
  "slow",
  "flaky",
  "transient",
  "permanent",
  "timeout_before",
  "timeout_after",
  "rate_limit",
  "auth_revoked",
  "uncertain",
] as const;
export type MockBehavior = (typeof MOCK_BEHAVIORS)[number];

export const MOCK_BEHAVIOR_LABELS: Record<MockBehavior, string> = {
  success: "Sempre publica",
  slow: "Publica com atraso",
  flaky: "Falha temporária na 1ª tentativa",
  transient: "Sempre falha temporariamente",
  permanent: "Rejeita a publicação",
  timeout_before: "Tempo esgotado antes de enviar",
  timeout_after: "Publica, mas a resposta se perde",
  rate_limit: "Limite de requisições na 1ª tentativa",
  auth_revoked: "Autorização revogada",
  uncertain: "Resultado nunca confirmado",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Conector simulado: não acessa nenhum serviço externo. O comportamento vem de
 * `account.settings.mock_behavior` para exercitar cada cenário de falha.
 * Como algumas APIs reais, NÃO oferece idempotência: um retry cego após
 * "timeout_after" duplicaria a publicação — é isso que a reconciliação evita.
 */
export class MockConnector implements PublishConnector {
  readonly platform = "mock" as const;
  constructor(private readonly store: MockPlatformStore, private readonly delayMs = 0) {}

  private behavior(input: { settings: Record<string, unknown> }): MockBehavior {
    const b = input.settings.mock_behavior;
    return (MOCK_BEHAVIORS as readonly string[]).includes(b as string) ? (b as MockBehavior) : "success";
  }

  async publish(input: PublishInput, io: CheckpointIO): Promise<PublishResult> {
    const behavior = this.behavior(input.account);
    if (behavior === "auth_revoked") throw new ConnectorError("auth", "Token revogado pelo usuário na plataforma.", { code: "token_revoked" });
    if (behavior === "permanent") throw new ConnectorError("permanent", "Mídia rejeitada pela plataforma.", { code: "media_rejected" });
    if (behavior === "transient") throw new ConnectorError("transient", "Serviço indisponível (503).", { code: "http_503" });
    if (behavior === "timeout_before") throw new ConnectorError("timeout", "Tempo esgotado ao conectar.", { sideEffectStarted: false });
    if (behavior === "flaky" && input.attemptNo === 1) throw new ConnectorError("transient", "Falha temporária simulada.", { code: "http_502" });
    if (behavior === "rate_limit" && input.attemptNo === 1) {
      throw new ConnectorError("rate_limited", "Limite de requisições atingido.", { code: "rate_limit", retryAfterSeconds: 120 });
    }

    // Retomada: se a tentativa anterior já criou o upload, não cria outro.
    let uploadRef = typeof input.checkpoint?.upload_ref === "string" ? input.checkpoint.upload_ref : null;
    if (!uploadRef) {
      uploadRef = `${input.jobId}:${input.attemptNo}`;
      await io.save("uploading", { upload_ref: uploadRef });
      await this.store.createUpload(input.account.id, uploadRef, input.caption);
    }
    await io.save("processing_remote", { upload_ref: uploadRef });
    if (behavior === "slow") await sleep(this.delayMs || 50);

    if (behavior === "uncertain") throw new ConnectorError("unknown", "Resposta ilegível da plataforma.", { sideEffectStarted: true });

    await io.save("publishing", { upload_ref: uploadRef });
    await this.store.publish(uploadRef);
    if (behavior === "timeout_after") throw new ConnectorError("timeout", "Tempo esgotado aguardando resposta.", { sideEffectStarted: true });

    const found = await this.store.find(uploadRef);
    return { externalId: found!.id, permalink: `https://mock.reelsflow.invalid/p/${found!.id}` };
  }

  async getStatus(account: PublishInput["account"], checkpoint: Record<string, unknown>): Promise<RemoteStatus> {
    if (this.behavior(account) === "uncertain") return { state: "unknown" };
    const ref = typeof checkpoint.upload_ref === "string" ? checkpoint.upload_ref : null;
    if (!ref) return { state: "not_found" };
    const found = await this.store.find(ref);
    if (!found) return { state: "not_found" };
    if (found.status === "processing") return { state: "processing" };
    return { state: "published", externalId: found.id, permalink: `https://mock.reelsflow.invalid/p/${found.id}` };
  }
}
