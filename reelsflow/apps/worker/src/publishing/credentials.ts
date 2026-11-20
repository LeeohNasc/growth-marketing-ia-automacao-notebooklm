import type { Db } from "../db";
import { ConnectorError } from "@reelsflow/connectors";
import type { TokenCipher } from "@reelsflow/connectors/server";

export interface CredentialProvider {
  get(account: { id: string; platform: string; external_account_id: string }): Promise<{ accessToken: string } | null>;
}

/**
 * Lê o token cifrado e decifra em memória, só no momento do uso.
 * Contexto (AAD) da cifra = "<plataforma>:<id externo>", igual ao usado no OAuth.
 */
export class PgCredentialProvider implements CredentialProvider {
  constructor(private readonly db: Db, private readonly cipher: TokenCipher | null) {}

  async get(account: { id: string; platform: string; external_account_id: string }) {
    if (account.platform === "mock") return null;
    const { rows } = await this.db.query<{ ciphertext: string; iv: string; auth_tag: string; key_version: number }>(
      "select ciphertext, iv, auth_tag, key_version from public.social_account_tokens where social_account_id = $1",
      [account.id],
    );
    const row = rows[0];
    if (!row) throw new ConnectorError("auth", "Conta sem credenciais. Reconecte a conta.", { code: "missing_token" });
    if (!this.cipher) {
      // Erro de configuração do servidor, não do usuário: não marcar a conta como desconectada.
      throw new ConnectorError("transient", "Chave de criptografia de tokens não configurada no worker.", { code: "cipher_missing", retryAfterSeconds: 900 });
    }
    try {
      return { accessToken: this.cipher.open({ ciphertext: row.ciphertext, iv: row.iv, tag: row.auth_tag, keyVersion: row.key_version }, `${account.platform}:${account.external_account_id}`) };
    } catch {
      throw new ConnectorError("transient", "Não foi possível decifrar as credenciais (chave ausente ou rotacionada).", { code: "cipher_failure", retryAfterSeconds: 900 });
    }
  }
}
