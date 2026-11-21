import { defineConfig } from "@playwright/test";

/**
 * Renderização REAL do Card Editorial no Chromium (WebCodecs + canvas), sem Next/Supabase.
 * Gera PNG/JPEG/MP4 de amostra em test-results/editorial-samples e os inspeciona com ffprobe.
 */
const PORT = 3210;
export default defineConfig({
  testDir: "./e2e-render",
  testMatch: /.*\.spec\.ts/,
  globalSetup: "./e2e-render/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "off" },
  webServer: { command: `node e2e-render/server.mjs`, url: `http://127.0.0.1:${PORT}/health`, env: { PORT: String(PORT) }, reuseExistingServer: false },
});
