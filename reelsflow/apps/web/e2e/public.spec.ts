import { expect, test } from "@playwright/test";

test.describe("páginas públicas", () => {
  test("landing apresenta proposta e chamadas", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Seus vídeos. Suas regras. Tudo no automático.");
    await expect(page.getByRole("link", { name: "Começar agora" })).toHaveAttribute("href", "/signup");
    await expect(page.locator("html")).toHaveClass(/dark/);
  });

  test("sem rolagem horizontal", async ({ page }) => {
    for (const path of ["/", "/login", "/signup"]) {
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });

  test("alterna para tema claro", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Ativar tema claro" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  });

  test("cabeçalhos de segurança", async ({ request }) => {
    const res = await request.get("/");
    expect(res.headers()["x-frame-options"]).toBe("DENY");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers()["x-powered-by"]).toBeUndefined();
  });
});

test.describe("formulários de autenticação", () => {
  test("login valida campos antes de chamar o Auth", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByText("E-mail inválido.")).toBeVisible();
    await expect(page.getByText("Informe a senha.")).toBeVisible();
  });

  test("login com Auth indisponível mostra erro genérico, sem quebrar", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("E-mail").fill("pessoa@example.com");
    await page.getByLabel("Senha").fill("qualquer1");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível concluir" })).toBeVisible();
    await expect(page.getByLabel("E-mail")).toHaveValue("pessoa@example.com");
  });

  test("cadastro exige senha forte e aceite dos termos", async ({ page }) => {
    await page.goto("/signup");
    await page.getByLabel("Nome").fill("Ana");
    await page.getByLabel("E-mail").fill("ana@example.com");
    await page.getByLabel("Senha").fill("curta");
    await page.getByRole("button", { name: "Criar conta" }).click();
    await expect(page.getByText("A senha deve ter pelo menos 8 caracteres.")).toBeVisible();

    await page.getByLabel("Senha").fill("senhaforte1");
    await page.getByRole("button", { name: "Criar conta" }).click();
    await expect(page.getByText("É necessário aceitar os termos para continuar.")).toBeVisible();
  });

  test("recuperação de senha valida e-mail", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.getByLabel("E-mail").fill("invalido");
    await page.getByRole("button", { name: "Enviar link de redefinição" }).click();
    await expect(page.getByText("E-mail inválido.")).toBeVisible();
  });
});

test.describe("controle de acesso", () => {
  for (const path of ["/w", "/w/qualquer/overview", "/w/qualquer/settings", "/w/qualquer/library", "/w/qualquer/upload", "/w/qualquer/calendar", "/w/qualquer/queue", "/w/qualquer/campaigns/new", "/w/qualquer/templates", "/w/qualquer/accounts", "/w/qualquer/automations", "/onboarding", "/account", "/reset-password"]) {
    test(`${path} exige login`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login(\?|$)/);
      const url = new URL(page.url());
      expect(url.searchParams.get("next")).toBe(path);
    });
  }

  test("link de confirmação inválido volta ao login com aviso", async ({ page }) => {
    await page.goto("/auth/confirm");
    await expect(page).toHaveURL(/\/login\?notice=link-invalid/);
    await expect(page.getByText("O link é inválido ou expirou.")).toBeVisible();
  });

  test("logout não aceita GET", async ({ request }) => {
    const res = await request.get("/auth/signout", { maxRedirects: 0 });
    expect(res.status()).toBe(405);
  });
});
