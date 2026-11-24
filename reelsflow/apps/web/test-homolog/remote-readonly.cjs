// Verificação SOMENTE LEITURA de um deploy remoto (prévia ou produção), sem login e sem escrita.
// Faz apenas GET em páginas públicas, em rotas protegidas (esperado: redirecionamento ao login) e numa
// rota pública que consulta o banco com uma função só de leitura (código inexistente).
// Uso: node test-homolog/remote-readonly.cjs <url> [rotulo]
//   HOMOLOG_BYPASS  token de "Protection Bypass for Automation" da Vercel, para prévias protegidas.
//                   Nunca é impresso.
const { chromium, devices } = require("@playwright/test");
const BASE = (process.argv[2] ?? "").replace(/\/$/, ""); const LABEL = process.argv[3] ?? BASE;
if (!/^https:\/\//.test(BASE)) throw new Error("informe a URL https do deploy");
const H = process.env.HOMOLOG_BYPASS ? { "x-vercel-protection-bypass": process.env.HOMOLOG_BYPASS } : {};
const SLUG = process.env.HOMOLOG_REMOTE_SLUG ?? "qualquer-workspace";
const PAGES = ["overview", "library", "calendar", "campaigns", "settings", "queue", "create"];
const READ_ONLY_DB = "/data-deletion/000000000000000000000000"; // rpc data_deletion_status (stable, só SELECT)
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
let fails = 0; const ok = (c, m) => { console.log(`${c ? "OK   " : "FALHA"} [${LABEL}] ${m}`); if (!c) fails++; };

async function ttfb(path, n = 15) {
  const out = [];
  for (let i = 0; i < n; i++) { const t0 = performance.now(); const r = await fetch(BASE + path, { headers: H, redirect: "manual" }); out.push([performance.now() - t0, r.status, r.headers.get("x-vercel-id") ?? ""]); await r.arrayBuffer(); }
  return { med: Math.round(med(out.map((x) => x[0]))), p90: Math.round([...out.map((x) => x[0])].sort((a, b) => a - b)[Math.round(n * 0.9) - 1]), codes: [...new Set(out.map((x) => x[1]))], region: out.at(-1)[2].split("::").slice(-2, -1)[0] };
}
(async () => {
  for (const p of PAGES) { const r = await fetch(`${BASE}/w/${SLUG}/${p}`, { headers: H, redirect: "manual" }); const loc = r.headers.get("location") ?? "";
    ok(r.status === 307 && loc.includes(`/login?next=${encodeURIComponent(`/w/${SLUG}/${p}`)}`), `rota protegida /w/…/${p} → login`); }
  for (const p of ["/", "/login", "/w/x/overview", READ_ONLY_DB]) { const t = await ttfb(p); console.log(`MEDIDA [${LABEL}] ${p.padEnd(42)} mediana ${t.med} ms · p90 ${t.p90} ms · códigos ${t.codes} · função em ${t.region}`); }
  const b = await chromium.launch();
  for (const dev of ["desktop", "celular"]) {
    const ctx = await b.newContext({ ...(dev === "celular" ? devices["Pixel 7"] : { viewport: { width: 1366, height: 860 } }), extraHTTPHeaders: H });
    const p = await ctx.newPage(); const errs = []; p.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 120))); p.on("pageerror", (e) => errs.push(e.message.slice(0, 120)));
    for (const path of ["/", "/login", `/w/${SLUG}/overview`]) { const r = await p.goto(BASE + path, { waitUntil: "networkidle" }); ok(r.status() === 200, `${dev}: ${path} → ${new URL(p.url()).pathname} ${r.status()}`); }
    ok(errs.length === 0, `${dev}: erros de console ${errs.length} ${errs.length ? JSON.stringify(errs.slice(0, 2)) : ""}`); await ctx.close();
  }
  await b.close(); console.log(fails ? `${fails} FALHA(S)` : `[${LABEL}] sem falhas`); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("ERRO", e.message); process.exit(1); });
