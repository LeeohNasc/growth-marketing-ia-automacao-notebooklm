import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, createUser, createWorkspaceAs, pool, uniqueEmail } from "./helpers";

/**
 * Teste DIFERENCIAL da otimização do RLS (migration 16): as políticas novas precisam se comportar
 * EXATAMENTE como as antigas (guardadas em app.rls_policy_backup_16 e no arquivo de rollback).
 *
 * Camada 1 — predicados: para cada uma das políticas, cada ator e cada combinação de valores das colunas
 *   usadas pela política (workspaces A/B/C/nulo, todos os usuários, todos os papéis/status, caminhos de
 *   Storage válidos e inválidos), a expressão antiga e a nova dão o MESMO resultado.
 * Camada 2 — operações reais: leitura, criação, edição e exclusão em todas as tabelas com política, por
 *   7 atores (dono/admin/editor/leitor de A, dono de B, usuário sem workspace, anônimo). Executa com as
 *   políticas novas, aplica o ROLLBACK real (arquivo) na mesma transação, executa de novo e compara tudo.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const DOWN_SQL = readFileSync(path.join(here, "../../rollback/20261123000016_down.sql"), "utf8");

afterAll(async () => {
  await pool.end();
});

type Actor = { name: string; id: string | null };
let actors: Actor[] = [];
let WA = "", WB = "", WC = "";
const fx: Record<string, unknown> = {};

const asActor = async (c: pg.PoolClient, a: Actor) => {
  await c.query("select set_config('request.jwt.claim.sub', $1, true)", [a.id ?? ""]);
  await c.query(a.id ? "set local role authenticated" : "set local role anon");
};

beforeAll(async () => {
  const mk = async (p: string) => createUser({ email: uniqueEmail(p) });
  const [ownerA, adminA, editorA, viewerA, ownerB, outsider, ownerC] = await Promise.all(
    ["rd-oa", "rd-aa", "rd-ea", "rd-va", "rd-ob", "rd-out", "rd-oc"].map(mk),
  );
  WA = (await createWorkspaceAs(ownerA, "Diferencial A")).id;
  WB = (await createWorkspaceAs(ownerB, "Diferencial B")).id;
  WC = (await createWorkspaceAs(ownerC, "Diferencial C")).id;
  for (const w of [WA, WB, WC]) await pool.query("update public.subscriptions set plan = 'agency' where workspace_id = $1", [w]);
  await addMember(WA, adminA, "admin");
  await addMember(WA, editorA, "editor");
  await addMember(WA, viewerA, "viewer");
  actors = [
    { name: "dono A", id: ownerA }, { name: "admin A", id: adminA }, { name: "editor A", id: editorA }, { name: "leitor A", id: viewerA },
    { name: "dono B", id: ownerB }, { name: "sem workspace", id: outsider }, { name: "anônimo", id: null },
  ];
  fx.users = { ownerA, adminA, editorA, viewerA, ownerB, outsider, ownerC };

  // Registros de teste em A e B para TODAS as tabelas com política (superusuário; gatilhos/FKs suspensos só no seed).
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    for (const [w, owner, tag] of [[WA, ownerA, "a"], [WB, ownerB, "b"]] as const) {
      const id = () => randomUUID();
      const media = id(), mediaUp = id(), coll = id(), camp = id(), acc = id(), target = id(), cm = id(), job = id(), card = id(), tpl = id();
      fx[`media_${tag}`] = media; fx[`mediaUp_${tag}`] = mediaUp; fx[`card_${tag}`] = card;
      const q = (sql: string, p: unknown[]) => c.query(sql, p);
      await q(`insert into public.media_assets (id, workspace_id, name, original_filename, storage_path, mime_type, size_bytes, sha256, status, uploaded_by)
               values ($1::uuid,$3::uuid,'v','v.mp4',$3::uuid::text||'/'||$1::uuid::text||'/original.mp4','video/mp4',10,repeat('a',64),'ready',$4::uuid),
                      ($2::uuid,$3::uuid,'u','u.mp4',$3::uuid::text||'/'||$2::uuid::text||'/original.mp4','video/mp4',10,repeat('b',64),'uploading',$4::uuid)`, [media, mediaUp, w, owner]);
      await q("insert into public.collections (id, workspace_id, name, created_by) values ($1,$2,'Coleção',$3)", [coll, w, owner]);
      await q("insert into public.collection_items (collection_id, media_asset_id, workspace_id) values ($1,$2,$3)", [coll, media, w]);
      await q("insert into public.social_accounts (id, workspace_id, platform, external_account_id, display_name, status, provider) values ($1,$2,'mock',$3,'Conta','active','native')", [acc, w, `ext-${tag}-${acc}`]);
      await q("insert into public.social_account_capabilities (social_account_id, workspace_id, capability, granted) values ($1,$2,'reels_publish',true)", [acc, w]);
      await q("insert into public.campaigns (id, workspace_id, name, timezone, weekdays, times, start_date, created_by, status) values ($1,$2,'Camp','America/Sao_Paulo','{1}','{09:00}',current_date,$3,'draft')", [camp, w, owner]);
      await q("insert into public.campaign_targets (id, campaign_id, workspace_id, social_account_id) values ($1,$2,$3,$4)", [target, camp, w, acc]);
      await q("insert into public.campaign_media (id, campaign_id, workspace_id, media_asset_id) values ($1,$2,$3,$4)", [cm, camp, w, media]);
      await q(`insert into public.publication_jobs (id, workspace_id, campaign_id, campaign_media_id, target_id, social_account_id, media_asset_id, local_date, local_time, timezone, scheduled_at, status, next_attempt_at)
               values ($1,$2,$3,$4,$5,$6,$7,current_date,'09:00','America/Sao_Paulo',now(),'published',now())`, [job, w, camp, cm, target, acc, media]);
      await q("insert into public.publication_attempts (job_id, workspace_id, attempt_no, worker_id) values ($1,$2,1,'w')", [job, w]);
      await q("insert into public.external_publications (job_id, workspace_id, social_account_id, platform, external_id) values ($1,$2,$3,'mock','x')", [job, w, acc]);
      await q("insert into public.publication_templates (id, workspace_id, name, timezone, weekdays, times, created_by) values ($1,$2,'Modelo','America/Sao_Paulo','{1}','{09:00}',$3)", [tpl, w, owner]);
      await q("insert into public.editorial_cards (id, workspace_id, created_by, title) values ($1,$2,$3,'Card')", [card, w, owner]);
      await q("insert into public.notifications (workspace_id, user_id, type) values ($1,$2,'publication.failed')", [w, owner]);
      await q("insert into public.notification_preferences (user_id, workspace_id) values ($1,$2)", [owner, w]);
      await q("insert into public.automation_rules (workspace_id, rule_key, enabled) values ($1,'retry_transient',true) on conflict do nothing", [w]);
      await q("insert into public.automation_runs (workspace_id, rule_key, subject_type, outcome) values ($1,'retry_transient','job','ok')", [w]);
      await q("insert into public.audit_logs (workspace_id, action, entity) values ($1,'teste','x')", [w]);
      await q("insert into public.usage_records (workspace_id, metric, period_start) values ($1,'publications',date_trunc('month', now())::date) on conflict do nothing", [w]);
      await q("insert into public.workspace_invitations (workspace_id, email, role, token_hash, invited_by) values ($1,$2,'viewer',$3,$4)", [w, `conv-${tag}@t.local`, `hash-${tag}-${randomUUID()}`, owner]);
      for (const name of [`${w}/${media}/thumb.jpg`, `${w}/cards/${card}/foto.jpg`, `${w}/${mediaUp}/original.mp4`]) {
        await q("insert into storage.objects (bucket_id, name, owner) values ('media', $1, $2)", [name, owner]);
      }
    }
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
});

// ---------------------------------------------------------------------------- camada 1: predicados
describe("RLS diferencial — predicados das políticas", () => {
  it("cada política nova dá o MESMO resultado que a antiga, para todo ator e toda combinação de valores", async () => {
    const policies = (await pool.query("select * from app.rls_policy_backup_16 order by schemaname, tablename, policyname")).rows as {
      schemaname: string; tablename: string; policyname: string; cmd: string; qual: string | null; with_check: string | null;
    }[];
    expect(policies.length).toBe(52);
    const u = fx.users as Record<string, string>;
    const uuidPool = [WA, WB, WC, ...Object.values(u), fx.media_a, fx.card_a, fx.mediaUp_a, null] as (string | null)[];
    const storageNames = [WA, WB, WC].flatMap((w) => [
      `${w}/${fx.media_a}/thumb.jpg`, `${w}/${fx.media_b}/thumb.jpg`, `${w}/cards/${fx.card_a}/foto.jpg`, `${w}/cards/${fx.card_b}/foto.jpg`,
      `${w}/${fx.mediaUp_a}/original.mp4`, `${w}/${fx.mediaUp_b}/original.mp4`, `${w}/qualquer.txt`,
    ]).concat(["nao-e-uuid/x/thumb.jpg", "", null as unknown as string]);

    let evals = 0, differences = 0;
    const perPolicy: string[] = [];
    const c = await pool.connect();
    try {
      for (const p of policies) {
        const now = (await c.query("select qual, with_check from pg_policies where schemaname = $1 and tablename = $2 and policyname = $3", [p.schemaname, p.tablename, p.policyname])).rows[0];
        expect(now, `${p.tablename}.${p.policyname} existe`).toBeTruthy();
        const cols = (await c.query(
          `select column_name, data_type, udt_name, (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = c.udt_name) as labels
             from information_schema.columns c where table_schema = $1 and table_name = $2`, [p.schemaname, p.tablename],
        )).rows as { column_name: string; data_type: string; udt_name: string; labels: string[] | null }[];
        const text = `${p.qual ?? ""} ${p.with_check ?? ""}`;
        const used = cols.filter((col) => new RegExp(`(^|[^a-z_.])(objects\\.)?${col.column_name}([^a-z_]|$)`).test(text));
        await c.query("begin");
        await c.query(`create temp table s on commit drop as select * from ${p.schemaname}.${p.tablename} limit 0`);
        const values = used.map((col) => {
          if (col.udt_name === "uuid") return { col, arr: uuidPool, type: "uuid" };
          if (col.labels) return { col, arr: [...col.labels, null], type: col.udt_name };
          if (col.column_name === "name" && p.schemaname === "storage") return { col, arr: storageNames, type: "text" };
          if (col.column_name === "bucket_id") return { col, arr: ["media", "outro", null], type: "text" };
          if (col.data_type.startsWith("timestamp")) return { col, arr: [null, new Date().toISOString()], type: "timestamptz" };
          if (col.data_type === "boolean") return { col, arr: [true, false, null], type: "boolean" };
          return { col, arr: [null], type: "text" };
        });
        if (values.length) {
          const sel = values.map((v, i) => `v${i}.x`).join(", ");
          const from = values.map((v, i) => `unnest($${i + 1}::${v.type}[]) v${i}(x)`).join(" cross join ");
          await c.query(`insert into s (${values.map((v) => `"${v.col.column_name}"`).join(", ")}) select ${sel} from ${from}`, values.map((v) => v.arr));
        }
        const rows = Number((await c.query("select count(*) from s")).rows[0].count);
        for (const [clause, oldE, newE] of [["using", p.qual, now.qual], ["check", p.with_check, now.with_check]] as const) {
          if (oldE === null && newE === null) continue;
          expect(oldE === null, `${p.policyname}: mesma estrutura`).toBe(newE === null);
          for (const a of actors) {
            await c.query("savepoint e");
            await c.query("select set_config('request.jwt.claim.sub', $1, true)", [a.id ?? ""]);
            const r = (await c.query(
              `select count(*) filter (where (${oldE}) is distinct from (${newE})) as diff, count(*) filter (where coalesce((${oldE}), false)) as allowed from s as ${p.tablename}`,
            )).rows[0];
            await c.query("rollback to savepoint e");
            evals += rows;
            differences += Number(r.diff);
            if (Number(r.diff)) perPolicy.push(`${p.tablename}.${p.policyname} ${clause} ${a.name}: ${r.diff} diferenças`);
          }
        }
        await c.query("rollback");
      }
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
    console.log(`[diferencial de predicados] ${policies.length} políticas · ${actors.length} atores · ${evals} avaliações · ${differences} diferenças`);
    expect(perPolicy).toEqual([]);
    expect(differences).toBe(0);
    expect(evals).toBeGreaterThan(10_000);
  });
});

// ---------------------------------------------------------------------------- camada 2: operações reais
const TABLES: { t: string; touch: string }[] = [
  { t: "public.workspaces", touch: "name" }, { t: "public.workspace_members", touch: "role" }, { t: "public.workspace_invitations", touch: "email" },
  { t: "public.media_assets", touch: "name" }, { t: "public.collections", touch: "name" }, { t: "public.collection_items", touch: "workspace_id" },
  { t: "public.social_accounts", touch: "display_name" }, { t: "public.social_account_capabilities", touch: "granted" },
  { t: "public.campaigns", touch: "name" }, { t: "public.campaign_targets", touch: "workspace_id" }, { t: "public.campaign_media", touch: "workspace_id" },
  { t: "public.publication_jobs", touch: "workspace_id" }, { t: "public.publication_attempts", touch: "workspace_id" },
  { t: "public.external_publications", touch: "workspace_id" }, { t: "public.publication_templates", touch: "name" },
  { t: "public.editorial_cards", touch: "title" }, { t: "public.notifications", touch: "type" }, { t: "public.notification_preferences", touch: "email_enabled" },
  { t: "public.automation_rules", touch: "enabled" }, { t: "public.automation_runs", touch: "outcome" }, { t: "public.audit_logs", touch: "action" },
  { t: "public.subscriptions", touch: "workspace_id" }, { t: "public.usage_records", touch: "metric" }, { t: "storage.objects", touch: "name" },
];

async function battery(c: pg.PoolClient): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const { t, touch } of TABLES) {
    const [schema, table] = t.split(".");
    const cols = (await c.query(
      "select column_name from information_schema.columns where table_schema = $1 and table_name = $2 and is_generated = 'NEVER' and (identity_generation is distinct from 'ALWAYS')",
      [schema, table],
    )).rows.map((r) => r.column_name as string);
    const hasId = cols.includes("id");
    // Modelos para INSERT: um registro de A e um de B, com id novo e campos únicos variados.
    const tpl = (await c.query(`select to_jsonb(x) as j from ${t} x where ${table === "workspaces" ? "id" : schema === "storage" ? "split_part(name, '/', 1)::uuid" : "workspace_id"} in ($1, $2) order by 1`, [WA, WB])).rows.map((r) => r.j as Record<string, unknown>);
    for (const a of actors) {
      const run = async (op: string, sql: string, params: unknown[] = []) => {
        await c.query("savepoint op");
        try {
          await asActor(c, a);
          const r = await c.query(sql, params);
          out[`${t} | ${op} | ${a.name}`] = `ok:${JSON.stringify(r.rows[0] ?? r.rowCount)}`;
        } catch (e) {
          out[`${t} | ${op} | ${a.name}`] = `erro:${(e as { code?: string }).code}`;
        }
        await c.query("rollback to savepoint op");
      };
      const key = hasId ? "id" : cols.includes("job_id") ? "job_id" : "workspace_id";
      await run("ler", `select count(*)::int as n, md5(coalesce(string_agg(${schema === "storage" ? "name" : `${key}::text`}, ',' order by ${schema === "storage" ? "name" : `${key}::text`}), '')) as h from ${t}`);
      await run("editar", `with u as (update ${t} set "${touch}" = "${touch}" returning 1) select count(*)::int as n from u`);
      await run("excluir", `with d as (delete from ${t} returning 1) select count(*)::int as n from d`);
      for (const [i, row] of tpl.entries()) {
        const j: Record<string, unknown> = { ...row };
        if (hasId) j.id = randomUUID();
        if ("slug" in j) j.slug = `copia-${randomUUID().slice(0, 8)}`;
        if ("token_hash" in j) j.token_hash = `h-${randomUUID()}`;
        if ("email" in j) j.email = `copia-${randomUUID().slice(0, 8)}@t.local`;
        if (schema === "storage") j.name = String(j.name).replace(/(thumb\.jpg|foto\.jpg|original\.mp4)$/, (m) => m) + "";
        if ("external_account_id" in j) j.external_account_id = `ext-${randomUUID()}`;
        const list = cols.filter((col) => col in j).map((col) => `"${col}"`).join(", ");
        await run(`criar(${i === 0 ? "A" : "B"})`, `with i as (insert into ${t} (${list}) select ${list} from jsonb_populate_record(null::${t}, $1::jsonb) returning 1) select count(*)::int as n from i`, [JSON.stringify(j)]);
      }
    }
  }
  return out;
}

describe("RLS diferencial — operações reais (políticas novas × rollback real)", () => {
  it("leitura, criação, edição e exclusão: resultados idênticos para os 7 atores em todas as tabelas; rollback aplica sem erro", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      const novo = await battery(c);
      await c.query("reset role");
      // Rollback REAL (arquivo versionado), na mesma transação — valida o próprio rollback.
      await c.query(DOWN_SQL);
      const restored = Number((await c.query("select count(*) from pg_policies where qual ilike '%has_role(%' or with_check ilike '%has_role(%'")).rows[0].count);
      expect(restored).toBe(52);
      const antigo = await battery(c);
      await c.query("rollback");
      const keys = Object.keys(antigo);
      const diffs = keys.filter((k) => antigo[k] !== novo[k]).map((k) => `${k}: antigo=${antigo[k]} novo=${novo[k]}`);
      const allowed = keys.filter((k) => antigo[k]!.startsWith("ok:") && !/"n":0|^ok:0$/.test(antigo[k]!)).length;
      console.log(`[diferencial de operações] ${keys.length} operações · ${allowed} com efeito/visibilidade · ${diffs.length} diferenças`);
      expect(diffs).toEqual([]);
      expect(keys.length).toBe(TABLES.length * actors.length * 5);
      expect(allowed).toBeGreaterThan(100); // a bateria exercita acessos permitidos, não só negados
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
    // a transação foi desfeita: as políticas novas continuam no lugar
    expect(Number((await pool.query("select count(*) from pg_policies where qual ilike '%member_workspace_ids%' or with_check ilike '%member_workspace_ids%'")).rows[0].count)).toBe(52);
  });

  it("isolamento explícito: ninguém de fora lê, altera ou apaga dados de A; anônimo não vê nada", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      for (const a of actors.filter((x) => ["dono B", "sem workspace", "anônimo"].includes(x.name))) {
        for (const { t } of TABLES.filter((x) => x.t !== "storage.objects" && x.t !== "public.workspaces")) {
          await c.query("savepoint z");
          await asActor(c, a);
          const r = await c.query(`select count(*)::int as n from ${t} where workspace_id = $1`, [WA]).catch((e) => ({ rows: [{ n: `erro ${e.code}` }] }));
          await c.query("rollback to savepoint z");
          expect([0, "erro 42501"], `${a.name} em ${t}`).toContain(r.rows[0].n);
        }
        await c.query("savepoint z");
        await asActor(c, a);
        const o = await c.query("select count(*)::int as n from storage.objects where name like $1", [`${WA}/%`]).catch((e) => ({ rows: [{ n: `erro ${e.code}` }] }));
        await c.query("rollback to savepoint z");
        expect([0, "erro 42501"]).toContain(o.rows[0].n);
      }
      await c.query("rollback");
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  });
});
