import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
}
