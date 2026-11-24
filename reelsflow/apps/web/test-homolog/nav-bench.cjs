// Medição da navegação pelo menu lateral em navegador real (local, dados sintéticos).
// Mede, por página: clique → 1ª mudança na tela, → troca de URL, → conteúdo real (utilizável); tarefas
// longas; CPU; renderizações do React; menu remontado ou não; chamadas do servidor ao Supabase (via
// latency-proxy) e o caminho crítico delas.
// Uso: node test-homolog/nav-bench.cjs <rotulo> [slow]    (resultados em test-homolog/.homolog/)
const { chromium } = require("@playwright/test"); const fs = require("fs"); const path = require("path");
const { SITE, assertLocal, seed, STATE_DIR } = require("./config.cjs");
assertLocal();
const S = seed(); const LABEL = process.argv[2] ?? "x", SLOW = process.argv[3] === "slow";
const ROUTE = [["library", "Biblioteca de Vídeos"], ["calendar", "Calendário"], ["campaigns", "Campanhas"], ["queue", "Fila de Publicações"],
  ["settings", "Configurações"], ["create", "Criar publicação"], ["overview", "Visão Geral"]];
const H1 = { library: "Biblioteca de Vídeos", calendar: "Calendário", campaigns: "Campanhas", queue: "Fila de Publicações", settings: "Configurações", create: "Criar publicação", overview: "Visão Geral" };
const INIT = () => {
  let commits = 0; const longtasks = [];
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), isDisabled: false, inject() { return 1; }, onCommitFiberRoot() { commits++; }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {}, on() {}, off() {}, sub() { return () => {}; } };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) longtasks.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: true });
  const st = { click: null, push: null, firstMut: null, firstMutNav: null, firstMutMain: null, expect: null, usable: null };
  window.__nav = { st, commits: () => commits, longtasks };
  document.addEventListener("pointerdown", (e) => { if (e.target.closest("aside a[href]")) { st.click = performance.now(); st.push = st.firstMut = st.firstMutNav = st.firstMutMain = st.usable = null; } }, true);
  for (const k of ["pushState", "replaceState"]) { const o = history[k]; history[k] = function (...a) { if (st.click != null && st.push == null) st.push = performance.now(); return o.apply(this, a); }; }
  new MutationObserver((ms) => {
    if (st.click == null) return; const t = performance.now();
    st.firstMut ??= t;
    if (st.usable == null && st.expect) { const h = document.querySelector("main h1"); if (h && h.textContent.includes(st.expect)) st.usable = t; }
    for (const m of ms) { const el = m.target.nodeType === 1 ? m.target : m.target.parentElement; if (!el) continue;
      if (el.closest("aside")) st.firstMutNav ??= t; if (el.closest("main")) st.firstMutMain ??= t; }
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
};
const calls = () => { try { return fs.readFileSync(path.join(STATE_DIR, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch { return []; } };
const union = (iv) => { iv.sort((a, b) => a[0] - b[0]); let tot = 0, cs = -1, ce = -1; for (const [s, e] of iv) { if (s > ce) { if (ce > cs) tot += ce - cs; cs = s; ce = e; } else ce = Math.max(ce, e); } if (ce > cs) tot += ce - cs; return tot; };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1366, height: 860 } }); await ctx.addInitScript(INIT);
  const page = await ctx.newPage(); const cdp = await ctx.newCDPSession(page); await cdp.send("Performance.enable");
  const errs = []; page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 160))); page.on("pageerror", (e) => errs.push("pageerror " + e.message.slice(0, 160)));
  const rsc = []; page.on("requestfinished", async (r) => { const h = r.headers(); if (h["rsc"] === "1") { const t = r.timing(); rsc.push({ w: Date.now(), url: r.url().replace(SITE, "").split("?")[0], prefetch: !!h["next-router-prefetch"], ttfb: t.responseStart - t.requestStart, total: t.responseEnd }); } });
  await page.goto(SITE + "/login"); await page.getByLabel("E-mail").fill(S.email); await page.getByLabel("Senha").fill(S.pass); await page.getByRole("button", { name: "Entrar" }).click(); await page.waitForURL(/\/w(\/|$)/);
  if (SLOW) await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 });
  const ws = S.b.slug; const out = { label: LABEL, slow: SLOW, rounds: [] };
  for (let round = 0; round < 3; round++) {
    await page.goto(`${SITE}/w/${ws}/overview`, { waitUntil: "networkidle" }); await page.waitForTimeout(1500);
    await page.evaluate(() => { document.querySelector("aside").__mark = 1; });
    for (const [key, label] of ROUTE) {
      const m0 = (await cdp.send("Performance.getMetrics")).metrics.reduce((o, x) => ((o[x.name] = x.value), o), {});
      const c0 = await page.evaluate(() => window.__nav.commits()); const wall0 = Date.now(); const nRsc = rsc.length;
      await page.evaluate((t) => { window.__nav.st.expect = t; }, H1[key]);
      await page.locator("aside").getByRole("link", { name: label, exact: true }).click();
      await page.locator("main h1", { hasText: H1[key] }).first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(50);
      const usable = await page.evaluate(() => window.__nav.st.usable ?? performance.now()); const wall1 = Date.now();
      await page.waitForTimeout(600);
      const m1 = (await cdp.send("Performance.getMetrics")).metrics.reduce((o, x) => ((o[x.name] = x.value), o), {});
      const r = await page.evaluate((u) => { const { st, longtasks, commits } = window.__nav; const lt = longtasks.filter(([s]) => s >= st.click - 5 && s <= u + 600);
        return { feedback: (st.firstMut ?? u) - st.click, feedbackNav: st.firstMutNav == null ? null : st.firstMutNav - st.click, feedbackMain: st.firstMutMain == null ? null : st.firstMutMain - st.click, push: st.push == null ? null : st.push - st.click, usable: u - st.click,
          longN: lt.length, longMs: lt.reduce((s, [, d]) => s + d, 0), longMax: lt.reduce((s, [, d]) => Math.max(s, d), 0), commits: commits(), asideKept: document.querySelector("aside").__mark === 1 }; }, usable);
      const sc = calls().filter((c) => c.server && c.t >= wall0 && c.t <= wall1);
      const nav = rsc.slice(nRsc).filter((x) => !x.prefetch);
      out.rounds.push({ round, key, ...r, commits: r.commits - c0, cpuMs: (m1.TaskDuration - m0.TaskDuration) * 1000, scriptMs: (m1.ScriptDuration - m0.ScriptDuration) * 1000,
        rscN: nav.length, serverMs: nav.length ? Math.max(...nav.map((x) => x.ttfb)) : null, sbCalls: sc.length, sbCritical: union(sc.map((c) => [c.t, c.t + c.ms])), sbPaths: sc.map((c) => c.p.replace("/rest/v1/", "")).join(" ") });
    }
  }
  // navegação rápida: 6 cliques com 150 ms de intervalo; deve terminar na última página, sem erro
  await page.goto(`${SITE}/w/${ws}/overview`, { waitUntil: "networkidle" });
  const tR = Date.now(); for (const [, label] of ROUTE.slice(0, 6)) { await page.locator("aside").getByRole("link", { name: label, exact: true }).click(); await page.waitForTimeout(150); }
  await page.locator("main h1", { hasText: H1.create }).first().waitFor({ timeout: 30000 }); out.rapid = { ms: Date.now() - tR, finalUrlOk: /\/create$/.test(page.url()) };
  out.prefetch = rsc.filter((x) => x.prefetch).length; out.errors = [...new Set(errs)];
  fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(path.join(STATE_DIR, `results-${LABEL}.json`), JSON.stringify(out, null, 1));
  // resumo: mediana por página (rodadas 1 e 2 = cache do navegador quente) e rodada 0
  const keys = ROUTE.map(([k]) => k); const f = (v) => (v == null ? "  -  " : String(Math.round(v)).padStart(5));
  console.log(`\n[${LABEL}${SLOW ? " · rede lenta" : ""}] página      | feedback | URL   | utilizável | servidor | supabase(n/crit ms) | long tasks(n/ms) | CPU ms | commits | menu mantido`);
  for (const k of keys) { const rs = out.rounds.filter((r) => r.key === k); const g = (p) => med(rs.map((r) => r[p]).filter((v) => v != null));
    console.log(`${k.padEnd(22)}|   ${f(g("feedback"))}  | ${f(g("push"))} |     ${f(g("usable"))}  |   ${f(g("serverMs"))}  |    ${String(g("sbCalls")).padStart(2)} / ${f(g("sbCritical"))}     |   ${g("longN")} / ${f(g("longMs"))}     | ${f(g("cpuMs"))}  |  ${f(g("commits"))}  | ${rs.every((r) => r.asideKept)}`); }
  console.log(`navegação rápida (6 cliques): ${out.rapid.ms} ms, terminou na página certa: ${out.rapid.finalUrlOk}; prefetch RSC: ${out.prefetch}; erros de console: ${out.errors.length} ${JSON.stringify(out.errors.slice(0, 4))}`);
  console.log("chamadas Supabase (1ª navegação p/ library):", out.rounds[0].sbPaths);
  await b.close();
})().catch((e) => { console.error("FALHOU", e.message); process.exit(1); });
