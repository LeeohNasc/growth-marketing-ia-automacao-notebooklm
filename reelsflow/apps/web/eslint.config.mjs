import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // A service role só pode ser lida em lib/supabase/admin.ts (server-only).
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='SUPABASE_SERVICE_ROLE_KEY']",
          message: "Use createAdminClient() de lib/supabase/admin.ts.",
        },
      ],
    },
  },
  {
    files: ["lib/supabase/admin.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "playwright-report/**", "test-results/**", "e2e-render/site/**", "e2e-render/samples/**"]),
]);
