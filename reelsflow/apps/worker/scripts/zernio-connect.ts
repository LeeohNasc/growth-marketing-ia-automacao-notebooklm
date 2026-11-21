/**
 * Primeiro passo da integração com a Zernio (llms.txt → "First Time Setup"):
 *   1. garante um perfil (idempotente por externalId);
 *   2. gera o link de conexão hospedado para uma plataforma;
 *   3. lista as contas já conectadas ao perfil.
 * Não publica nada. A chave vem SOMENTE de ZERNIO_API_KEY (nunca impressa).
 *
 * Uso: pnpm --filter @reelsflow/worker zernio:connect [instagram|facebook|tiktok|youtube] [--external-id=<id>] [--name=<nome>] [--redirect=<url>]
 */
import { ZERNIO_SOCIAL_PLATFORMS, ZernioApiError, ZernioClient, type ZernioPlatform } from "@reelsflow/connectors/server";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const platform = (args.find((a) => !a.startsWith("--")) ?? "instagram") as ZernioPlatform;
if (!ZERNIO_SOCIAL_PLATFORMS.includes(platform)) {
  console.error(`Plataforma inválida: ${platform}. Use: ${ZERNIO_SOCIAL_PLATFORMS.join(", ")}`);
  process.exit(2);
}
const externalId = flag("external-id") ?? "reelsflow:default";
const name = flag("name") ?? "ReelsFlow";
const redirectUrl = flag("redirect");

try {
  const zernio = ZernioClient.fromEnv();
  const { profile, created } = await zernio.ensureProfile({ name, externalId, description: "Perfil do ReelsFlow (contas conectadas via Zernio)" });
  console.log(`Perfil ${created ? "criado" : "existente"}: ${profile._id} (name="${profile.name}", externalId="${profile.externalId ?? externalId}")`);
  const { authUrl } = await zernio.getConnectUrl(platform, profile._id, { redirectUrl });
  console.log(`\nLink de conexão (${platform}) — abra no navegador e autorize a conta:\n${authUrl}\n`);
  const accounts = await zernio.listAccounts(profile._id);
  console.log(accounts.length ? `Contas já conectadas ao perfil:` : "Nenhuma conta conectada ao perfil ainda.");
  for (const a of accounts) console.log(`  - ${a.platform}: ${a.username ?? a.displayName ?? "?"} (accountId ${a._id}, ativa: ${a.isActive ?? "?"})`);
} catch (e) {
  if (e instanceof ZernioApiError) {
    console.error(`Erro da Zernio: HTTP ${e.status} ${e.type ?? ""} ${e.code ?? ""} — ${e.message}${e.requestId ? ` (request id ${e.requestId})` : ""}`);
  } else {
    console.error(String(e instanceof Error ? e.message : e));
  }
  process.exit(1);
}
