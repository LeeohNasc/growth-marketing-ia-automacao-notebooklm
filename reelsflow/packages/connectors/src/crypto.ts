import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Criptografia de tokens OAuth em repouso: AES-256-GCM, chave fora do banco.
 * Chaves por versão permitem rotação: novas cifras usam a versão atual;
 * antigas continuam legíveis enquanto a chave antiga estiver configurada.
 *
 * Configuração: TOKEN_ENCRYPTION_KEYS='{"1":"<base64 32 bytes>","2":"..."}'
 *               TOKEN_ENCRYPTION_KEY_VERSION=2
 * (ou TOKEN_ENCRYPTION_KEY=<base64 32 bytes> para uma única chave, versão 1)
 */
export type Sealed = { ciphertext: string; iv: string; tag: string; keyVersion: number };

export class TokenCipher {
  private readonly keys = new Map<number, Buffer>();
  constructor(keys: Record<number, string>, private readonly current: number) {
    for (const [v, k] of Object.entries(keys)) {
      const buf = Buffer.from(k, "base64");
      if (buf.length !== 32) throw new Error(`Chave de criptografia versão ${v} deve ter 32 bytes (base64).`);
      this.keys.set(Number(v), buf);
    }
    if (!this.keys.has(current)) throw new Error(`Chave de criptografia atual (versão ${current}) ausente.`);
  }

  static fromEnv(env: Record<string, string | undefined> = process.env): TokenCipher {
    if (env.TOKEN_ENCRYPTION_KEYS) {
      const keys = JSON.parse(env.TOKEN_ENCRYPTION_KEYS) as Record<string, string>;
      const current = Number(env.TOKEN_ENCRYPTION_KEY_VERSION ?? Math.max(...Object.keys(keys).map(Number)));
      return new TokenCipher(Object.fromEntries(Object.entries(keys).map(([k, v]) => [Number(k), v])), current);
    }
    if (env.TOKEN_ENCRYPTION_KEY) return new TokenCipher({ 1: env.TOKEN_ENCRYPTION_KEY }, 1);
    throw new Error("TOKEN_ENCRYPTION_KEY não configurada.");
  }

  /** `aad` amarra a cifra a um contexto (ex.: id da conta): a cifra não pode ser movida para outra linha. */
  seal(plaintext: string, aad: string): Sealed {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.keys.get(this.current)!, iv);
    c.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), keyVersion: this.current };
  }

  open(s: Sealed, aad: string): string {
    const key = this.keys.get(s.keyVersion);
    if (!key) throw new Error(`Chave de criptografia versão ${s.keyVersion} indisponível.`);
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(s.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(s.ciphertext, "base64")), d.final()]).toString("utf8");
  }
}
