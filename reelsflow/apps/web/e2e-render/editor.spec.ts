import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * Editor REAL do Card Editorial (componente da aplicação) montado com Supabase falso.
 * Prova: interface nos 3 formatos, rascunho, render real no navegador, envio do ARQUIVO FINAL
 * pelo pipeline (begin → upload → complete → attach), estados e liberação do "Agendar".
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "samples");
mkdirSync(OUT, { recursive: true });
const FX = path.join(__dirname, "site", "fixtures");
const WS = "11111111-1111-4111-8111-111111111111";
const CARD = "22222222-2222-4222-8222-222222222222";

const baseCard = (over: Record<string, unknown> = {}) => ({
  id: CARD, workspace_id: WS, created_by: null, template_type: "editorial_card", template_version: 1, title: "Card de teste",
  page_name: "", username: "", headline: "", caption: null, hashtags: [], format: "feed", media_kind: "image", fit: "cover",
  style: {}, focal: [], avatar_path: null, media_paths: [], media_meta: {}, social_account_id: null, render_status: "draft",
  render_error: null, rendered_media_id: null, render_started_at: null, rendered_at: null, created_at: "", updated_at: "", ...over,
});
const accounts = [{ id: "acc-1", display_name: "🍿 Pipocou | Humor e Memes", username: "pipocoumemes", platform: "instagram", provider: "zernio" }];

async function mount(page: Page, card = baseCard(), sourceUrls: { avatar: string | null; media: (string | null)[]; logo: string | null } = { avatar: null, media: [], logo: null }, waitReady = true) {
  await page.goto("/editor.html");
  await page.waitForSelector("body[data-ready='1']", { state: "attached" });
  await page.evaluate(
    ([c, a, slug, ws, urls]) => (window as unknown as { mountEditor: (p: unknown) => void }).mountEditor({ slug, workspaceId: ws, canEdit: true, card: c, sourceUrls: urls, accounts: a, renderedUrl: null }),
    [card, accounts, "leeoh", WS, sourceUrls] as const,
  );
  await expect(page.getByRole("heading", { name: "Manchete" })).toBeVisible();
  if (waitReady) await expect(page.getByText(/Carregando arquivos salvos/)).toHaveCount(0, { timeout: 15_000 });
}
const fake = (page: Page) => page.evaluate(() => {
  const f = (window as unknown as { __fake: { card: Record<string, unknown>; calls: { op: string; args: Record<string, unknown> }[]; storage: Map<string, Blob> } }).__fake;
  return { card: f.card, calls: f.calls, paths: [...f.storage.keys()] };
});
const storedB64 = (page: Page, p: string) =>
  page.evaluate(async (k) => {
    const b = (window as unknown as { __fake: { storage: Map<string, Blob> } }).__fake.storage.get(k)!;
    const bytes = new Uint8Array(await b.arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, p);
const ffprobe = (f: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", f]).toString());

test.use({ viewport: { width: 1440, height: 1000 } });

test("editor de imagem: preencher, três formatos, salvar, renderizar e enviar o ARQUIVO FINAL", async ({ page }) => {
  await mount(page);
  await page.screenshot({ path: path.join(OUT, "editor-empty.png"), fullPage: true });

  // perfil a partir da conta conectada (editável), foto, manchete e mídia
  await page.getByLabel("Preencher com uma conta conectada").selectOption("acc-1");
  await expect(page.getByLabel("Nome da página")).toHaveValue("🍿 Pipocou | Humor e Memes");
  await expect(page.getByLabel("@usuário")).toHaveValue("pipocoumemes");
  await page.getByLabel("Nome da página").fill("Pipocou");
  await page.getByLabel("Foto do perfil (recorte redondo central)").setInputFiles(path.join(FX, "avatar.png"));
  await page.getByLabel("Texto do card").fill("🚨 VEJA | Câmara aprova projeto e votação vira assunto nas redes");
  await expect(page.getByText(/^\d+\/280$/)).toHaveText("63/280");
  await page.getByLabel("Arquivo da foto").setInputFiles(path.join(FX, "photo1.jpg"));
  await expect(page.getByText("Envie a foto.")).toHaveCount(0);

  for (const [label, file] of [["Feed 4:5", "editor-feed.png"], ["Quadrado 1:1", "editor-square.png"], ["Vertical 9:16", "editor-vertical.png"]] as const) {
    await page.getByText(label, { exact: true }).click();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT, file), fullPage: true });
  }
  // 9:16 em imagem: restrição do feed do Instagram visível ANTES de agendar
  await expect(page.getByText(/Imagem 9:16 não é aceita no feed do Instagram/)).toBeVisible();
  await page.getByText("Feed 4:5", { exact: true }).click();

  await page.getByRole("button", { name: "Salvar rascunho" }).click();
  await expect(page.getByText("Rascunho salvo.")).toBeVisible();
  let f = await fake(page);
  const saved = f.calls.filter((c) => c.op === "update:editorial_cards").at(-1)!.args;
  expect(saved).toMatchObject({ page_name: "Pipocou", username: "pipocoumemes", format: "feed", media_kind: "image" });
  expect(String(saved.avatar_path)).toMatch(new RegExp(`^${WS}/cards/${CARD}/avatar-[0-9a-f-]+\\.png$`));
  expect((saved.media_paths as string[])[0]).toMatch(new RegExp(`^${WS}/cards/${CARD}/image-[0-9a-f-]+\\.jpg$`));

  await page.getByRole("button", { name: "Renderizar arquivo final" }).click();
  await expect(page.getByText("Pronto para agendar")).toBeVisible({ timeout: 60_000 });
  f = await fake(page);
  const ops = f.calls.map((c) => c.op);
  // ordem do pipeline real de mídia
  const order = ["rpc:set_card_render_state", "rpc:begin_media_upload", "rpc:complete_media_upload", "rpc:attach_card_render"].map((o) => ops.indexOf(o));
  expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]!))).toBe(true);
  const finalPath = f.paths.find((p) => p.endsWith("/original.jpg"))!;
  expect(finalPath.startsWith(`${WS}/`)).toBe(true);
  expect(finalPath.includes("/cards/")).toBe(false); // o arquivo final é uma mídia, não a origem
  const begin = f.calls.find((c) => c.op === "rpc:begin_media_upload")!.args as { p_files: { mime: string; sha256: string }[] };
  expect(begin.p_files[0]!.mime).toBe("image/jpeg");
  expect(begin.p_files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);

  // o arquivo ENVIADO é o card renderizado (1080×1350, com avatar e texto), não a foto original
  const file = path.join(OUT, "editor-final-feed.jpg");
  writeFileSync(file, Buffer.from(await storedB64(page, finalPath), "base64"));
  const s = ffprobe(file).streams[0];
  expect([s.codec_name, s.width, s.height]).toEqual(["mjpeg", 1080, 1350]);

  const agendar = page.getByRole("link", { name: "Agendar" });
  await expect(agendar).toHaveAttribute("href", `/w/leeoh/campaigns/new?media=${f.card.rendered_media_id}`);
  await page.screenshot({ path: path.join(OUT, "editor-ready.png"), fullPage: true });

  // editar depois do render: volta a exigir nova renderização e bloqueia "Agendar"
  await page.getByLabel("Texto do card").fill("🚨 VEJA | Manchete alterada");
  await expect(page.getByText("Alterações não salvas")).toBeVisible();
  await expect(page.getByRole("link", { name: "Agendar" })).toHaveCount(0);
});

test("overflow da manchete bloqueia renderização com mensagem; redução explícita da fonte libera", async ({ page }) => {
  await mount(page, baseCard({ page_name: "Pipocou", username: "pipocoumemes", format: "square" }));
  await page.getByLabel("Arquivo da foto").setInputFiles(path.join(FX, "photo1.jpg"));
  await page.getByLabel("Texto do card").fill(Array.from({ length: 11 }, () => "Linha longa de manchete").join("\n"));
  await expect(page.getByText(/reduza a fonte/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Renderizar arquivo final" })).toBeDisabled();
  await page.getByLabel(/Tamanho da fonte da manchete/).fill("0.7");
  await expect(page.getByRole("button", { name: "Renderizar arquivo final" })).toBeEnabled();
});

test("falha no envio do arquivo final: estado de erro, rascunho preservado, nova tentativa funciona", async ({ page }) => {
  await mount(page, baseCard({ page_name: "Pipocou", username: "pipocoumemes", headline: "Manchete" }));
  await page.getByLabel("Arquivo da foto").setInputFiles(path.join(FX, "photo1.jpg"));
  await page.evaluate(() => ((window as unknown as { __fake: { failNextUpload: boolean } }).__fake.failNextUpload = true));
  await page.getByRole("button", { name: "Renderizar arquivo final" }).click();
  await expect(page.getByText(/Erro de render: Falha ao enviar o arquivo final/)).toBeVisible({ timeout: 60_000 });
  let f = await fake(page);
  expect(f.card.render_status).toBe("error");
  expect(f.calls.some((c) => c.op === "rpc:cancel_media_upload")).toBe(true); // registro órfão cancelado
  await expect(page.getByLabel("Texto do card")).toHaveValue("Manchete");
  await page.getByRole("button", { name: "Renderizar arquivo final" }).click();
  await expect(page.getByText("Pronto para agendar")).toBeVisible({ timeout: 60_000 });
  f = await fake(page);
  expect(f.calls.filter((c) => c.op === "rpc:attach_card_render")).toHaveLength(1);
});

test("editor de vídeo: prévia com controles, MP4 final H.264 yuv420p com áudio AAC e miniatura enviados", async ({ page }) => {
  await mount(page, baseCard({ page_name: "Pipocou", username: "pipocoumemes", headline: "🚨 VEJA | Vídeo do dia", media_kind: "video" }));
  await page.getByLabel("Arquivo do vídeo").setInputFiles(path.join(FX, "source.mp4"));
  await expect(page.getByRole("button", { name: "Reproduzir" })).toBeVisible();
  await page.getByRole("button", { name: "Reproduzir" }).click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Pausar" }).click();
  await page.screenshot({ path: path.join(OUT, "editor-video.png"), fullPage: true });
  await page.getByRole("button", { name: "Renderizar arquivo final" }).click();
  await expect(page.getByText("Pronto para agendar")).toBeVisible({ timeout: 120_000 });
  const f = await fake(page);
  const mp4 = f.paths.find((p) => p.endsWith("/original.mp4"))!;
  const thumb = f.paths.find((p) => p.endsWith("/thumb.jpg"));
  expect(thumb).toBeTruthy();
  const file = path.join(OUT, "editor-final-video.mp4");
  writeFileSync(file, Buffer.from(await storedB64(page, mp4), "base64"));
  const info = ffprobe(file);
  const v = info.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  const a = info.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
  expect([v.codec_name, v.pix_fmt, v.width, v.height]).toEqual(["h264", "yuv420p", 1080, 1350]);
  expect(a?.codec_name).toBe("aac");
  expect(Math.abs(Number(info.format.duration) - 4)).toBeLessThan(0.15);
});

test("vídeo da Biblioteca no card: sem reenviar do aparelho (cópia no armazenamento) e renderiza normalmente", async ({ page }) => {
  await page.goto("/editor.html");
  await page.waitForSelector("body[data-ready='1']", { state: "attached" });
  const lib = [{ id: "33333333-3333-4333-8333-333333333333", name: "V41", storage_path: `${WS}/lib/vertical-noaudio.mp4`, duration_ms: 4000, size_bytes: 1000 }];
  await page.evaluate(
    ([c, a, ws, l]) => (window as unknown as { mountEditor: (p: unknown) => void }).mountEditor({ slug: "leeoh", workspaceId: ws, canEdit: true, card: c, sourceUrls: { avatar: null, media: [], logo: null }, accounts: a, renderedUrl: null, libraryVideos: l }),
    [baseCard({ page_name: "Pipocou", username: "pipocoumemes", headline: "EU NA REUNIÃO DE SEGUNDA:", media_kind: "video", format: "vertical", template_version: 2 }), accounts, WS, lib] as const,
  );
  await expect(page.getByText(/Carregando arquivos salvos/)).toHaveCount(0, { timeout: 15_000 });
  await page.getByLabel("Ou escolha um vídeo que já está na Biblioteca").selectOption(lib[0]!.id);
  await expect(page.getByRole("button", { name: "Reproduzir" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Salvar rascunho" }).click();
  await expect(page.getByText("Rascunho salvo.")).toBeVisible({ timeout: 15_000 });
  let f = await fake(page);
  const copy = f.calls.find((c) => c.op === "storage:copy");
  expect(copy?.args.from).toBe(lib[0]!.storage_path);
  expect(String(copy?.args.to)).toMatch(new RegExp(`^${WS}/cards/[0-9a-f-]{36}/video-[0-9a-f-]{12}\\.mp4$`));
  // o vídeo NÃO foi reenviado do aparelho
  expect(f.calls.filter((c) => c.op === "storage:upload" && String(c.args.path).includes("/cards/") && String(c.args.path).includes("/video-"))).toHaveLength(0);
  expect((f.card.media_paths as string[])[0]).toBe(copy?.args.to);
  await page.getByRole("button", { name: "Renderizar arquivo final" }).click();
  await expect(page.getByText("Pronto para agendar")).toBeVisible({ timeout: 120_000 });
  f = await fake(page);
  const mp4 = f.paths.find((p) => p.endsWith("/original.mp4"))!;
  const file = path.join(OUT, "editor-biblioteca-video.mp4");
  writeFileSync(file, Buffer.from(await storedB64(page, mp4), "base64"));
  const v = ffprobe(file).streams.find((s: { codec_type: string }) => s.codec_type === "video");
  expect([v.codec_name, v.width, v.height]).toEqual(["h264", 1080, 1920]);
});

test("celular: prévia acima dos controles, sem rolagem horizontal", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, baseCard({ page_name: "Pipocou", username: "pipocoumemes", headline: "🚨 VEJA | Manchete no celular" }));
  await page.getByLabel("Arquivo da foto").setInputFiles(path.join(FX, "photo1.jpg"));
  await page.waitForTimeout(250);
  const canvasBox = await page.locator("canvas").boundingBox();
  const formBox = await page.getByRole("form", { name: "Configuração do card" }).boundingBox();
  expect(canvasBox!.y).toBeLessThan(formBox!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(OUT, "editor-mobile.png"), fullPage: true });
});


test("carregamento lento das origens salvas: campos bloqueados até terminar e nada escolhido é perdido", async ({ page }) => {
  // card já salvo com avatar; as origens chegam devagar (2,5 s), como na produção com rede real
  const card = baseCard({ page_name: "Pipocou", username: "pipocoumemes", headline: "Manchete", avatar_path: `${WS}/cards/${CARD}/avatar-1.png` });
  await mount(page, card, { avatar: "/slow/fixtures/avatar.png", media: [], logo: null }, false);
  const photo = page.getByLabel("Arquivo da foto");
  await expect(photo).toBeDisabled(); // não dá para escolher antes do carregamento terminar
  await expect(page.getByText(/Carregando arquivos salvos/)).toBeVisible();
  await expect(photo).toBeEnabled({ timeout: 15_000 });
  await photo.setInputFiles(path.join(FX, "photo1.jpg"));
  await expect(page.getByRole("button", { name: "Baixar PNG" })).toBeEnabled();
  await page.getByRole("button", { name: "Salvar rascunho" }).click();
  await expect(page.getByText("Rascunho salvo.")).toBeVisible();
  const saved = (await fake(page)).calls.filter((c) => c.op === "update:editorial_cards").at(-1)!.args;
  expect(saved.avatar_path).toBe(`${WS}/cards/${CARD}/avatar-1.png`); // avatar salvo preservado
  expect((saved.media_paths as string[]).length).toBe(1); // foto escolhida preservada
});
