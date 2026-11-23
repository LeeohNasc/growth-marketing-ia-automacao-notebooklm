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
  // Tela Dividida: cores sólidas distintas (para conferir posição por pixel) e tons distintos (para
  // conferir qual áudio entrou): superior 1920×1080 30 fps 6 s 440 Hz; inferior 720×1280 24 fps 4 s 880 Hz;
  // podcast 44,1 kHz mono 5 s 660 Hz (testa reamostragem); sem áudio 3 s.
  const solid = (color: string, size: string, rate: number) => `color=c=${color}:s=${size}:rate=${rate},drawbox=x=0:y=0:w=iw/6:h=ih/6:color=white:t=fill`;
  ff("-f", "lavfi", "-i", solid("0xd62828", "1920x1080", 30), "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "6",
     "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-ar", "48000", "-shortest", "-movflags", "+faststart", path.join(fx, "split-top.mp4"));
  ff("-f", "lavfi", "-i", solid("0x1d4ed8", "720x1280", 24), "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "4",
     "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-ar", "48000", "-shortest", "-movflags", "+faststart", path.join(fx, "split-bottom.mp4"));
  ff("-f", "lavfi", "-i", solid("0x15803d", "1280x720", 25), "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=44100", "-t", "5",
     "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "1", "-ar", "44100", "-shortest", path.join(fx, "split-podcast-44k.mp4"));
  ff("-f", "lavfi", "-i", solid("0xf59e0b", "1080x1080", 30), "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(fx, "split-noaudio.mp4"));


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
  // Mesma "casca" do app (sidebar, cabeçalho h-14, <main> py-6 e o contêiner da página do editor),
  // para os testes de layout medirem o editor como na aplicação real.
  writeFileSync(
    path.join(site, "editor.html"),
    `<!doctype html><html lang="pt-BR" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head>
<body class="bg-background text-foreground antialiased">
<div class="flex min-h-dvh">
  <aside class="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r bg-sidebar lg:flex"><div class="flex h-14 items-center px-6 font-semibold">ReelsFlow</div></aside>
  <div class="flex min-w-0 flex-1 flex-col">
    <header class="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur sm:px-6"><span class="text-sm">Workspace</span></header>
    <main id="conteudo" class="flex-1 px-4 py-6 sm:px-6 lg:px-8">
      <div class="mx-auto flex max-w-7xl flex-col gap-4 md:h-[calc(100dvh-3.5rem-3rem)]">
        <div class="flex shrink-0 flex-wrap items-end justify-between gap-2"><div><a class="text-sm text-muted-foreground">← Criar publicação</a><h1 class="text-2xl font-semibold tracking-tight">Card Editorial</h1></div></div>
        <div class="md:min-h-0 md:flex-1"><div id="root" class="md:h-full"></div></div>
      </div>
    </main>
  </div>
</div>
<script type="module" src="/editor.js"></script></body></html>`,
  );
}
