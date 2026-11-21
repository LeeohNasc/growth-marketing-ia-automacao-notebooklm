import { expect, test } from "@playwright/test";

/**
 * Rotas de cobrança no app compilado, sem backend nem Stripe configurados (como o E2E atual).
 * A lógica de checkout/webhook com banco real está em supabase/tests/src/billing.test.ts.
 */
test.beforeEach(({}, info) => test.skip(info.project.name !== "desktop", "sem dependência de viewport"));

test("CTA de plano pago deslogado leva ao login preservando a escolha", async ({ page }) => {
  await page.goto("/billing/start?plan=business&interval=month");
  await expect(page).toHaveURL(/\/login\?next=%2Fbilling%2Fstart%3Fplan%3Dbusiness%26interval%3Dmonth$/);
  // "Criar conta" também preserva a escolha
  await expect(page.getByRole("link", { name: "Criar conta" })).toHaveAttribute("href", "/signup?next=%2Fbilling%2Fstart%3Fplan%3Dbusiness%26interval%3Dmonth");
});

test("Starter não tem checkout: vai para o cadastro; plano inválido volta aos planos", async ({ page }) => {
  await page.goto("/billing/start?plan=starter");
  await expect(page).toHaveURL(/\/signup$/);
  await page.goto("/billing/start?plan=gold");
  await expect(page).toHaveURL(/\/#planos$/);
});

test("landing: Starter → cadastro; sem cobrança configurada, planos pagos sem botão de compra", async ({ page }) => {
  await page.goto("/");
  const planos = page.locator("#planos");
  await expect(planos.locator("[data-plan='starter']").getByRole("link", { name: "Começar grátis" })).toHaveAttribute("href", "/signup");
  await expect(planos.getByRole("link", { name: /Assinar/ })).toHaveCount(0);
  await expect(planos.locator("[data-plan='business']")).toContainText("1 marca (planejado)");
  await expect(planos.locator("[data-plan='pro']")).toContainText("Card Editorial (em homologação)");
});

test("checkout: POST de outra origem é recusado (CSRF)", async ({ request }) => {
  const res = await request.post("/api/billing/checkout", {
    headers: { origin: "https://evil.example" },
    form: { workspace: "00000000-0000-0000-0000-000000000000", plan: "business", interval: "month" },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(403);
});

test("checkout deslogado redireciona ao login; portal de outra origem recusado", async ({ request, baseURL }) => {
  const res = await request.post("/api/billing/checkout", {
    headers: { origin: baseURL! },
    form: { workspace: "00000000-0000-0000-0000-000000000000", plan: "premium", interval: "month" },
    maxRedirects: 0,
  });
  expect(res.status()).toBe(303);
  expect(res.headers()["location"]).toContain("/login?next=%2Fbilling%2Fstart%3Fplan%3Dpremium%26interval%3Dmonth");
  const portal = await request.post("/api/billing/portal", { headers: { origin: "https://evil.example" }, form: { workspace: "x" }, maxRedirects: 0 });
  expect(portal.status()).toBe(403);
});

test("webhook: sem configuração responde 503; status exige login", async ({ request }) => {
  const wh = await request.post("/api/billing/webhook", { data: "{}", headers: { "stripe-signature": "t=1,v1=x" } });
  expect(wh.status()).toBe(503);
  const st = await request.get("/api/billing/status?workspace=00000000-0000-0000-0000-000000000000");
  expect(st.status()).toBe(401);
});
