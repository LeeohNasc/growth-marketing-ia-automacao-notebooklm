import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Os testes compartilham um banco; rodar arquivos em série evita interferência.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
