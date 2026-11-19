import { ConnectorError, type ConnectorPlatform, type PublishConnector } from "./types";

/** Status de disponibilidade exibido na interface (Contas Conectadas). */
export const CONNECTOR_AVAILABILITY: Record<ConnectorPlatform, { available: boolean; reason: string }> = {
  mock: { available: true, reason: "Conector simulado para testes; não publica em redes reais." },
  instagram: { available: false, reason: "Implementação na Fase 4; publicação para clientes depende do App Review da Meta." },
  facebook: { available: false, reason: "Implementação na Fase 4; publicação para clientes depende do App Review da Meta." },
  tiktok: { available: false, reason: "Bloqueado: apps não auditados pelo TikTok só publicam como privado." },
  youtube: { available: false, reason: "Bloqueado: projetos não verificados pelo Google têm uploads restritos a privado." },
};

export class ConnectorRegistry {
  private readonly map = new Map<ConnectorPlatform, PublishConnector>();
  register(c: PublishConnector) {
    this.map.set(c.platform, c);
    return this;
  }
  get(platform: ConnectorPlatform): PublishConnector {
    const c = this.map.get(platform);
    if (!c) throw new ConnectorError("permanent", `Conector ${platform} indisponível.`, { code: "connector_unavailable" });
    return c;
  }
}
