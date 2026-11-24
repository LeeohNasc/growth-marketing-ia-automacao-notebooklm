// Proxy HTTP LOCAL que imita a distância servidor → Supabase (só chamadas do SERVIDOR Next,
// identificadas por user-agent sem "Mozilla"; o navegador passa direto). Registra cada chamada.
// Uso: DELAY_MS=120 PORT=54331 [AUTH_DELAY_MS=2000] node test-homolog/latency-proxy.cjs
//   DELAY_MS       atraso por chamada do servidor (120 ≈ Vercel iad1 → São Paulo; 5 ≈ gru1)
//   AUTH_DELAY_MS  atraso EXTRA só em /auth/v1/user (para provar que nada sai antes do getUser)
// Build do app apontando para o proxy: NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54331
const http = require("node:http"); const fs = require("node:fs"); const path = require("node:path");
const { SB, assertLocal, STATE_DIR } = require("./config.cjs");
assertLocal();
const D = Number(process.env.DELAY_MS ?? 120), AD = Number(process.env.AUTH_DELAY_MS ?? 0), PORT = Number(process.env.PORT ?? 54331);
const up = new URL(SB);
fs.mkdirSync(STATE_DIR, { recursive: true });
const log = fs.createWriteStream(path.join(STATE_DIR, "calls.log"), { flags: "a" });
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
http.createServer((req, res) => {
  const server = !/Mozilla/.test(req.headers["user-agent"] ?? "");
  const p = req.url.split("?")[0]; const t0 = Date.now();
  const go = () => {
    const u = http.request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: req.headers, agent }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
      r.on("end", () => log.write(JSON.stringify({ t: t0, ms: Date.now() - t0, server, m: req.method, p, s: r.statusCode }) + "\n"));
    });
    u.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
    req.pipe(u);
  };
  const wait = (server ? D : 0) + (server && p === "/auth/v1/user" ? AD : 0);
  wait ? setTimeout(go, wait) : go();
}).listen(PORT, "127.0.0.1", () => console.log(`proxy :${PORT} → ${SB}, atraso servidor ${D} ms, extra getUser ${AD} ms`));
