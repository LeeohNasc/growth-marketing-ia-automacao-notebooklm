import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

/** Landing page comercial (rota "/"). Viewports explícitos; roda só no projeto "desktop" para não duplicar. */
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "viewports definidos no próprio teste"));

const SHOTS = path.join(process.cwd(), "test-results", "landing");
mkdirSync(SHOTS, { recursive: true });
const HEADER_H = 74;

async function headingBelowHeader(page: Page, id: string) {
  // a rolagem é suave: espera assentar com o título logo abaixo do header fixo
  await expect
    .poll(async () => {
      const top = await page.evaluate((i) => document.getElementById(i)!.querySelector("h2")!.getBoundingClientRect().top, id);
      return top >= HEADER_H && top < HEADER_H + 120;
    }, { timeout: 5000 })
    .toBe(true);
}

test("estrutura, SEO e um único H1", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page).toHaveTitle(/ReelsFlow/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", /ReelsFlow/);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /semana de publicações planejadas/);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();
  // ordem das seções
  const ids = await page.evaluate(() => [...document.querySelectorAll("main section[id], main [id='demonstracao']")].map((e) => e.id));
  expect(ids).toEqual(["demonstracao", "como", "funcionalidades", "integracoes", "publico", "calculadora", "exemplo", "avaliacoes", "planos", "faq"]);
  // páginas de login seguem existindo e não são afetadas
  const login = await page.request.get("/login");
  expect(login.status()).toBe(200);
});

test("link de salto aparece com foco e leva ao conteúdo", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Ir para o conteúdo" });
  await expect(skip).toBeFocused();
  expect((await skip.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#conteudo$/);
});

test("header desktop: navegação, destinos e âncoras abaixo do header fixo", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Principal" });
  for (const [name, id] of [["Como funciona", "como"], ["Para quem é", "publico"], ["Planos", "planos"], ["Perguntas frequentes", "faq"]] as const) {
    await nav.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`#${id}$`));
    await headingBelowHeader(page, id);
    await expect(page.getByRole("banner")).toBeInViewport();
  }
  await page.getByRole("banner").getByRole("link", { name: "Ver planos" }).click();
  await expect(page).toHaveURL(/#planos$/);
  await page.getByRole("banner").getByRole("link", { name: /ReelsFlow/ }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(5);
});

test("header celular: menu abre, leva ao destino e fecha", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Principal" })).toBeHidden();
  const menu = page.getByRole("button", { name: "Menu" });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await menu.click();
  const mobile = page.getByRole("navigation", { name: "Menu" });
  await expect(mobile).toBeVisible();
  await expect(mobile.getByRole("link")).toHaveText(["Demonstração", "Como funciona", "Para quem é", "Planos", "Perguntas frequentes", "Entrar"]);
  await mobile.getByRole("link", { name: "Planos" }).click();
  await expect(mobile).toBeHidden();
  await expect(page).toHaveURL(/#planos$/);
  await headingBelowHeader(page, "planos");
  // Escape fecha e devolve o foco
  await page.getByRole("button", { name: "Menu" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("navigation", { name: "Menu" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Menu" })).toBeFocused();
});

test("demonstração: telas alternam com aria-pressed e mostram os dados", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const demo = page.getByRole("region", { name: "Demonstração do painel" });
  await expect(demo.getByText("ReelsFlow", { exact: true })).toBeVisible();
  await expect(demo.getByText("Dados ilustrativos")).toBeVisible();
  const tab = (n: string) => demo.getByRole("button", { name: n, exact: true });
  await expect(tab("Calendário")).toHaveAttribute("aria-pressed", "true");
  await expect(demo.getByRole("heading", { name: "Calendário de publicações" })).toBeVisible();
  await expect(demo.getByText("18–22 de maio")).toBeVisible();
  for (const v of ["Corte do podcast", "Melhores momentos", "Bastidores"]) await expect(demo.getByRole("button", { name: new RegExp(v) })).toBeVisible();

  await tab("Biblioteca").click();
  await expect(tab("Biblioteca")).toHaveAttribute("aria-pressed", "true");
  await expect(tab("Calendário")).toHaveAttribute("aria-pressed", "false");
  await expect(demo.getByRole("heading", { name: "Vídeos da semana" })).toBeVisible();
  await expect(demo.getByRole("listitem")).toHaveText([/Corte do podcast.*00:42.*Na programação/, /Bastidores da gravação.*00:27.*Pronto para organizar/]);

  await tab("Histórico").click();
  await expect(demo.getByRole("heading", { name: "Publicações anteriores" })).toBeVisible();
  await expect(demo.getByRole("listitem")).toHaveText([/Dica rápida.*Sex · 12h.*Publicado/, /Resumo da semana.*Sáb · 18h.*Falha no envio/]);
  await expect(demo.locator("[aria-live='polite']")).toHaveText("Exibindo Histórico");
});

test("detalhe do calendário abre e fecha por mouse e teclado, devolvendo o foco", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const ev = page.getByRole("button", { name: /Bastidores/ });
  await ev.click();
  const dlg = page.getByRole("dialog", { name: "Bastidores" });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByText("Agendamento ilustrativo")).toBeVisible();
  await expect(dlg).toContainText("Qui 21");
  await expect(dlg).toContainText("17:00");
  await expect(dlg).toContainText("Em revisão");
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await expect(ev).toBeFocused();

  const first = page.getByRole("button", { name: /Corte do podcast/ });
  await first.focus();
  await page.keyboard.press("Enter");
  const d2 = page.getByRole("dialog", { name: "Corte do podcast" });
  await expect(d2).toContainText("Seg 18");
  await d2.getByRole("button", { name: "Fechar detalhes" }).click();
  await expect(d2).toBeHidden();
  await expect(first).toBeFocused();
});

test("demonstração no celular: controles acima, agenda compacta sem dias vazios", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const demo = page.getByRole("region", { name: "Demonstração do painel" });
  const tabs = await demo.getByRole("group", { name: "Telas da demonstração" }).boundingBox();
  const head = await demo.getByRole("heading", { name: "Calendário de publicações" }).boundingBox();
  expect(tabs!.y + tabs!.height).toBeLessThanOrEqual(head!.y);
  await expect(demo.getByText("Qua 20")).toBeHidden();
  await expect(demo.getByText("Sex 22")).toBeHidden();
  await expect(demo.getByText("Seg 18")).toBeVisible();
  await demo.getByRole("button", { name: /Melhores momentos/ }).click();
  await expect(page.getByRole("dialog", { name: "Melhores momentos" })).toContainText("Ter 19");
  await page.keyboard.press("Escape");
});

test("calculadora: estado inicial, presets, minutos, singular e inválido", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const out = page.getByTestId("calc-result");
  await expect(out).toHaveText("5 horas por mês");
  await expect(out).toHaveAttribute("aria-live", "polite");
  const cases = [["1 vídeo por dia", "1,33 horas por mês"], ["3 vídeos por dia", "5 horas por mês"], ["6 vídeos por dia", "10 horas por mês"]] as const;
  for (const [preset, text] of cases) {
    await page.getByRole("button", { name: preset }).click();
    await expect(page.getByRole("button", { name: preset })).toHaveAttribute("aria-pressed", "true");
    await expect(out).toHaveText(text);
  }
  const set = async (v: string, m: string, d: string) => {
    await page.getByLabel("Vídeos por dia").fill(v);
    await page.getByLabel("Minutos por vídeo").fill(m);
    await page.getByLabel("Dias por mês").fill(d);
  };
  await set("1", "4", "10");
  await expect(out).toHaveText("40 minutos por mês");
  await set("1", "1", "1");
  await expect(out).toHaveText("1 minuto por mês");
  await set("1", "2.5", "3");
  await expect(out).toHaveText("7,5 minutos por mês");
  await set("1", "60", "1");
  await expect(out).toHaveText("1 hora por mês");
  await set("1000", "1440", "31");
  await expect(out).toHaveText("744.000 horas por mês");
  await page.getByLabel("Vídeos por dia").fill("");
  await expect(out).toHaveText("Preencha os campos com valores válidos.");
  await set("3", "4", "32");
  await expect(out).toHaveText("Preencha os campos com valores válidos.");
});

test("planos, comparação, glossário e avisos", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const planos = page.locator("#planos");
  await expect(planos).toContainText("as assinaturas ainda não estão abertas");
  const price = (k: string) => planos.locator(`[data-plan='${k}']`);
  await expect(price("starter")).toContainText("Grátis");
  await expect(price("pro")).toContainText("R$ 99,90/mês");
  await expect(price("business")).toContainText("R$ 299,90/mês");
  await expect(price("premium")).toContainText("R$ 799,90/mês");
  await expect(price("premium")).toContainText("no roteiro de desenvolvimento");
  // nada de checkout simulado nem preço anual
  await expect(planos.getByRole("button")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(/anual\s*R\$/i);

  const table = planos.getByRole("table");
  await expect(table).toBeHidden();
  await planos.getByText("Comparar todos os benefícios").click();
  await expect(table).toBeVisible();
  await expect(table.locator("caption")).toHaveText("Limites e benefícios propostos");
  await expect(table.locator("thead th[scope='col']")).toHaveCount(5);
  await expect(table.locator("tbody th[scope='row']")).toHaveCount(12);
  await expect(table.getByRole("row", { name: /Contas sociais/ })).toContainText("1 (limitada)");
  await expect(planos).toContainText("Workspace: ambiente de trabalho");
  await expect(planos).toContainText("Preços anuais seguem a definir.");

  await expect(page.locator("#avaliacoes")).toContainText("Depoimentos fictícios para demonstrar a página.");
  await expect(page.locator("#avaliacoes").getByText("Perfil fictício")).toHaveCount(3);
  await expect(page.locator("#avaliacoes").getByRole("img", { name: /Nota ilustrativa/ })).toHaveCount(3);
});

test("FAQ: acordeão por teclado", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const faq = page.locator("#faq");
  await expect(faq.locator("summary")).toHaveCount(6);
  const q = faq.locator("summary", { hasText: "O que acontece se uma publicação falhar?" });
  const answer = faq.getByText("O histórico ilustrativo mostra como uma falha pode aparecer.");
  await expect(answer).toBeHidden();
  await q.focus();
  await page.keyboard.press("Enter");
  await expect(answer).toBeVisible();
  await page.keyboard.press("Space");
  await expect(answer).toBeHidden();
});

for (const [w, h] of [[320, 640], [390, 844], [768, 1024], [1440, 900]] as const) {
  test(`sem estouro de largura em ${w}px (só a tabela rola por dentro)`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/");
    await page.locator("#planos summary").click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    // nenhum elemento visível ultrapassa a largura (exceto o conteúdo da tabela, que rola no contêiner)
    const offenders = await page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter((e) => !e.closest("table") && !e.closest("dialog") && (e as HTMLElement).offsetParent !== null)
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1); })
        .map((e) => `${e.tagName}.${(e as HTMLElement).className}`)
        .slice(0, 5),
    );
    expect(offenders).toEqual([]);
    if (w <= 768) {
      const scrollable = await page.locator("#planos [role='region']").evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(scrollable).toBe(true);
    }
  });
}

test("capturas desktop (1440) e celular (390)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(SHOTS, "landing-1440-hero.png") });
  await page.screenshot({ path: path.join(SHOTS, "landing-1440-full.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(SHOTS, "landing-390-hero.png") });
  await page.screenshot({ path: path.join(SHOTS, "landing-390-full.png"), fullPage: true });
});

test("funcionalidades e integrações: um H2 cada, textos acessíveis e status corretos", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const func = page.locator("#funcionalidades");
  await expect(func.locator("h2")).toHaveCount(1);
  await expect(func.locator("h2")).toHaveText("Do vídeo à publicação, em um só lugar");
  await expect(func.locator("li h3")).toHaveText([/^Biblioteca de vídeos$/, /^Card Editorial\s*Em homologação$/, /^Calendário de conteúdo$/, /^Agendamento$/, /^Histórico de publicações$/]);
  await expect(func.getByRole("link", { name: "Explorar demonstração" })).toHaveAttribute("href", "#demonstracao");
  // composição desktop: os 5 blocos visíveis ao redor do monograma, sem sobrepor o centro
  const hub = (await func.locator("[class*=featuresHub]").boundingBox())!;
  for (const li of await func.locator("li").all()) {
    await expect(li).toBeVisible();
    const b = (await li.boundingBox())!;
    const overlaps = b.x < hub.x + hub.width && b.x + b.width > hub.x && b.y < hub.y + hub.height && b.y + b.height > hub.y;
    expect(overlaps).toBe(false);
  }

  const integ = page.locator("#integracoes");
  await expect(integ.locator("h2")).toHaveCount(1);
  await expect(integ.locator("h2")).toHaveText("Suas redes, um só painel");
  await expect(integ.getByRole("listitem")).toHaveText([/Instagram\s*Em teste/, /Facebook\s*Em teste/, /TikTok\s*Planejado/, /YouTube\s*Planejado/]);
  for (const img of await integ.locator("img").all()) {
    await expect(img).toHaveAttribute("loading", "lazy");
    await expect(img).toHaveAttribute("alt", "");
    expect(Number(await img.getAttribute("width"))).toBeGreaterThan(0);
    expect(Number(await img.getAttribute("height"))).toBeGreaterThan(0);
  }
  // nenhuma arte com status enganoso: as imagens completas não são usadas enquanto houver item em teste/planejado
  await expect(page.locator('img[src*="arte-"]')).toHaveCount(0);
});

for (const w of [320, 390]) {
  test(`funcionalidades/integrações no celular ${w}px: lista e grade legíveis`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 800 });
    await page.goto("/");
    await page.locator("#integracoes").scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    const fs = await page.locator("#funcionalidades li h3").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fs).toBeGreaterThanOrEqual(16);
    const cards = await page.locator("#integracoes li").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    expect(Math.min(...cards)).toBeGreaterThan(120);
    await expect(page.locator("#integracoes [data-line]")).toHaveCount(4);
  });
}

/** Pulsos das integrações: saem do centro, seguem a curva e terminam no card certo. */
async function checkConnectors(page: Page) {
  const panel = page.locator("#integracoes");
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.locator("[data-line]")).toHaveCount(4);
  const geo = await page.evaluate(() => {
    const svg = document.querySelector("#integracoes svg[data-active]") as SVGSVGElement;
    const sb = svg.getBoundingClientRect();
    const hub = document.querySelector("[data-hub]")!.getBoundingClientRect();
    const cards = [...document.querySelectorAll("[data-network]")].map((c) => c.getBoundingClientRect());
    const lines = [...svg.querySelectorAll("[data-line] > path:first-child")].map((p) => {
      const path = p as SVGPathElement, L = path.getTotalLength();
      const a = path.getPointAtLength(0), b = path.getPointAtLength(L);
      return { start: [a.x + sb.left, a.y + sb.top], end: [b.x + sb.left, b.y + sb.top] };
    });
    return { hub: [hub.left + hub.width / 2, hub.bottom] as [number, number], cards: cards.map((c) => [c.left + c.width / 2, c.top] as [number, number]), lines: lines as { start: [number, number]; end: [number, number] }[] };
  });
  geo.lines.forEach((l, i) => {
    expect(Math.abs(l.start[0] - geo.hub[0])).toBeLessThan(1.5);
    expect(Math.abs(l.start[1] - geo.hub[1])).toBeLessThan(1.5);
    expect(Math.abs(l.end[0] - geo.cards[i]![0])).toBeLessThan(1.5);
    expect(Math.abs(l.end[1] - geo.cards[i]![1])).toBeLessThan(1.5);
  });
  // amostra o núcleo do pulso durante o percurso: distância à curva < 2 px
  const maxDist = await page.evaluate(async () => {
    const svg = document.querySelector("#integracoes svg[data-active]") as SVGSVGElement;
    const sb = () => svg.getBoundingClientRect();
    let worst = 0, samples = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 4200) {
      for (const g of svg.querySelectorAll("[data-line]")) {
        const core = g.querySelector("[data-pulse]") as SVGCircleElement;
        if (Number(getComputedStyle(core).opacity) < 0.5) continue;
        const cb = core.getBoundingClientRect(), b = sb();
        const x = cb.left + cb.width / 2 - b.left, y = cb.top + cb.height / 2 - b.top;
        const path = g.querySelector("path") as SVGPathElement, L = path.getTotalLength();
        let best = Infinity;
        for (let s = 0; s <= L; s += 1) { const p = path.getPointAtLength(s); best = Math.min(best, Math.hypot(p.x - x, p.y - y)); }
        worst = Math.max(worst, best); samples++;
      }
      await new Promise((r) => setTimeout(r, 90));
    }
    return { worst, samples };
  });
  expect(maxDist.samples).toBeGreaterThan(20);
  expect(maxDist.worst).toBeLessThan(2);
}

for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`integrações ${vp.width}px: pulsos saem do centro, seguem a linha e chegam ao card certo`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto("/");
    await checkConnectors(page);
    // decorativo: fora do teclado e sem interceptar cliques
    const svg = page.locator("#integracoes svg[data-active]");
    await expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(await svg.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  });
}

test("integrações: pausa fora da tela e só linhas estáticas com movimento reduzido", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const svg = page.locator("#integracoes svg[data-active]");
  await expect(svg).toHaveAttribute("data-active", "false"); // abertura: seção fora da tela
  const paused = await page.evaluate(() => [...document.querySelectorAll("#integracoes [data-pulse]")].map((c) => getComputedStyle(c).animationPlayState));
  expect(paused.every((s) => s === "paused")).toBe(true);
  await page.locator("#integracoes").scrollIntoViewIfNeeded();
  await expect(svg).toHaveAttribute("data-active", "true");

  const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  const p2 = await ctx.newPage();
  await p2.goto(page.url());
  await p2.locator("#integracoes").scrollIntoViewIfNeeded();
  await expect(p2.locator("#integracoes [data-line]")).toHaveCount(4);
  const vis = await p2.evaluate(() => ({
    pulses: [...document.querySelectorAll("#integracoes [data-pulse]")].map((c) => getComputedStyle(c).display),
    bases: [...document.querySelectorAll("#integracoes [data-line] > path:first-child")].map((c) => getComputedStyle(c).display),
    anim: [...document.querySelectorAll("#integracoes [data-end]")].map((c) => getComputedStyle(c).animationName),
  }));
  expect(vis.pulses.every((d) => d === "none")).toBe(true);
  expect(vis.bases.every((d) => d !== "none")).toBe(true);
  expect(vis.anim.every((a) => a === "none")).toBe(true);
  await ctx.close();
});
