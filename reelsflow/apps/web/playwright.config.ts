import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

/**
 * E2E sem backend: o Supabase aponta para uma porta fechada. Cobre renderização,
 * validação de formulários, proteção de rotas, cabeçalhos de segurança e
 * comportamento quando o Auth está indisponível. Fluxos com Auth real exigem um
 * projeto Supabase (pendência registrada).
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "off" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `pnpm exec next start -p ${PORT} -H 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${PORT}`,
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:9",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "e2e-placeholder",
    },
  },
});
