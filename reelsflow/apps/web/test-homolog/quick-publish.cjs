// Publicação Rápida contra o Supabase LOCAL real (RLS, RPCs de planejamento e ativação de verdade).
// Mede (cronometrado, com contagem de interações e telas) a Publicação Rápida × o assistente de campanha,
// e verifica: 1 publicação agendada no horário pedido, pedido repetido não duplica, rascunho
// interrompido é RETOMADO (não duplicado), horário em cima da hora é recusado, prévia do texto final sem
// hashtag repetida, Card Editorial a partir do vídeo escolhido, papel de leitura e outro workspace.
// Nada é publicado: contas simuladas, e o worker não roda localmente. Uso: node test-homolog/quick-publish.cjs
const path = require("node:path");
const fs = require("node:fs");
const { chromium, devices } = require("@playwright/test");
const { SITE, SB, readKey, assertLocal, seed, sql, STATE_DIR } = require("./config.cjs");
assertLocal();
const KEY = readKey();
const S = seed(), A = S.a, B = S.b;
const PW = require("node:crypto").randomBytes(10).toString("hex");
let fails = 0; const ok = (c, m) => { console.log(`${c ? "OK  " : "FALHA"} ${m}`); if (!c) fails++; };
const created = [];
async function user(role, ws) {
  const email = `quick.${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.test`;
  const r = await fetch(`${SB}/auth/v1/signup`, { method: "POST", headers: { apikey: KEY, "content-type": "application/json" }, body: JSON.stringify({ email, password: PW }) });
  if (!r.ok) throw new Error("signup " + r.status); created.push(email);
  sql(`insert into workspace_members (workspace_id, user_id, role) select '${ws}', id, '${role}' from auth.users where email='${email}'`);
  return email;
}
const TZ = "America/Sao_Paulo";
const ymd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const hm = (d) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
const inDays = (n) => ymd(new Date(Date.now() + n * 86400e3));
const instant = (date, time) => sql(`select to_char((('${date} ${time}')::timestamp at time zone '${TZ}') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);
const jobsFor = (mediaName, accountId) => sql(`select count(*) || '|' || coalesce(string_agg(j.status::text || '@' || to_char(j.scheduled_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), ','), '') from publication_jobs j join media_assets m on m.id=j.media_asset_id where m.name='${mediaName}' and j.social_account_id='${accountId}' and j.status <> 'cancelled'`).split("|");

async function login(b, email, opts = { viewport: { width: 1366, height: 900 } }) {
  const ctx = await b.newContext(opts); const p = await ctx.newPage(); const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  await p.goto(SITE + "/login"); await p.getByLabel("E-mail").fill(email); await p.getByLabel("Senha").fill(PW); await p.getByRole("button", { name: "Entrar" }).click(); await p.waitForURL(/\/w\//);
  return { ctx, p, errs };
}
/** Contador de interações (cliques, digitação, seleção) e de telas (navegações de documento/rota). */
function meter(p) {
  const m = { actions: 0, screens: new Set(), t0: 0 };
  p.on("framenavigated", (f) => { if (f === p.mainFrame()) m.screens.add(new URL(f.url()).pathname.replace(/[0-9a-f-]{36}/g, ":id")); });
  return { m, act: async (fn) => { m.actions++; await fn(); } };
}

(async () => {
  const acc = sql(`select id from social_accounts where workspace_id='${B.ws}' and status='active' limit 1`);
  // vídeos ainda sem campanha (cada execução usa vídeos novos; o seed ocupa os 270 primeiros)
  const free = sql(`select string_agg(n, ',') from (select substring(name from 'sintetico (\\d+)') n from media_assets m where workspace_id='${B.ws}' and not exists (select 1 from campaign_media cm where cm.media_asset_id=m.id) order by name limit 4) x`).split(",");
  if (free.length < 4) throw new Error("sem vídeos livres no seed B");
  const [V1, V2, V3, V4] = free;
  const editor = await user("editor", B.ws), viewer = await user("viewer", B.ws), editorA = await user("editor", A.ws);
  const b = await chromium.launch();
  const results = {};

  // ---------- 1. Publicação rápida (cronometrada) ----------
  {
    const { ctx, p, errs } = await login(b, editor); const { m, act } = meter(p);
    await p.goto(`${SITE}/w/${B.slug}/overview`); await p.locator("main h1", { hasText: "Início" }).waitFor();
    m.screens.clear(); m.t0 = Date.now();
    const date = inDays(3), time = "10:17";
    await act(() => p.getByRole("link", { name: "Criar publicação" }).click()); await p.locator("main h1", { hasText: "Publicação rápida" }).waitFor();
    await act(() => p.getByLabel("Buscar vídeo na Biblioteca").fill(`sintetico ${V1}`));
    await act(() => p.getByRole("radio", { name: new RegExp(`Video sintetico ${V1}`) }).check());
    await act(() => p.getByLabel("Legenda", { exact: true }).fill("Teste rápido #memes #Humor"));
    await act(() => p.getByLabel("Data").fill(date));
    await act(() => p.getByLabel("Horário").fill(time));
    const preview = await p.getByTestId("final-text").innerText();
    await act(() => p.getByRole("button", { name: "Agendar" }).click());
    await p.getByRole("heading", { name: "Agendado" }).waitFor({ timeout: 30000 });
    const ms = Date.now() - m.t0;
    results.quick = { ms, actions: m.actions, screens: m.screens.size };
    const [n, st] = jobsFor(`Video sintetico ${V1}`, acc);
    ok(n === "1" && st === `scheduled@${instant(date, time)}`, `rápida: 1 publicação AGENDADA no horário pedido (${st})`);
    ok(preview === "Teste rápido #memes #Humor", `rápida: prévia do texto final = ${JSON.stringify(preview)}`);
    ok(sql(`select count(*) from campaigns c join campaign_media cm on cm.campaign_id=c.id join media_assets m on m.id=cm.media_asset_id where m.name='Video sintetico ${V1}' and c.status='active' and c.name like 'Publicação rápida%'`) === "1", "rápida: reaproveita campanha (1 campanha ativa de 1 item)");
    ok(sql(`select cm.caption_override from campaign_media cm join media_assets m on m.id=cm.media_asset_id where m.name='Video sintetico ${V1}'`) === "Teste rápido #memes #Humor", "rápida: legenda gravada na camada do vídeo da campanha");

    // pedido repetido (mesmo vídeo, conta e horário): nada duplica
    await p.goto(`${SITE}/w/${B.slug}/create/quick`); await p.getByLabel("Buscar vídeo na Biblioteca").fill(`sintetico ${V1}`); await p.getByRole("radio", { name: new RegExp(`Video sintetico ${V1}`) }).check();
    await p.getByLabel("Data").fill(date); await p.getByLabel("Horário").fill(time); await p.getByRole("button", { name: "Agendar" }).click();
    await p.getByText(/já estava agendada/).waitFor({ timeout: 30000 });
    ok(jobsFor(`Video sintetico ${V1}`, acc)[0] === "1", "pedido repetido: avisa que já estava agendada e continua 1 publicação");

    // hashtags repetidas entre o texto e o campo extra: a prévia não repete
    await p.goto(`${SITE}/w/${B.slug}/create/quick`); await p.getByLabel("Buscar vídeo na Biblioteca").fill(`sintetico ${V2}`); await p.getByRole("radio", { name: new RegExp(`Video sintetico ${V2}`) }).check();
    await p.getByLabel("Legenda", { exact: true }).fill("Segunda #memes #humor"); await p.getByText("Hashtags extras (opcional)").click(); await p.getByLabel("Hashtags extras").fill("#Memes #gatos");
    ok((await p.getByTestId("final-text").innerText()) === "Segunda #memes #humor\n\n#gatos", "prévia: hashtag já escrita no texto não é repetida no fim");

    // em cima da hora: recusado, nada criado
    const soon = new Date(Date.now() + 5 * 60e3);
    await p.getByLabel("Data").fill(ymd(soon)); await p.getByLabel("Horário").fill(hm(soon)); await p.getByRole("button", { name: "Agendar" }).click();
    await p.getByRole("alert").filter({ hasText: "pelo menos 10 minutos" }).waitFor({ timeout: 30000 });
    ok(jobsFor(`Video sintetico ${V2}`, acc)[0] === "0" && sql(`select count(*) from campaign_media cm join media_assets m on m.id=cm.media_asset_id where m.name='Video sintetico ${V2}'`) === "0", "horário a 5 min: recusado, nenhuma campanha ou publicação criada");
    ok(errs.length === 0, `rápida: sem erros de página (${errs.length})`);
    await ctx.close();
  }

  // ---------- 2. falha entre criar e ativar: rascunho é RETOMADO ----------
  {
    const date = inDays(4), time = "11:23";
    const uid = sql(`select id from auth.users where email='${editor}'`);
    const camp = sql(`insert into campaigns (workspace_id, created_by, name, mode, timezone, weekdays, times, start_date, end_date, order_strategy, max_lateness_minutes, caption, hashtags)
      values ('${B.ws}', '${uid}', 'Publicação rápida · Video sintetico ${V3} · simulação de falha', 'mirrored', '${TZ}', array[extract(isodow from date '${date}')::int], array['${time}'], '${date}', '${date}', 'upload', 120, null, '{}') returning id`);
    sql(`insert into campaign_targets (campaign_id, workspace_id, social_account_id) values ('${camp}', '${B.ws}', '${acc}')`);
    sql(`insert into campaign_media (campaign_id, workspace_id, media_asset_id, position) select '${camp}', '${B.ws}', id, 0 from media_assets where workspace_id='${B.ws}' and name='Video sintetico ${V3}'`);
    const { ctx, p } = await login(b, editor);
    await p.goto(`${SITE}/w/${B.slug}/create/quick`); await p.getByLabel("Buscar vídeo na Biblioteca").fill(`sintetico ${V3}`); await p.getByRole("radio", { name: new RegExp(`Video sintetico ${V3}`) }).check();
    await p.getByLabel("Data").fill(date); await p.getByLabel("Horário").fill(time); await p.getByRole("button", { name: "Agendar" }).click();
    await p.getByRole("heading", { name: "Agendado" }).waitFor({ timeout: 30000 });
    const nC = sql(`select count(*) from campaigns c join campaign_media cm on cm.campaign_id=c.id join media_assets m on m.id=cm.media_asset_id where m.name='Video sintetico ${V3}' and c.status <> 'archived'`);
    ok(nC === "1" && sql(`select status from campaigns where id='${camp}'`) === "active" && jobsFor(`Video sintetico ${V3}`, acc)[0] === "1", "rascunho interrompido: retomado e ativado (1 campanha, 1 publicação, sem duplicata)");
    await ctx.close();
  }

  // ---------- 3. assistente de campanha (fluxo anterior para 1 vídeo), cronometrado ----------
  {
    const { ctx, p } = await login(b, editor); const { m, act } = meter(p);
    await p.goto(`${SITE}/w/${B.slug}/overview`); await p.locator("main h1", { hasText: "Início" }).waitFor();
    m.screens.clear(); m.t0 = Date.now();
    const date = inDays(5), time = "12:41";
    await act(() => p.locator("aside").getByRole("link", { name: "Criar", exact: true }).click());
    await act(() => p.locator("main nav").getByRole("link", { name: "Campanha", exact: true }).click()); await p.locator("main h1", { hasText: "Nova campanha" }).waitFor();
    await act(() => p.getByPlaceholder("Buscar vídeos prontos").fill(`sintetico ${V4}`));
    await act(() => p.locator("label", { hasText: `Video sintetico ${V4}` }).locator('input[type="checkbox"]').check());
    await act(() => p.getByLabel("Nome da campanha").fill("Campanha de 1 vídeo"));
    await act(() => p.locator('input[name="accounts"]').first().check());
    for (const t of ["09:00", "13:00", "19:00"]) await act(() => p.getByRole("button", { name: `Remover ${t}` }).click());
    await act(() => p.locator("#new-time").fill(time));
    await act(() => p.getByRole("button", { name: /Adicionar/ }).click());
    await act(() => p.getByLabel("Data inicial").fill(date));
    await act(() => p.getByLabel(/Legenda da campanha/).fill("Teste pelo assistente #memes"));
    await act(() => p.getByRole("button", { name: "Gerar calendário" }).click());
    await p.waitForURL(/\/campaigns\/[0-9a-f-]{36}/, { timeout: 30000 });
    await act(() => p.getByRole("button", { name: "Ativar automação" }).click());
    await p.getByText(/Campanha ativada/).waitFor({ timeout: 30000 });
    results.wizard = { ms: Date.now() - m.t0, actions: m.actions, screens: m.screens.size };
    ok(jobsFor(`Video sintetico ${V4}`, acc)[0] === "1", "assistente: 1 publicação agendada (comparação)");
    await ctx.close();
  }

  // ---------- 4. Card Editorial a partir da Publicação rápida (vídeo real do workspace A) ----------
  {
    const real = sql(`select id from media_assets where workspace_id='${A.ws}' and name='Video real da Biblioteca' and status='ready' and deleted_at is null limit 1`);
    if (!real) console.log("PULADO  Card Editorial a partir da rápida (rode antes test-homolog/library-card.cjs para ter um vídeo real em A)");
    else {
      // a tela exige uma conta conectada; o workspace A do seed não tem: cria uma conta SIMULADA local
      if (sql(`select count(*) from social_accounts where workspace_id='${A.ws}' and status <> 'disconnected'`) === "0") {
        sql(`insert into social_accounts (workspace_id, platform, external_account_id, display_name, status, settings, provider) values ('${A.ws}', 'mock', 'sim_quick_${Date.now()}', 'Simulada A', 'active', '{"mock_behavior":"success"}', 'native')`);
      }
      const { ctx, p } = await login(b, editorA);
      await p.goto(`${SITE}/w/${A.slug}/create/quick?media=${real}`); await p.locator("main h1", { hasText: "Publicação rápida" }).waitFor();
      ok(await p.getByRole("radio", { name: /Video real da Biblioteca/ }).isChecked(), "rápida com ?media=: vídeo já escolhido");
      await p.getByRole("button", { name: /Aplicar Card Editorial/ }).click(); await p.waitForURL(/\/create\/editorial\/[0-9a-f-]{36}\?media=/);
      await p.getByRole("button", { name: "Reproduzir" }).waitFor({ timeout: 30000 });
      const card = p.url().split("/").pop().split("?")[0];
      ok(sql(`select format || '/' || media_kind || '/' || template_version from editorial_cards where id='${card}'`) === "vertical/video/2", "Card Editorial aberto já em 9:16, vídeo, V2, com o vídeo carregado da Biblioteca");
      await ctx.close();
    }
  }

  // ---------- 5. permissões e isolamento ----------
  {
    const { ctx, p } = await login(b, viewer);
    await p.goto(`${SITE}/w/${B.slug}/create/quick`);
    ok((await p.getByText(/somente leitura/).count()) > 0 && (await p.getByRole("button", { name: "Agendar" }).count()) === 0, "leitura (viewer): sem formulário de agendamento");
    await ctx.close();
  }
  {
    const { ctx, p } = await login(b, editor);
    const r = await p.goto(`${SITE}/w/${A.slug}/create/quick`);
    ok(r.status() === 404, `outro workspace: /w/A/create/quick → ${r.status()}`);
    await p.goto(`${SITE}/w/${B.slug}/create/quick`); await p.getByLabel("Buscar vídeo na Biblioteca").fill("Video real da Biblioteca");
    ok((await p.getByRole("radio", { name: /Video real da Biblioteca/ }).count()) === 0, "outro workspace: vídeos de A não aparecem na lista de B");
    await ctx.close();
  }
  // ---------- 6. celular ----------
  {
    const { ctx, p } = await login(b, editor, { ...devices["Pixel 7"] });
    await p.goto(`${SITE}/w/${B.slug}/create/quick`); await p.locator("main h1", { hasText: "Publicação rápida" }).waitFor();
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "celular: sem rolagem horizontal");
    fs.mkdirSync(STATE_DIR, { recursive: true }); await p.screenshot({ path: path.join(STATE_DIR, "quick-celular.png"), fullPage: true });
    await ctx.close();
  }
  await b.close();
  sql(`delete from auth.users where email in (${created.map((e) => `'${e}'`).join(",")})`);
  console.log(`\nMEDIDA rápida:     ${(results.quick.ms / 1000).toFixed(1)} s · ${results.quick.actions} interações · ${results.quick.screens} tela(s)`);
  console.log(`MEDIDA assistente: ${(results.wizard.ms / 1000).toFixed(1)} s · ${results.wizard.actions} interações · ${results.wizard.screens} tela(s)`);
  fs.writeFileSync(path.join(STATE_DIR, "quick-results.json"), JSON.stringify(results));
  console.log(fails ? `\n${fails} FALHA(S)` : "\npublicação rápida: tudo certo"); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("ERRO", e.message); sql(`delete from auth.users where email in (${created.map((e) => `'${e}'`).join(",") || "''"})`); process.exit(1); });
