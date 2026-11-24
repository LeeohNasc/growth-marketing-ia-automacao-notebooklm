// Segurança de autenticação e isolamento — Supabase LOCAL, usuários sintéticos.
// Uso: node test-homolog/security.cjs
//   HOMOLOG_SESSION_FIX=1   espera a correção de sessões revogadas (conjunto B): revogada → /login.
//                           Sem ela (conjunto A sozinho), o ciclo /login ↔ /w é o comportamento já
//                           existente em produção: é registrado como CONHECIDO, desde que nenhum dado apareça.
//   HOMOLOG_AUTH_DELAY_MS   mesmo valor de AUTH_DELAY_MS do latency-proxy (app compilado apontando para o
//                           proxy): ativa os testes "nada sai antes do getUser".
//   HOMOLOG_SHORT_JWT=1     o Auth local está com JWT curto (≤ 30 s): ativa os testes de expiração.
const { chromium } = require("@playwright/test");
const { SITE, SB, readKey, assertLocal, sql, seed, testPassword } = require("./config.cjs");
assertLocal();
const KEY = readKey(), PW = testPassword(), S = seed();
const A = S.a, B = S.b, FIX = process.env.HOMOLOG_SESSION_FIX === "1";
const AUTH_DELAY = Number(process.env.HOMOLOG_AUTH_DELAY_MS ?? 0), SHORT_JWT = process.env.HOMOLOG_SHORT_JWT === "1";
const DATA_RE = new RegExp(`Perf (100|500) videos|${A.ws}|${B.ws}|Video sintetico`);
let fails = 0, known = 0;
const ok = (c, m) => { console.log(`${c ? "OK     " : "FALHA  "} ${m}`); if (!c) fails++; };
const knownIssue = (m) => { console.log(`CONHEC. ${m}`); known++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const created = [];

async function freshUser(role, ws = A.ws) {
  const email = `homolog.${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.test`;
  const r = await fetch(`${SB}/auth/v1/signup`, { method: "POST", headers: { apikey: KEY, "content-type": "application/json" }, body: JSON.stringify({ email, password: PW }) });
  if (!r.ok) throw new Error("signup " + r.status); created.push(email);
  if (role) sql(`insert into workspace_members (workspace_id, user_id, role) select '${ws}', id, '${role}' from auth.users where email='${email}'`);
  return email;
}
async function login(b, email, pass = PW, opts = {}) {
  const ctx = await b.newContext(opts); const p = await ctx.newPage();
  await p.goto(SITE + "/login"); await p.getByLabel("E-mail").fill(email); await p.getByLabel("Senha").fill(pass); await p.getByRole("button", { name: "Entrar" }).click();
  await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }); return { ctx, p };
}
async function session(ctx) {
  const c = (await ctx.cookies()).filter((x) => x.name.startsWith("sb-") && x.name.includes("auth-token")).sort((a, b) => a.name.localeCompare(b.name));
  return c.length ? JSON.parse(Buffer.from(c.map((x) => x.value).join("").replace(/^base64-/, ""), "base64").toString()) : null;
}
/** Segue a cadeia de redirecionamentos passo a passo; devolve destino final e se algum corpo continha dados. */
async function chain(ctx, path) {
  let url = SITE + path; const hops = []; let leaked = false;
  for (let i = 0; i < 8; i++) {
    const t0 = Date.now(); const r = await ctx.request.get(url, { maxRedirects: 0, timeout: 120000 }); const loc = r.headers()["location"];
    const body = await r.text(); if (DATA_RE.test(body) && !new URL(url).pathname.startsWith("/login")) leaked = true;
    hops.push({ path: new URL(url).pathname, status: r.status(), ms: Date.now() - t0 });
    if (!loc) return { final: new URL(url).pathname, status: r.status(), hops, leaked, body };
    url = new URL(loc, SITE).href;
  }
  return { final: "LOOP", status: 0, hops, leaked };
}
async function api(access) {
  const h = { apikey: KEY, authorization: `Bearer ${access}` };
  const ws = await fetch(`${SB}/rest/v1/workspaces?select=name`, { headers: h });
  return { status: ws.status, rows: ws.ok ? (await ws.json()).length : 0 };
}
async function revokeAll(email) {
  const t = await (await fetch(`${SB}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: KEY, "content-type": "application/json" }, body: JSON.stringify({ email, password: PW }) })).json();
  return (await fetch(`${SB}/auth/v1/logout?scope=global`, { method: "POST", headers: { apikey: KEY, authorization: `Bearer ${t.access_token}` } })).status;
}
function sessionEnded(name, c) {
  ok(!c.leaked, `${name}: nenhum dado de workspace em nenhuma resposta da cadeia`);
  if (FIX) ok(c.final === "/login" && c.status === 200, `${name}: termina no login (${c.hops.map((h) => `${h.path}→${h.status}`).join(" ")})`);
  else if (c.final === "LOOP") knownIssue(`${name}: ciclo /login ↔ /w (já existe em produção; corrigido pelo conjunto B)`);
  else ok(c.final === "/login", `${name}: termina em ${c.final}`);
}

(async () => {
  const b = await chromium.launch();
  try {
    // 1. sem sessão / cookie inválido
    { const ctx = await b.newContext();
      for (const p of ["overview", "library", "calendar", "campaigns", "settings", "queue", "create"]) { const c = await chain(ctx, `/w/${A.slug}/${p}`); ok(c.hops[0].status === 307 && c.final === "/login" && !c.leaked, `sem login: /w/…/${p} → login`); }
      await ctx.addCookies([{ name: "sb-127-auth-token", value: "base64-" + Buffer.from('{"access_token":"x.y.z","refresh_token":"r"}').toString("base64"), url: SITE }]);
      const c = await chain(ctx, `/w/${A.slug}/overview`); ok(c.final === "/login" && !c.leaked, "cookie de sessão inválido → login, sem dados"); await ctx.close(); }

    // 2. papéis no próprio workspace e acesso a outro workspace
    for (const role of ["owner", "admin", "editor", "viewer"]) {
      const { ctx, p } = await login(b, await freshUser(role));
      const own = await chain(ctx, `/w/${A.slug}/overview`), other = await chain(ctx, `/w/${B.slug}/overview`), otherLib = await chain(ctx, `/w/${B.slug}/library`);
      ok(own.status === 200 && other.status === 404 && otherLib.status === 404 && !DATA_RE.test(other.body ?? "") , `${role}: próprio workspace 200; outro workspace 404 sem dados`);
      await p.goto(`${SITE}/w/${A.slug}/settings`); const admin = await p.getByLabel("Convidar por e-mail").count();
      ok(admin === (["owner", "admin"].includes(role) ? 1 : 0), `${role}: ações de administrador ${admin ? "visíveis" : "ocultas"} em Configurações`);
      await ctx.close();
    }
    // 3. sem vínculo
    { const { ctx } = await login(b, await freshUser(null));
      for (const path of [`/w/${A.slug}/library`, `/w/${B.slug}/overview`, `/w/${A.slug}/settings`]) { const c = await chain(ctx, path); ok(c.status === 404 && !DATA_RE.test(c.body ?? ""), `sem vínculo: ${path.replace(/\/w\/[^/]+/, "/w/…")} → 404 sem dados`); }
      const s = await session(ctx); const r = await api(s.access_token); ok(r.status === 200 && r.rows === 0, "sem vínculo: API não devolve workspaces"); await ctx.close(); }
    // 4. vínculo removido e papel rebaixado durante a sessão
    { const e = await freshUser("editor"); const { ctx } = await login(b, e); sql(`delete from workspace_members where user_id = (select id from auth.users where email='${e}')`);
      const c = await chain(ctx, `/w/${A.slug}/library`); ok(c.status === 404 && !DATA_RE.test(c.body ?? ""), "removido do workspace: próxima página 404 sem dados"); await ctx.close(); }
    { const e = await freshUser("admin"); const { ctx, p } = await login(b, e); await p.goto(`${SITE}/w/${A.slug}/settings`); const before = await p.getByLabel("Convidar por e-mail").count();
      sql(`update workspace_members set role='viewer' where user_id = (select id from auth.users where email='${e}')`); await p.reload(); const after = await p.getByLabel("Convidar por e-mail").count();
      ok(before === 1 && after === 0, "rebaixado admin → viewer: ações de administrador somem na hora"); await ctx.close(); }
    // 5. JWT adulterado
    { const { ctx } = await login(b, await freshUser("viewer")); const s = await session(ctx);
      const owner = sql(`select user_id from workspace_members where workspace_id='${B.ws}' and role='owner' limit 1`);
      const [h, pl, sig] = s.access_token.split("."); const cl = JSON.parse(Buffer.from(pl, "base64url")); cl.sub = owner; const forged = `${h}.${Buffer.from(JSON.stringify(cl)).toString("base64url")}.${sig}`;
      const name = (await ctx.cookies()).find((x) => x.name.includes("auth-token")).name.replace(/\.\d+$/, "");
      await ctx.clearCookies(); await ctx.addCookies([{ name, value: "base64-" + Buffer.from(JSON.stringify({ ...s, access_token: forged })).toString("base64"), url: SITE }]);
      const c = await chain(ctx, `/w/${B.slug}/overview`); const r = await api(forged);
      const s2 = await session(ctx); const sub2 = s2 ? JSON.parse(Buffer.from(s2.access_token.split(".")[1], "base64url")).sub : null;
      // Aceito: recusado (login) OU — se o token adulterado já expirou — trocado pela renovação legítima do PRÓPRIO
      // usuário (sub original), que não é membro de B e recebe 404. Nunca: dados de B nem identidade do dono de B.
      const renewedAsSelf = c.status === 404 && sub2 && sub2 !== owner;
      ok((c.final === "/login" || renewedAsSelf) && !c.leaked && !DATA_RE.test(c.body ?? "") && r.status === 401,
        `JWT adulterado (sub = dono de outro workspace): ${c.final} ${c.status}${renewedAsSelf ? " (renovado como o próprio usuário)" : ""}, sem dados; API ${r.status}`); await ctx.close(); }
    // 6. sessões encerradas no servidor (o JWT continua dentro da validade)
    { const e = await freshUser("editor"); const { ctx, p } = await login(b, e); await revokeAll(e);
      sessionEnded("logout global em outro dispositivo", await chain(ctx, `/w/${A.slug}/overview`));
      await p.goto(`${SITE}/w/${A.slug}/overview`).catch(() => {}); ok(!DATA_RE.test(await p.content().catch(() => "")), "logout global: navegador sem dados de workspace"); await ctx.close(); }
    { const e = await freshUser("admin"); const { ctx } = await login(b, e); sql(`update auth.users set banned_until = now() + interval '1 day' where email='${e}'`);
      sessionEnded("usuário bloqueado", await chain(ctx, `/w/${A.slug}/overview`)); await ctx.close(); }
    { const e = await freshUser("owner"); const { ctx } = await login(b, e); sql(`delete from workspace_members where user_id=(select id from auth.users where email='${e}'); delete from auth.users where email='${e}'`);
      sessionEnded("conta excluída", await chain(ctx, `/w/${A.slug}/overview`)); await ctx.close(); }
    { const e = await freshUser(null); const { ctx } = await login(b, e); await revokeAll(e);
      const real = await chain(ctx, `/w/${A.slug}/overview`), fake = await chain(ctx, `/w/nao-existe-${Date.now()}/overview`);
      ok(real.hops[0].status === fake.hops[0].status && !real.leaked, `revogado e sem vínculo: mesma resposta para workspace real e inexistente (${real.hops[0].status})`); await ctx.close(); }

    // 7. nada sai antes do getUser (Auth artificialmente lento)
    if (AUTH_DELAY) {
      { const e = await freshUser("editor"); const { ctx } = await login(b, e); await revokeAll(e);
        const c = await chain(ctx, `/w/${A.slug}/library`);
        ok(!c.leaked && c.hops[0].status === 307 && c.hops[0].ms >= AUTH_DELAY * 0.9, `getUser lento (+${AUTH_DELAY} ms) e sessão revogada: 1ª resposta é redirecionamento após ${c.hops[0].ms} ms, sem dados`); await ctx.close(); }
      { const { ctx, p } = await login(b, S.email, S.pass);
        await p.goto(`${SITE}/w/${A.slug}/campaigns`); await p.locator("main h1", { hasText: "Campanhas" }).waitFor({ timeout: 60000 });
        await p.evaluate(() => { window.__seen = []; new MutationObserver(() => window.__seen.push([performance.now(), document.querySelector("main")?.innerText ?? ""])).observe(document, { subtree: true, childList: true, characterData: true }); window.__t0 = performance.now(); });
        await p.locator("aside").getByRole("link", { name: "Biblioteca de Vídeos", exact: true }).click(); await p.locator("main h1", { hasText: "Biblioteca" }).waitFor({ timeout: 60000 });
        const r = await p.evaluate(() => { const first = window.__seen.find(([, t]) => /vídeos/.test(t) && /Video sintetico|\d+ vídeos/.test(t)); return { firstData: first ? first[0] - window.__t0 : null }; });
        ok(r.firstData !== null && r.firstData >= AUTH_DELAY * 0.9, `getUser lento (+${AUTH_DELAY} ms), sessão válida: dados da Biblioteca só aparecem após ${Math.round(r.firstData)} ms (depois do getUser)`); await ctx.close(); }
    } else console.log("PULADO  testes de getUser lento (defina HOMOLOG_AUTH_DELAY_MS e use o latency-proxy)");

    // 8. expiração (Auth local com JWT curto)
    if (SHORT_JWT) {
      { const { ctx } = await login(b, await freshUser("viewer")); const s0 = await session(ctx); await sleep(36000);
        const c = await chain(ctx, `/w/${A.slug}/overview`); const s1 = await session(ctx);
        ok(c.status === 200 && s1 && s1.access_token !== s0.access_token, "JWT expirado com renovação válida: página 200 e token renovado"); await ctx.close(); }
      { const e = await freshUser("editor"); const { ctx } = await login(b, e); await revokeAll(e); await sleep(36000);
        const c = await chain(ctx, `/w/${A.slug}/overview`); ok(c.final === "/login" && !c.leaked && !(await session(ctx)), "revogado e depois expirado: login, cookie limpo, sem dados"); await ctx.close(); }
    } else console.log("PULADO  testes de expiração (defina HOMOLOG_SHORT_JWT=1 com o Auth local em JWT curto)");
  } finally {
    await b.close();
    if (created.length) sql(`delete from workspace_members where user_id in (select id from auth.users where email in (${created.map((e) => `'${e}'`).join(",")})); delete from auth.users where email in (${created.map((e) => `'${e}'`).join(",")})`);
  }
  console.log(`\n${fails ? `${fails} FALHA(S)` : "segurança: nenhuma falha"} · ${known} comportamento(s) conhecido(s) · usuários sintéticos removidos: ${created.length}`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("ERRO", e.message); process.exit(1); });
