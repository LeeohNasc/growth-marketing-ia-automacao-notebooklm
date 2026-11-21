// Servidor estático mínimo para o harness (sem Next, sem Supabase).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const roots = { "/fonts/": path.join(here, "../public/fonts"), "/": path.join(here, "site") };
const types = { ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4", ".mov": "video/quicktime" };
createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/health") return res.writeHead(200).end("ok");
  const [prefix, dir] = Object.entries(roots).find(([p]) => url.pathname.startsWith(p));
  const file = path.join(dir, url.pathname.slice(prefix.length) || "index.html");
  if (!file.startsWith(dir)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(Number(process.env.PORT ?? 3210), "127.0.0.1");
