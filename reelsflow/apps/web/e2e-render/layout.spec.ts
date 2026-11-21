import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * Layout do editor do Card Editorial (editor REAL, casca do app replicada):
 * colunas independentes, prévia fixa e inteira, rolagem própria, celular com prévia compacta.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "samples");
mkdirSync(OUT, { recursive: true });
const FX = path.join(__dirname, "site", "fixtures");
const WS = "11111111-1111-4111-8111-111111111111";
const card = (over: Record<string, unknown> = {}) => ({
  id: "22222222-2222-4222-8222-222222222222", workspace_id: WS, created_by: null, template_type: "editorial_card", template_version: 1,
  title: "Post – Meus Parceiros", page_name: "Pipocou | Humor e Memes", username: "pipocoumemes", headline: "Eu e os meus parceiros", caption: null,
  hashtags: [], format: "vertical", media_kind: "video", fit: "cover", style: {}, focal: [], avatar_path: null, media_paths: [], media_meta: {},
  social_account_id: null, render_status: "draft", render_error: null, rendered_media_id: null, render_started_at: null, rendered_at: null,
  created_at: "", updated_at: "", ...over,
});

async function mount(page: Page, c = card()) {
  await page.goto("/editor.html");
  await page.waitForSelector("body[data-ready='1']", { state: "attached" });
  await page.evaluate(
    ([cc, ws]) => (window as unknown as { mountEditor: (p: unknown) => void }).mountEditor({ slug: "leeoh", workspaceId: ws, canEdit: true, card: cc, sourceUrls: { avatar: null, media: [], logo: null }, accounts: [], renderedUrl: null }),
    [c, WS] as const,
  );
  await expect(page.getByText(/Carregando arquivos salvos/)).toHaveCount(0, { timeout: 15_000 });
  await page.getByLabel("Foto do perfil (recorte redondo central)").setInputFiles(path.join(FX, "avatar.png"));
}
const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;
const canvasHash = (page: Page) => page.evaluate(() => {
  const c = document.querySelector("canvas")!;
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  let h = 0;
  for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]!) | 0;
  return h;
});

for (const [w, h] of [[1366, 768], [1920, 1080]] as const) {
  test.describe(`desktop ${w}×${h}`, () => {
    test.use({ viewport: { width: w, height: h } });

    test("prévia 9:16 inteira e fixa; formulário com rolagem própria; página não rola", async ({ page }) => {
      await mount(page);
      await page.getByLabel("Arquivo do vídeo").setInputFiles(path.join(FX, "vertical-noaudio.mp4"));
      await expect(page.getByRole("button", { name: "Reproduzir" })).toBeVisible();
      await page.waitForTimeout(300);
      const c = await box(page, "canvas");
      // inteira na janela, proporção 9:16 preservada, tamanho útil
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y + c.height).toBeLessThanOrEqual(h);
      expect(c.width / c.height).toBeCloseTo(9 / 16, 2);
      expect(c.height).toBeGreaterThan(h * 0.4);
      // resolução real do arquivo intacta
      expect(await page.evaluate(() => [document.querySelector("canvas")!.width, document.querySelector("canvas")!.height])).toEqual([1080, 1920]);
      // ações acessíveis sem rolar a página
      const save = await box(page, "button:has-text('Salvar rascunho')");
      expect(save.y + save.height).toBeLessThanOrEqual(h);

      // a página não rola; o formulário sim, e a prévia não se move
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight + 1)).toBe(true);
      const form = page.getByRole("form", { name: "Configuração do card" });
      const info = await form.evaluate((f) => ({ sh: f.scrollHeight, ch: f.clientHeight, ov: getComputedStyle(f).overflowY }));
      expect(info.ov).toBe("auto");
      expect(info.sh).toBeGreaterThan(info.ch);
      await form.evaluate((f) => (f.scrollTop = f.scrollHeight));
      await page.waitForTimeout(150);
      const after = await box(page, "canvas");
      expect([after.x, after.y, after.width, after.height]).toEqual([c.x, c.y, c.width, c.height]);
      expect(await form.evaluate((f) => f.scrollTop)).toBeGreaterThan(0);
      await page.screenshot({ path: path.join(OUT, `layout-${w}x${h}-scrolled.png`) });

      // campo do fim do formulário continua editável e a alteração aparece na prévia
      await page.getByLabel("Legenda da postagem").fill("Legenda editada no fim do formulário");
      await expect(page.getByLabel("Legenda da postagem")).toHaveValue("Legenda editada no fim do formulário");
      await form.evaluate((f) => (f.scrollTop = 0));
      await page.screenshot({ path: path.join(OUT, `layout-${w}x${h}.png`) });
    });

    test("teclado: Tab percorre os campos e o campo focado fica visível dentro do painel", async ({ page }) => {
      await mount(page);
      await page.getByLabel("Título interno").focus();
      const form = page.getByRole("form", { name: "Configuração do card" });
      // percorre o formulário inteiro: o campo focado sempre visível no painel; o painel rola sozinho
      let scrolled = false;
      for (let i = 0; i < 120; i++) {
        await page.keyboard.press("Tab");
        const r = await page.evaluate(() => {
          const a = document.activeElement as HTMLElement;
          const f = document.querySelector('form[aria-label="Configuração do card"]')!;
          const vis = a.closest(".sr-only") || a.classList.contains("sr-only") ? (a.parentElement as HTMLElement) : a;
          const ab = vis.getBoundingClientRect();
          const fb = f.getBoundingClientRect();
          return { inForm: f.contains(a), visible: ab.top >= fb.top - 1 && ab.bottom <= fb.bottom + 1, st: f.scrollTop, y: window.scrollY };
        });
        if (!r.inForm) break;
        expect(r.visible).toBe(true);
        expect(r.y).toBe(0);
        if (r.st > 0) scrolled = true;
      }
      expect(scrolled).toBe(true);
      expect(await form.evaluate((f) => f.scrollTop)).toBeGreaterThan(0);
    });

    test("4:5 e 1:1: proporção exata e inteiros na janela", async ({ page }) => {
      await mount(page, card({ media_kind: "image", format: "feed" }));
      await page.getByLabel("Arquivo da foto").setInputFiles(path.join(FX, "photo1.jpg"));
      for (const [label, ratio, dims] of [["Feed 4:5", 4 / 5, [1080, 1350]], ["Quadrado 1:1", 1, [1080, 1080]], ["Vertical 9:16", 9 / 16, [1080, 1920]]] as const) {
        await page.getByText(label, { exact: true }).click();
        await page.waitForTimeout(200);
        const c = await box(page, "canvas");
        expect(c.width / c.height).toBeCloseTo(ratio, 2);
        expect(c.y + c.height).toBeLessThanOrEqual(h);
        expect(await page.evaluate(() => [document.querySelector("canvas")!.width, document.querySelector("canvas")!.height])).toEqual([...dims]);
      }
    });

    test("editar texto e foto durante a reprodução atualiza a prévia sem reiniciar o vídeo", async ({ page }) => {
      await mount(page);
      await page.getByLabel("Arquivo do vídeo").setInputFiles(path.join(FX, "source.mp4"));
      await page.getByRole("button", { name: "Reproduzir" }).click();
      await page.waitForTimeout(700);
      const t1 = await page.evaluate(() => document.querySelector("video")!.currentTime);
      const before = await canvasHash(page);
      await page.getByLabel("Texto do card").fill("Manchete alterada durante a reprodução");
      await page.getByLabel("Foto do perfil (recorte redondo central)").setInputFiles(path.join(FX, "logo.png"));
      await page.waitForTimeout(700);
      const v = await page.evaluate(() => ({ t: document.querySelector("video")!.currentTime, paused: document.querySelector("video")!.paused }));
      expect(v.paused).toBe(false);
      expect(v.t).toBeGreaterThan(t1); // não reiniciou nem parou
      expect(await canvasHash(page)).not.toBe(before);
      // a prévia continua sendo redesenhada quadro a quadro depois das edições
      const h1 = await canvasHash(page);
      await page.waitForTimeout(400);
      expect(await canvasHash(page)).not.toBe(h1);
    });
  });
}

test.describe("celular 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("prévia compacta fixa no topo, expandir/recolher, sem rolagem horizontal, controles acessíveis", async ({ page }) => {
    await mount(page);
    await page.getByLabel("Arquivo do vídeo").setInputFiles(path.join(FX, "vertical-noaudio.mp4"));
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const compact = await box(page, "#ec-preview-stage");
    expect(compact.height).toBeLessThan(844 * 0.45);
    const c = await box(page, "canvas");
    expect(c.width / c.height).toBeCloseTo(9 / 16, 2);
    expect(c.y + c.height).toBeLessThanOrEqual(compact.y + compact.height + 1); // 9:16 inteiro dentro da área
    await page.screenshot({ path: path.join(OUT, "layout-390x844.png") });

    // rola a página: a prévia continua visível (fixa abaixo do cabeçalho)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(200);
    const stuck = await box(page, "canvas");
    expect(stuck.y).toBeGreaterThanOrEqual(56 - 1);
    expect(stuck.y + stuck.height).toBeLessThanOrEqual(844);
    await page.screenshot({ path: path.join(OUT, "layout-390x844-scrolled.png") });

    // ampliar, reduzir, recolher e mostrar
    await page.getByRole("button", { name: "Ampliar" }).click();
    expect((await box(page, "#ec-preview-stage")).height).toBeGreaterThan(compact.height * 1.5);
    await page.getByRole("button", { name: "Reduzir" }).click();
    await page.getByRole("button", { name: "Recolher" }).click();
    await expect(page.locator("#ec-preview-stage")).toBeHidden();
    await page.getByRole("button", { name: "Mostrar prévia" }).click();
    await expect(page.locator("#ec-preview-stage")).toBeVisible();

    // todos os controles alcançáveis: ações e duplicar/excluir existem e são clicáveis
    for (const name of ["Salvar rascunho", "Renderizar arquivo final", "Duplicar", "Excluir"]) {
      const b = page.getByRole("button", { name });
      await b.scrollIntoViewIfNeeded();
      await expect(b).toBeVisible();
    }
  });

  test("ao digitar (teclado virtual) a prévia recolhe e o campo fica visível; ao sair, volta", async ({ page }) => {
    await mount(page);
    await page.getByLabel("Arquivo do vídeo").setInputFiles(path.join(FX, "vertical-noaudio.mp4"));
    const field = page.getByLabel("Texto do card");
    await field.scrollIntoViewIfNeeded();
    await field.focus();
    await expect(page.locator("#ec-preview-stage")).toBeHidden();
    // simula o teclado virtual ocupando metade da tela
    await page.setViewportSize({ width: 390, height: 420 });
    await field.fill("Digitando com o teclado aberto");
    const fb = await field.boundingBox();
    expect(fb!.y + 20).toBeLessThan(420);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Salvar rascunho" }).focus();
    await expect(page.locator("#ec-preview-stage")).toBeVisible();
  });
});

test.describe("tablet 820×1180 e 1024×768", () => {
  for (const [w, h] of [[820, 1180], [1024, 768]] as const) {
    test(`${w}×${h}: duas colunas adaptadas, prévia inteira, sem rolagem horizontal`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await mount(page);
      await page.getByLabel("Arquivo do vídeo").setInputFiles(path.join(FX, "vertical-noaudio.mp4"));
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const c = await box(page, "canvas");
      const f = await page.getByRole("form", { name: "Configuração do card" }).boundingBox();
      expect(c.x).toBeGreaterThan(f!.x + f!.width - 1); // prévia à direita do formulário
      expect(c.y + c.height).toBeLessThanOrEqual(h);
      expect(c.width / c.height).toBeCloseTo(9 / 16, 2);
      await page.screenshot({ path: path.join(OUT, `layout-${w}x${h}.png`) });
    });
  }
});
