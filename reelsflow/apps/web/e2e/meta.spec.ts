import { expect, test } from "@playwright/test";

test.describe("páginas legais e integração Meta (sem credenciais)", () => {
  test("política de privacidade e termos públicos, marcados como rascunho", async ({ page }) => {
    for (const [path, title] of [["/privacy", "Política de Privacidade"], ["/terms", "Termos de Uso"]] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      await expect(page.getByRole("note")).toContainText("Rascunho");
    }
    await page.goto("/privacy");
    await expect(page.getByText("instagram_content_publish", { exact: false })).toBeVisible();
  });

  test("cadastro tem links para termos e privacidade", async ({ page }) => {
    await page.goto("/signup");
    await expect(page.getByRole("link", { name: "termos de uso" })).toHaveAttribute("href", "/terms");
    await expect(page.getByRole("link", { name: "política de privacidade" })).toHaveAttribute("href", "/privacy");
  });

  test("callback de exclusão de dados recusa sem configuração/assinatura", async ({ request }) => {
    const res = await request.post("/api/meta/data-deletion", { form: { signed_request: "x.y" } });
    expect([400, 503]).toContain(res.status());
  });

  test("status de exclusão com código inválido", async ({ page }) => {
    await page.goto("/data-deletion/nao-existe");
    await expect(page.getByText("Código não encontrado")).toBeVisible();
  });

  test("início do OAuth exige login", async ({ page }) => {
    await page.goto("/api/oauth/meta/start?w=qualquer");
    await expect(page).toHaveURL(/\/login/);
  });

  test("callback do OAuth sem sessão volta ao login", async ({ page }) => {
    await page.goto(`/api/oauth/meta/callback?code=x&state=${"a".repeat(64)}`);
    await expect(page).toHaveURL(/\/login/);
  });
});
