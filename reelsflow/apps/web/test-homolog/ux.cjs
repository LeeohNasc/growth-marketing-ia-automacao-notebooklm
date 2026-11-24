// Regressões de experiência da navegação (local, dados sintéticos): destaque do menu, voltar/avançar,
// cliques rápidos, teclado, Ctrl+clique, menu do celular, deslocamento de layout, erros de console.
// Uso: node test-homolog/ux.cjs
const { chromium, devices } = require("@playwright/test");
const { SITE, assertLocal, seed } = require("./config.cjs");
assertLocal();
const S = seed(), B = S.b.slug;
let fails = 0; const ok = (c, m) => { console.log(`${c ? "OK  " : "FALHA"} ${m}`); if (!c) fails++; };
const hl = (p) => p.locator("aside nav a.bg-primary\\/15").allInnerTexts();
async function login(ctx) { const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto(SITE + "/login"); await p.getByLabel("E-mail").fill(S.email); await p.getByLabel("Senha").fill(S.pass); await p.getByRole("button", { name: "Entrar" }).click(); await p.waitForURL(/\/w(\/|$)/); return { p, errs }; }
(async () => {
  const b = await chromium.launch();
  { const ctx = await b.newContext({ viewport: { width: 1366, height: 860 } }); await ctx.addInitScript(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true }); });
    const { p, errs } = await login(ctx); const nav = p.locator("aside");
    await p.goto(`${SITE}/w/${B}/library`); await p.locator("main h1", { hasText: "Biblioteca" }).waitFor();
    // destaque imediato no item clicado, e só nele
    await nav.getByRole("link", { name: "Visão Geral", exact: true }).click(); const during = await hl(p);
    await p.locator("main h1", { hasText: "Visão Geral" }).waitFor(); await p.waitForTimeout(300); const after = await hl(p);
    ok(during.length === 1 && /Visão Geral/.test(during[0]) && after.length === 1 && /Visão Geral/.test(after[0]), `destaque: durante ${JSON.stringify(during.map((t) => t.split("\n")[0]))}, depois ${JSON.stringify(after.map((t) => t.split("\n")[0]))}`);
    // voltar / avançar
    await p.goBack(); await p.locator("main h1", { hasText: "Biblioteca" }).waitFor(); await p.waitForTimeout(300);
    ok(JSON.stringify((await hl(p)).map((t) => t.split("\n")[0])) === '["Biblioteca de Vídeos"]', "voltar: destaque acompanha a URL (Biblioteca)");
    await p.goForward(); await p.locator("main h1", { hasText: "Visão Geral" }).waitFor(); await p.waitForTimeout(300);
    ok(JSON.stringify((await hl(p)).map((t) => t.split("\n")[0])) === '["Visão Geral"]', "avançar: destaque acompanha a URL (Visão Geral)");
    // cliques rápidos sem esperar: termina na última, um só destaque, aria-current certo
    for (const l of ["Calendário", "Campanhas", "Fila de Publicações", "Configurações"]) { await nav.getByRole("link", { name: l, exact: true }).click(); await p.waitForTimeout(60); }
    await p.locator("main h1", { hasText: "Configurações" }).waitFor(); await p.waitForTimeout(500);
    const cur = await nav.locator('a[aria-current="page"]').allInnerTexts();
    ok(p.url().endsWith("/settings") && JSON.stringify((await hl(p)).map((t) => t.split("\n")[0])) === '["Configurações"]' && cur.length === 1, "4 cliques rápidos: termina em Configurações, 1 item destacado, aria-current único");
    // teclado
    await nav.getByRole("link", { name: "Campanhas", exact: true }).focus(); await p.keyboard.press("Enter"); await p.locator("main h1", { hasText: "Campanhas" }).waitFor();
    ok(p.url().endsWith("/campaigns"), "teclado (Enter no item do menu) navega");
    // Ctrl+clique não marca destaque provisório
    await p.keyboard.down("Control"); await nav.getByRole("link", { name: "Calendário", exact: true }).click(); await p.keyboard.up("Control"); await p.waitForTimeout(200);
    ok(JSON.stringify((await hl(p)).map((t) => t.split("\n")[0])) === '["Campanhas"]', "Ctrl+clique (nova aba) não muda o destaque da aba atual");
    // deslocamento de layout ao longo de uma volta pelas páginas
    await p.evaluate(() => (window.__cls = 0));
    for (const [l, h] of [["Visão Geral", "Visão Geral"], ["Calendário", "Calendário"], ["Fila de Publicações", "Fila"], ["Biblioteca de Vídeos", "Biblioteca"], ["Configurações", "Configurações"]]) { await nav.getByRole("link", { name: l, exact: true }).click(); await p.locator("main h1", { hasText: h }).waitFor(); await p.waitForTimeout(400); }
    const cls = await p.evaluate(() => window.__cls); ok(cls < 0.1, `deslocamento de layout acumulado em 5 navegações: ${cls.toFixed(3)} (limite bom < 0,1)`);
    ok(errs.length === 0, `erros de console (desktop): ${errs.length} ${JSON.stringify(errs.slice(0, 3))}`); await ctx.close(); }
  { const ctx = await b.newContext({ ...devices["Pixel 7"] }); const { p, errs } = await login(ctx); await p.goto(`${SITE}/w/${B}/overview`); await p.locator("main h1", { hasText: "Visão Geral" }).waitFor();
    await p.getByRole("button", { name: /menu/i }).first().click(); await p.getByRole("dialog").getByRole("link", { name: "Fila de Publicações", exact: true }).click();
    await p.locator("main h1", { hasText: "Fila de Publicações" }).waitFor(); await p.waitForTimeout(400);
    ok(p.url().endsWith("/queue") && (await p.getByRole("dialog").count()) === 0, "celular: menu fecha e abre a Fila");
    ok(errs.length === 0, `erros de console (celular): ${errs.length} ${JSON.stringify(errs.slice(0, 3))}`); await ctx.close(); }
  await b.close(); console.log(fails ? `\n${fails} FALHA(S)` : "\ntodos os testes de experiência passaram"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("ERRO", e.message); process.exit(1); });
