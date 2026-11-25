// Regressões de experiência da navegação (local, dados sintéticos): menu de 5 áreas, abas por área,
// endereços antigos, voltar/avançar, cliques rápidos, teclado, Ctrl+clique, celular, deslocamento de
// layout, erros de console.
// Uso: node test-homolog/ux.cjs
const { chromium, devices } = require("@playwright/test");
const { SITE, assertLocal, seed } = require("./config.cjs");
assertLocal();
const S = seed(), B = S.b.slug;
let fails = 0; const ok = (c, m) => { console.log(`${c ? "OK  " : "FALHA"} ${m}`); if (!c) fails++; };
const hl = async (p) => (await p.locator("aside nav a.bg-primary\\/15").allInnerTexts()).map((t) => t.split("\n")[0]);
const AREAS = ["Início", "Criar", "Calendário", "Resultados", "Configurações"];
async function login(ctx) { const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  await p.goto(SITE + "/login"); await p.getByLabel("E-mail").fill(S.email); await p.getByLabel("Senha").fill(S.pass); await p.getByRole("button", { name: "Entrar" }).click(); await p.waitForURL(/\/w(\/|$)/); return { p, errs }; }
(async () => {
  const b = await chromium.launch();
  { const ctx = await b.newContext({ viewport: { width: 1366, height: 860 } }); await ctx.addInitScript(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true }); });
    const { p, errs } = await login(ctx); const nav = p.locator("aside");
    // menu: exatamente as 5 áreas
    await p.goto(`${SITE}/w/${B}/overview`); await p.locator("main h1", { hasText: "Início" }).waitFor();
    const items = (await nav.locator("nav a").allInnerTexts()).map((t) => t.split("\n")[0]);
    ok(JSON.stringify(items) === JSON.stringify(AREAS), `menu com 5 áreas: ${JSON.stringify(items)}`);
    // cada endereço antigo abre a tela de sempre, com a área certa destacada e a aba certa ativa
    const OLD = [["overview", "Início", "Início", "Resumo"], ["notifications", "Início", "Avisos", "Avisos"], ["create", "Criar", "Criar publicação", "Criar publicação"], ["library", "Criar", "Biblioteca", "Biblioteca"], ["campaigns/new", "Criar", "Nova campanha", "Nova campanha"],
      ["calendar", "Calendário", "Calendário", "Calendário"], ["queue", "Calendário", "Lista de publicações", "Lista"], ["history", "Calendário", "Publicadas", "Publicadas"], ["campaigns", "Calendário", "Campanhas", "Campanhas"],
      ["analytics", "Resultados", "Resultados", null], ["settings", "Configurações", "Configurações", "Geral"], ["accounts", "Configurações", "Contas", "Contas"], ["templates", "Configurações", "Padrões de publicação", "Padrões de publicação"], ["automations", "Configurações", "Automações", "Automações"], ["billing", "Configurações", "Assinatura", "Assinatura"]];
    for (const [path, area, h1, tab] of OLD) {
      const r = await p.goto(`${SITE}/w/${B}/${path}`); await p.locator("main h1", { hasText: h1 }).first().waitFor();
      const tabNow = tab ? await p.locator('main nav a[aria-current="page"]').allInnerTexts() : [];
      ok(r.status() === 200 && JSON.stringify(await hl(p)) === JSON.stringify([area]) && (!tab || JSON.stringify(tabNow) === JSON.stringify([tab])), `/${path} → 200, área ${area}${tab ? `, aba ${tab}` : ""}`);
    }
    // /upload antigo → Biblioteca com o envio aberto
    await p.goto(`${SITE}/w/${B}/upload`); await p.locator("main h1", { hasText: "Biblioteca" }).waitFor();
    ok(/\/library\?enviar=1$/.test(p.url()) && (await p.locator("main details[open] summary", { hasText: "Enviar vídeos" }).count()) === 1, "/upload antigo → Biblioteca com 'Enviar vídeos' aberto");
    // abas levam às telas da área
    await p.goto(`${SITE}/w/${B}/calendar`); await p.locator("main h1", { hasText: "Calendário" }).waitFor();
    await p.locator("main nav").getByRole("link", { name: "Lista", exact: true }).click(); await p.locator("main h1", { hasText: "Lista de publicações" }).waitFor();
    ok(p.url().endsWith("/queue") && JSON.stringify(await hl(p)) === '["Calendário"]', "aba Lista (Calendário) abre a lista e mantém a área destacada");
    // destaque imediato no item clicado, voltar/avançar
    await p.goto(`${SITE}/w/${B}/library`); await p.locator("main h1", { hasText: "Biblioteca" }).waitFor();
    await nav.getByRole("link", { name: "Início", exact: true }).click(); const during = await hl(p);
    await p.locator("main h1", { hasText: "Início" }).waitFor(); await p.waitForTimeout(300);
    ok(JSON.stringify(during) === '["Início"]' && JSON.stringify(await hl(p)) === '["Início"]', `destaque imediato: durante ${JSON.stringify(during)}`);
    await p.goBack(); await p.locator("main h1", { hasText: "Biblioteca" }).waitFor(); await p.waitForTimeout(300);
    ok(JSON.stringify(await hl(p)) === '["Criar"]', "voltar: destaque acompanha a URL (Biblioteca → Criar)");
    await p.goForward(); await p.locator("main h1", { hasText: "Início" }).waitFor(); await p.waitForTimeout(300);
    ok(JSON.stringify(await hl(p)) === '["Início"]', "avançar: destaque acompanha a URL (Início)");
    // cliques rápidos
    for (const l of ["Calendário", "Criar", "Resultados", "Configurações"]) { await nav.getByRole("link", { name: l, exact: true }).click(); await p.waitForTimeout(60); }
    await p.locator("main h1", { hasText: "Configurações" }).waitFor(); await p.waitForTimeout(500);
    const cur = await nav.locator('a[aria-current="page"]').allInnerTexts();
    ok(p.url().endsWith("/settings") && JSON.stringify(await hl(p)) === '["Configurações"]' && cur.length === 1, "4 cliques rápidos: termina em Configurações, 1 item destacado, aria-current único");
    // teclado
    await nav.getByRole("link", { name: "Calendário", exact: true }).focus(); await p.keyboard.press("Enter"); await p.locator("main h1", { hasText: "Calendário" }).waitFor();
    ok(p.url().endsWith("/calendar"), "teclado (Enter no item do menu) navega");
    // Ctrl+clique não marca destaque provisório
    await p.keyboard.down("Control"); await nav.getByRole("link", { name: "Resultados", exact: true }).click(); await p.keyboard.up("Control"); await p.waitForTimeout(200);
    ok(JSON.stringify(await hl(p)) === '["Calendário"]', "Ctrl+clique (nova aba) não muda o destaque da aba atual");
    // deslocamento de layout numa volta pelas 5 áreas
    await p.evaluate(() => (window.__cls = 0));
    for (const [l, h] of [["Início", "Início"], ["Criar", "Criar publicação"], ["Calendário", "Calendário"], ["Resultados", "Resultados"], ["Configurações", "Configurações"]]) { await nav.getByRole("link", { name: l, exact: true }).click(); await p.locator("main h1", { hasText: h }).waitFor(); await p.waitForTimeout(400); }
    const cls = await p.evaluate(() => window.__cls); ok(cls < 0.1, `deslocamento de layout acumulado em 5 navegações: ${cls.toFixed(3)} (limite bom < 0,1)`);
    ok(errs.length === 0, `erros de console (desktop): ${errs.length} ${JSON.stringify(errs.slice(0, 3))}`); await ctx.close(); }
  { const ctx = await b.newContext({ ...devices["Pixel 7"] }); const { p, errs } = await login(ctx); await p.goto(`${SITE}/w/${B}/overview`); await p.locator("main h1", { hasText: "Início" }).waitFor();
    await p.getByRole("button", { name: /menu/i }).first().click();
    const items = (await p.getByRole("dialog").locator("nav a").allInnerTexts()).map((t) => t.split("\n")[0]);
    ok(JSON.stringify(items) === JSON.stringify(AREAS), `celular: menu com 5 áreas ${JSON.stringify(items)}`);
    await p.getByRole("dialog").getByRole("link", { name: "Calendário", exact: true }).click(); await p.locator("main h1", { hasText: "Calendário" }).waitFor(); await p.waitForTimeout(400);
    ok(p.url().endsWith("/calendar") && (await p.getByRole("dialog").count()) === 0, "celular: menu fecha e abre o Calendário");
    await p.locator("main nav").getByRole("link", { name: "Publicadas", exact: true }).click(); await p.locator("main h1", { hasText: "Publicadas" }).waitFor();
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "celular: abas sem rolagem horizontal da página");
    ok(errs.length === 0, `erros de console (celular): ${errs.length} ${JSON.stringify(errs.slice(0, 3))}`); await ctx.close(); }
  await b.close(); console.log(fails ? `\n${fails} FALHA(S)` : "\ntodos os testes de experiência passaram"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("ERRO", e.message); process.exit(1); });
