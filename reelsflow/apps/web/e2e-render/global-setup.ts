import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Gera as mídias de teste com ffmpeg (nada é baixado da internet) e empacota o harness. */
export default async function setup() {
  const site = path.join(__dirname, "site");
  const fx = path.join(site, "fixtures");
  mkdirSync(fx, { recursive: true });
  const ff = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  // avatar vermelho com círculo claro; fotos com padrões coloridos
  ff("-f", "lavfi", "-i", "color=c=0xd62828:s=400x400,drawbox=x=120:y=120:w=160:h=160:color=0xfcbf49:t=fill", "-frames:v", "1", path.join(fx, "avatar.png"));
  ff("-f", "lavfi", "-i", "testsrc2=size=1600x1200", "-frames:v", "1", "-q:v", "2", path.join(fx, "photo1.jpg"));
  ff("-f", "lavfi", "-i", "smptebars=size=900x1600", "-frames:v", "1", "-q:v", "2", path.join(fx, "photo2.jpg"));
  ff("-f", "lavfi", "-i", "color=c=0x1d3557:s=600x200,drawbox=x=0:y=0:w=200:h=200:color=0xe63946:t=fill", "-frames:v", "1", path.join(fx, "logo.png"));
  // vídeo horizontal com áudio AAC estéreo 48 kHz (4 s, 30 fps), vertical sem áudio, HEVC e corrompido
  ff("-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4",
     "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-ar", "48000", "-shortest", "-movflags", "+faststart", path.join(fx, "source.mp4"));
  ff("-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=30", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(fx, "vertical-noaudio.mp4"));
  ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "2", "-c:v", "libx265", "-tag:v", "hvc1", "-x265-params", "log-level=error", path.join(fx, "hevc.mov"));
  writeFileSync(path.join(fx, "corrupt.mp4"), randomBytes(200_000));

  await build({
    entryPoints: [path.join(__dirname, "harness.ts")],
    outfile: path.join(site, "harness.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "error",
  });
  writeFileSync(path.join(site, "index.html"), `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/harness.js"></script></body></html>`);

  // Editor REAL montado fora do Next: só cliente Supabase, next/link e server actions são trocados.
  const web = path.join(__dirname, "..");
  await build({
    entryPoints: [path.join(__dirname, "editor-harness.tsx")],
    outfile: path.join(site, "editor.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    logLevel: "error",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "harness-aliases",
        setup(b) {
          b.onResolve({ filter: /^@\/lib\/supabase\/client$/ }, () => ({ path: path.join(__dirname, "fake-supabase.ts") }));
          b.onResolve({ filter: /^next\/link$/ }, () => ({ path: path.join(__dirname, "stubs.tsx") }));
          b.onResolve({ filter: /\/actions$/ }, (a) => (a.importer.includes("create/editorial") ? { path: path.join(__dirname, "stubs.tsx") } : undefined));
          b.onResolve({ filter: /^@\// }, async (a) => b.resolve("./" + a.path.slice(2), { resolveDir: web, kind: a.kind }));
        },
      },
    ],
  });
  // CSS do próprio app (Tailwind compilado no build do Next) para as capturas terem o visual real.
  // Turbopack grava o CSS em .next/static/chunks/*.css (webpack usava .next/static/css).
  const css = ["css", "chunks"]
    .map((d) => path.join(web, ".next", "static", d))
    .filter((d) => existsSync(d))
    .flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".css")).map((f) => readFileSync(path.join(d, f), "utf8")))
    .join("\n");
  writeFileSync(path.join(site, "app.css"), css);
  writeFileSync(
    path.join(site, "editor.html"),
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body class="bg-background text-foreground antialiased"><main class="p-4 sm:p-6"><div id="root"></div></main><script type="module" src="/editor.js"></script></body></html>`,
  );
}
