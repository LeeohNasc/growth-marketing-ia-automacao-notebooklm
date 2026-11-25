// Vídeo da Biblioteca no Card Editorial contra o Supabase LOCAL real (Storage + RLS de verdade).
// Fluxo: editor envia um vídeo pela Biblioteca (envio integrado) → vídeo fica pronto → novo Card
// Editorial → "escolher da Biblioteca" → salvar rascunho. Verifica: o card aponta para uma CÓPIA em
// {workspace}/cards/{card}/, o original não muda, nenhum arquivo é reenviado do navegador, nenhuma
// mídia nova é criada; e isolamento: outro workspace e papel de leitura não conseguem copiar/ler.
// Nada é publicado ou agendado. Uso: node test-homolog/library-card.cjs
const path = require("node:path");
const { chromium } = require("@playwright/test");
const { createClient } = require("@supabase/supabase-js");
const { SITE, SB, readKey, assertLocal, seed, sql } = require("./config.cjs");
const KEY = readKey();
assertLocal();
const S = seed(), A = S.a, B = S.b;
const FX = path.join(__dirname, "..", "e2e-render", "site", "fixtures", "vertical-noaudio.mp4");
const PW = require("node:crypto").randomBytes(10).toString("hex");
let fails = 0; const ok = (c, m) => { console.log(`${c ? "OK  " : "FALHA"} ${m}`); if (!c) fails++; };
const created = [];
async function user(role, ws) {
  const email = `libcard.${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.test`;
  const r = await fetch(`${SB}/auth/v1/signup`, { method: "POST", headers: { apikey: KEY, "content-type": "application/json" }, body: JSON.stringify({ email, password: PW }) });
  if (!r.ok) throw new Error("signup " + r.status); created.push(email);
  sql(`insert into workspace_members (workspace_id, user_id, role) select '${ws}', id, '${role}' from auth.users where email='${email}'`);
  return email;
}
async function api(email) { const c = createClient(SB, KEY, { auth: { persistSession: false } }); const { error } = await c.auth.signInWithPassword({ email, password: PW }); if (error) throw error; return c; }
const obj = (name) => sql(`select coalesce((select (metadata->>'size') || ':' || (metadata->>'eTag') from storage.objects where bucket_id='media' and name='${name}'), '')`);

(async () => {
  const editor = await user("editor", A.ws), viewer = await user("viewer", A.ws), outsider = await user("editor", B.ws);
  const mediaBefore = Number(sql(`select count(*) from media_assets where workspace_id='${A.ws}'`));
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1366, height: 900 } }); const p = await ctx.newPage();
  const storageCalls = []; p.on("request", (r) => { if (r.url().includes("/storage/v1/object") && r.method() !== "GET") storageCalls.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await p.goto(SITE + "/login"); await p.getByLabel("E-mail").fill(editor); await p.getByLabel("Senha").fill(PW); await p.getByRole("button", { name: "Entrar" }).click(); await p.waitForURL(/\/w\//);

  // 1. envio pela Biblioteca (envio integrado)
  await p.goto(`${SITE}/w/${A.slug}/library?enviar=1`); await p.locator("main h1", { hasText: "Biblioteca" }).waitFor();
  const existed = sql(`select count(*) from media_assets where workspace_id='${A.ws}' and original_filename='vertical-noaudio.mp4' and deleted_at is null`) !== "0";
  await p.locator('main details[open] input[type="file"]').setInputFiles(FX);
  if (existed) {
    // o mesmo arquivo já está na Biblioteca: o envio integrado precisa avisar antes de enviar de novo
    await p.getByText("Possível duplicado").first().waitFor({ timeout: 60000 });
    ok(true, "envio do MESMO arquivo outra vez: aviso de duplicado antes de enviar (nenhum upload repetido)");
  } else {
    await p.getByText(/1 de 1 enviados/).waitFor({ timeout: 60000 });
  }
  const media = sql(`select id || '|' || storage_path from media_assets where workspace_id='${A.ws}' and original_filename='vertical-noaudio.mp4' and deleted_at is null order by created_at desc limit 1`).split("|");
  ok(media.length === 2, `vídeo na Biblioteca (${media[0]})`);
  // o worker de análise não roda localmente: simula só o resultado da análise (como o seed)
  for (const s of ["processing"]) sql(`update media_assets set status='${s}' where id='${media[0]}' and status='uploaded'`);
  sql(`update media_assets set status='ready', duration_ms=4000, width=1080, height=1920, fps=30, video_codec='h264', has_audio=false, probed_at=now(), name='Video real da Biblioteca' where id='${media[0]}'`);
  const original = obj(media[1]); ok(original !== "", `original no Storage: ${media[1]} (${original.split(":")[0]} bytes)`);
  const mediaAfterUpload = Number(sql(`select count(*) from media_assets where workspace_id='${A.ws}'`));

  // 2. novo Card Editorial → vídeo → escolher da Biblioteca → salvar
  await p.goto(`${SITE}/w/${A.slug}/create`); await p.getByRole("button", { name: "Novo Card Editorial" }).click();
  await p.waitForURL(/\/create\/editorial\/[0-9a-f-]{36}$/); const cardId = p.url().split("/").pop();
  await p.getByText(/Carregando arquivos salvos/).waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  await p.getByRole("radio", { name: "Vídeo" }).check({ force: true });
  await p.getByLabel("Título interno").fill("Teste vídeo da Biblioteca");
  storageCalls.length = 0;
  await p.getByLabel("Ou escolha um vídeo que já está na Biblioteca").selectOption(media[0]);
  await p.getByRole("button", { name: "Reproduzir" }).waitFor({ timeout: 30000 });
  await p.getByRole("button", { name: "Salvar rascunho" }).click(); await p.getByText("Rascunho salvo.").waitFor({ timeout: 30000 });
  const cardPath = sql(`select media_paths[1] from editorial_cards where id='${cardId}'`);
  ok(new RegExp(`^${A.ws}/cards/${cardId}/video-[0-9a-f-]{12}\\.mp4$`).test(cardPath), `card aponta para uma cópia própria: ${cardPath}`);
  ok(obj(cardPath) === original, "cópia idêntica ao original (mesmo tamanho e eTag)");
  ok(obj(media[1]) === original, "arquivo original da Biblioteca não mudou");
  ok(storageCalls.some((c) => c.includes("/object/copy")) && !storageCalls.some((c) => /\/object\/media\/.*\/cards\/.*video-/.test(c)), `nenhum reenvio do vídeo pelo navegador (chamadas: ${JSON.stringify(storageCalls)})`);
  ok(Number(sql(`select count(*) from media_assets where workspace_id='${A.ws}'`)) === mediaAfterUpload && mediaAfterUpload === mediaBefore + (existed ? 0 : 1), "nenhuma mídia nova além do envio feito pela Biblioteca");
  ok(sql(`select count(*) from publication_jobs where media_asset_id='${media[0]}'`) === "0", "nada foi agendado com o vídeo");
  await ctx.close(); await b.close();

  // 3. isolamento e papéis (Storage + RLS reais)
  const cardB = sql(`insert into editorial_cards (workspace_id, created_by, title) select '${B.ws}', id, 'card B' from auth.users where email='${outsider}' returning id`);
  const o = await api(outsider);
  { const r = await o.storage.from("media").copy(media[1], `${B.ws}/cards/${cardB}/video-xxxxxxxxxxxx.mp4`); ok(Boolean(r.error), `outro workspace: cópia do vídeo de A recusada (${r.error?.message ?? "permitida!"})`); }
  { const r = await o.storage.from("media").createSignedUrl(media[1], 60); ok(Boolean(r.error) || !r.data?.signedUrl, "outro workspace: não consegue link do vídeo de A"); }
  { const r = await o.from("media_assets").select("id").eq("id", media[0]); ok((r.data ?? []).length === 0, "outro workspace: não enxerga a mídia de A"); }
  const v = await api(viewer);
  { const r = await v.storage.from("media").copy(media[1], `${A.ws}/cards/${cardId}/video-yyyyyyyyyyyy.mp4`); ok(Boolean(r.error), `leitura (viewer): cópia para o card recusada (${r.error?.message ?? "permitida!"})`); }

  // limpeza dos usuários sintéticos
  sql(`delete from editorial_cards where id='${cardB}'`);
  sql(`delete from auth.users where email in (${created.map((e) => `'${e}'`).join(",")})`);
  console.log(fails ? `\n${fails} FALHA(S)` : "\nvídeo da Biblioteca no card: tudo certo"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("ERRO", e.message); sql(`delete from auth.users where email in (${created.map((e) => `'${e}'`).join(",") || "''"})`); process.exit(1); });
