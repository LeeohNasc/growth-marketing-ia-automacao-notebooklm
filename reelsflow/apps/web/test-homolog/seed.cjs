// Dados sintéticos LOCAIS para a suíte: 1 usuário dono de 2 workspaces (100 e 500 vídeos com
// miniatura) e uma campanha com 270 publicações agendadas em uma conta simulada.
// Uso: SUPABASE_SERVICE_ROLE_KEY=<chave LOCAL> node test-homolog/seed.cjs
// Volume alto (ex.: ~10 mil publicações para medir o custo do RLS) não é gerado aqui.
const fs = require("node:fs");
const { SB, assertLocal, sql, SEED_FILE, STATE_DIR } = require("./config.cjs");

assertLocal();
const K = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!K) throw new Error("Defina SUPABASE_SERVICE_ROLE_KEY (do Supabase LOCAL).");
const PASS = require("node:crypto").randomBytes(12).toString("hex");
// JPEG 1×1 válido (miniatura sintética)
const THUMB = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=", "base64");
const q = (s) => sql(s.replace(/\s+/g, " "));

async function user(email) {
  const r = await fetch(`${SB}/auth/v1/admin/users`, { method: "POST", headers: { apikey: K, authorization: `Bearer ${K}`, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASS, email_confirm: true }) });
  const j = await r.json(); if (!j.id) throw new Error("criar usuário: " + JSON.stringify(j).slice(0, 200)); return j.id;
}
async function workspace(uid, name, n) {
  const slug = `perf-${n}-${Date.now().toString(36)}`;
  const ws = q(`insert into workspaces (name, slug, created_by) values ('${name}', '${slug}', '${uid}') returning id`);
  q(`insert into workspace_members (workspace_id, user_id, role) values ('${ws}', '${uid}', 'owner') on conflict do nothing`);
  q(`insert into subscriptions (workspace_id, plan) values ('${ws}', 'agency') on conflict (workspace_id) do update set plan = 'agency'`);
  q(`insert into media_assets (workspace_id, uploaded_by, name, original_filename, storage_path, mime_type, size_bytes, sha256, status)
     select '${ws}', '${uid}', 'Video sintetico ' || lpad(g::text, 3, '0'), 'v' || g || '.mp4', '${ws}/' || gen_random_uuid() || '/original.mp4', 'video/mp4', 5000000 + g, md5(g::text || '${ws}') || md5(g::text), 'uploading'
       from generate_series(1, ${n}) g`);
  for (const s of ["uploaded", "processing"]) q(`update media_assets set status = '${s}' where workspace_id = '${ws}'`);
  q(`update media_assets set status = 'ready', duration_ms = 15000, width = 1080, height = 1920, fps = 30, video_codec = 'h264', audio_codec = 'aac', has_audio = true,
     thumbnail_path = workspace_id || '/' || id || '/thumb.jpg', probed_at = now(),
     compatibility = '{"platforms":{"instagram_reels":{"status":"ok","issues":[],"verified":true}}}' where workspace_id = '${ws}'`);
  const paths = q(`select thumbnail_path from media_assets where workspace_id = '${ws}'`).split("\n");
  for (let i = 0; i < paths.length; i += 25) await Promise.all(paths.slice(i, i + 25).map((p) => fetch(`${SB}/storage/v1/object/media/${p}`, { method: "POST", headers: { apikey: K, authorization: `Bearer ${K}`, "content-type": "image/jpeg", "x-upsert": "true" }, body: THUMB })));
  return { ws, slug };
}
(async () => {
  const email = `perf.${Date.now()}@example.test`; const uid = await user(email);
  const a = await workspace(uid, "Perf 100 videos", 100);
  const b = await workspace(uid, "Perf 500 videos", 500);
  const acc = q(`insert into social_accounts (workspace_id, platform, external_account_id, display_name, status, settings, provider) values ('${b.ws}', 'mock', 'sim_perf_${Date.now()}', 'Perf Simulada', 'active', '{"mock_behavior":"success"}', 'native') returning id`);
  const camp = q(`insert into campaigns (workspace_id, name, status, timezone, weekdays, times, start_date, caption, created_by) values ('${b.ws}', 'Perf 3x/dia 90 dias', 'active', 'America/Sao_Paulo', '{1,2,3,4,5,6,7}', '{09:00,13:00,19:00}', current_date + 1, 'Legenda', '${uid}') returning id`);
  const tgt = q(`insert into campaign_targets (campaign_id, workspace_id, social_account_id) values ('${camp}', '${b.ws}', '${acc}') returning id`);
  q(`insert into campaign_media (campaign_id, workspace_id, media_asset_id, position) select '${camp}', '${b.ws}', id, row_number() over (order by name) from media_assets where workspace_id = '${b.ws}' order by name limit 270`);
  q(`insert into publication_jobs (workspace_id, campaign_id, campaign_media_id, target_id, social_account_id, media_asset_id, local_date, local_time, timezone, scheduled_at, status, next_attempt_at)
     select '${b.ws}', '${camp}', cm.id, '${tgt}', '${acc}', cm.media_asset_id, d::date, t::time, 'America/Sao_Paulo', (d::date + t::time) at time zone 'America/Sao_Paulo', 'draft', (d::date + t::time) at time zone 'America/Sao_Paulo'
       from (select id, media_asset_id, row_number() over (order by position) rn from campaign_media where campaign_id = '${camp}') cm
       join lateral (select (current_date + 1 + ((cm.rn - 1) / 3)::int) as d, (array['09:00','13:00','19:00'])[((cm.rn - 1) % 3) + 1] as t) s on true`);
  q(`update publication_jobs set status = 'scheduled' where campaign_id = '${camp}'`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SEED_FILE, JSON.stringify({ email, pass: PASS, a, b, camp }), { mode: 0o600 });
  console.log(JSON.stringify({ a: a.slug, b: b.slug, jobs: q(`select count(*) from publication_jobs where campaign_id = '${camp}'`) }));
})().catch((e) => { console.error("FALHOU", e.message.slice(0, 500)); process.exit(1); });
