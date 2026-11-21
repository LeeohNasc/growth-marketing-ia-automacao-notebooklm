import { expect, test, type Page } from "@playwright/test";

/** Identidade visual: assinatura/monograma oficiais, acessibilidade e ícones. */
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "viewports definidos no teste"));

const OLD_PLAY = "M8 5.5v13l10-6.5-10-6.5Z";
const LOCKUP_RATIO = 1349 / 312;

async function checkBrandLink(page: Page, scope: ReturnType<Page["locator"]>, name: RegExp) {
  const link = scope.getByRole("link", { name }).first();
  await expect(link).toBeVisible();
  const svg = link.locator("svg").first();
  await expect(svg).toHaveAttribute("aria-hidden", "true");
  const box = (await svg.boundingBox())!;
  expect(box.width / box.height).toBeCloseTo(LOCKUP_RATIO, 1); // sem esticar
  expect(await link.evaluate((el) => el.textContent?.trim() ?? "")).toBe(""); // sem nome duplicado ao lado
  return link;
}

test("favicon, ícone SVG e apple-touch-icon publicados", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveCount(1);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  for (const url of ["/favicon.ico", "/icon.svg", "/apple-icon.png", "/brand/reelsflow-logo-horizontal-on-dark.svg", "/brand/reelsflow-logo-horizontal-on-light.svg", "/brand/reelsflow-monogram.svg", "/brand/reelsflow-icon-512-dark.png"]) {
    const res = await request.get(url);
    expect(res.status(), url).toBe(200);
  }
  const svg = await (await request.get("/icon.svg")).text();
  expect(svg).toContain("#FF1734");
});

test("landing: assinatura no header e no rodapé (desktop e celular), sem o play antigo", async ({ page }) => {
  for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(vp);
    await page.goto("/");
    await checkBrandLink(page, page.getByRole("banner"), /ReelsFlow/);
    await checkBrandLink(page, page.getByRole("contentinfo"), /ReelsFlow/);
    const color = await page.getByRole("banner").getByRole("link", { name: /ReelsFlow/ }).evaluate((el) => getComputedStyle(el).color);
    expect(color).toBe("rgb(247, 247, 248)"); // texto #F7F7F8 no fundo escuro
    expect(await page.locator(`header path[d="${OLD_PLAY}"], footer path[d="${OLD_PLAY}"]`).count()).toBe(0);
  }
});

test("login/cadastro: assinatura com nome acessível; cor do texto acompanha o tema", async ({ page }) => {
  for (const path of ["/login", "/signup", "/privacy"]) {
    await page.goto(path);
    await checkBrandLink(page, page.locator("body"), /^ReelsFlow$/);
    expect(await page.locator(`path[d="${OLD_PLAY}"]`).count(), path).toBe(0);
  }
  await page.goto("/login");
  const dark = await page.getByRole("link", { name: /^ReelsFlow$/ }).evaluate((el) => getComputedStyle(el).color);
  expect(dark).toBe("rgb(247, 247, 248)");
  await page.getByRole("button", { name: "Ativar tema claro" }).click();
  await expect.poll(() => page.getByRole("link", { name: /^ReelsFlow$/ }).evaluate((el) => getComputedStyle(el).color)).toBe("rgb(11, 11, 12)");
});
