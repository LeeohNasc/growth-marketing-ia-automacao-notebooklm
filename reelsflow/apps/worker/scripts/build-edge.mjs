// Gera supabase/functions/worker-tick/worker.bundle.js a partir de src/edge.ts.
// Pacotes npm ficam externos com especificadores `npm:` fixados (o Deno os resolve);
// o código do monorepo (worker, domain, connectors) entra no bundle.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const versionOf = (pkg) =>
  JSON.parse(readFileSync(path.join(root, "node_modules/.pnpm/node_modules", pkg, "package.json"), "utf8")).version;
const NPM = ["@supabase/supabase-js", "zod", "temporal-polyfill"];

await build({
  entryPoints: [path.join(here, "../src/edge.ts")],
  outfile: path.join(root, "supabase/functions/worker-tick/worker.bundle.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  legalComments: "none",
  banner: { js: "// GERADO por apps/worker/scripts/build-edge.mjs — não editar.\n" },
  plugins: [
    {
      name: "npm-specifiers",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => {
          if (args.path.startsWith("node:")) return { path: args.path, external: true };
          const pkg = NPM.find((p) => args.path === p || args.path.startsWith(p + "/"));
          if (pkg) return { path: `npm:${pkg}@${versionOf(pkg)}${args.path.slice(pkg.length)}`, external: true };
          if (args.path === "pg") throw new Error("pg não deve entrar no bundle da Edge Function");
          return undefined;
        });
      },
    },
  ],
  mainFields: ["module", "main"],
  conditions: ["import"],
  resolveExtensions: [".ts", ".js"],
});
console.log("bundle ok");
