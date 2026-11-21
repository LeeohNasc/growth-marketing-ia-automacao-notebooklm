import { ConnectorError, type ConnectorKey, type ConnectorPlatform, type PublishConnector } from "./types";

/** Status de disponibilidade exibido na interface (Contas Conectadas). */
export const CONNECTOR_AVAILABILITY: Record<ConnectorPlatform, { available: boolean; reason: string }> = {
  mock: { available: true, reason: "Conector simulado para testes; não publica em redes reais." },
  instagram: { available: true, reason: "Requer app Meta configurado; contas de terceiros exigem App Review (acesso avançado) aprovado." },
  facebook: { available: true, reason: "Requer app Meta configurado; contas de terceiros exigem App Review (acesso avançado) aprovado." },
  tiktok: { available: false, reason: "Bloqueado: apps não auditados pelo TikTok só publicam como privado." },
  youtube: { available: false, reason: "Bloqueado: projetos não verificados pelo Google têm uploads restritos a privado." },
};

export class ConnectorRegistry {
  private readonly map = new Map<ConnectorKey, PublishConnector>();
  register(c: PublishConnector) {
    this.map.set(c.platform, c);
    return this;
  }
  get(key: ConnectorKey): PublishConnector {
    const c = this.map.get(key);
    if (!c) throw new ConnectorError("permanent", `Conector ${key} indisponível.`, { code: "connector_unavailable" });
    return c;
  }
  /** Conta conectada por um provedor intermediário (provider = "zernio") usa o conector dele. */
  forAccount(account: { platform: ConnectorPlatform; provider?: string | null }): PublishConnector {
    if (account.provider === "zernio" && !this.map.has("zernio")) {
      // Configuração do servidor ausente (ZERNIO_API_KEY): a publicação espera, não falha.
      throw new ConnectorError("transient", "Integração com a Zernio não configurada no worker (ZERNIO_API_KEY).", {
        code: "zernio_not_configured",
        retryAfterSeconds: 900,
      });
    }
    return this.get(account.provider === "zernio" ? "zernio" : account.platform);
  }
}
