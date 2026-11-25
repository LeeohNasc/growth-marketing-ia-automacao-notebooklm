import { JOB_STATUSES, canTransition } from "@reelsflow/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DENIED, addMember, asUser, createUser, createWorkspaceAs, expectPgError, pool, uniqueEmail } from "./helpers";

afterAll(async () => {
  await pool.end();
});

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

type Ctx = { ws: string; campaign: string; target: string; account: string; cm: string[]; media: string[] };

async function seedMedia(ws: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into public.media_assets (workspace_id, name, original_filename, storage_path, mime_type, size_bytes, sha256, status)
       values ($1, $2, $2, $3, 'video/mp4', 10, $4, 'uploading') returning id`,
      [ws, `v${i}`, `${ws}/${crypto.randomUUID()}/original.mp4`, "b".repeat(64)],
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

/** Cria conta simulada, campanha com 1 alvo e N itens (como o owner). */
async function seedCampaign(owner: string, ws: string, n = 3): Promise<Ctx> {
  const account = await asUser(owner, async (db) => (await db.query<{ id: string }>("select (public.create_simulated_account($1, 'Sim', 'success')).id", [ws])).rows[0]!.id, { commit: true });
  const campaign = await asUser(
    owner,
    async (db) =>
      (
        await db.query<{ id: string }>(
          `insert into public.campaigns (workspace_id, name, timezone, weekdays, times, start_date, created_by)
           values ($1, 'Camp', 'America/Sao_Paulo', '{1,2,3,4,5,6,7}', '{09:00}', current_date, $2) returning id`,
          [ws, owner],
        )
      ).rows[0]!.id,
    { commit: true },
  );
  const target = await asUser(
    owner,
    async (db) =>
      (await db.query<{ id: string }>("insert into public.campaign_targets (campaign_id, workspace_id, social_account_id) values ($1,$2,$3) returning id", [campaign, ws, account])).rows[0]!.id,
    { commit: true },
  );
  const media = await seedMedia(ws, n);
  const cm: string[] = [];
  for (const [i, m] of media.entries()) {
    const id = await asUser(
      owner,
      async (db) =>
        (await db.query<{ id: string }>("insert into public.campaign_media (campaign_id, workspace_id, media_asset_id, position) values ($1,$2,$3,$4) returning id", [campaign, ws, m, i])).rows[0]!.id,
      { commit: true },
    );
    cm.push(id);
  }
  return { ws, campaign, target, account, cm, media };
}

const planJob = (c: Ctx, i: number, at: string) => ({
  campaign_media_id: c.cm[i],
  target_id: c.target,
  scheduled_at: at,
  local_date: at.slice(0, 10),
  local_time: "09:00",
  timezone: "America/Sao_Paulo",
});

async function savePlan(user: string, c: Ctx, jobs: object[], replace = true) {
  return asUser(
    user,
    async (db) => (await db.query("select * from public.save_campaign_plan($1, $2::jsonb, $3)", [c.campaign, JSON.stringify(jobs), replace])).rows[0],
    { commit: true },
  );
}

describe("máquina de estados: banco = domínio", () => {
  it("todas as 169 combinações de transição coincidem", async () => {
    const { rows } = await pool.query<{ f: string; t: string; ok: boolean }>(
      `select f::text, t::text, app.job_transition_allowed(f, t) as ok
         from unnest(enum_range(null::public.job_status)) f, unnest(enum_range(null::public.job_status)) t`,
    );
    expect(rows).toHaveLength(JOB_STATUSES.length ** 2);
    const diff = rows.filter((r) => r.ok !== canTransition(r.f as never, r.t as never)).map((r) => `${r.f}->${r.t}`);
    expect(diff).toEqual([]);
  });
});

describe("agendamento", () => {
  let owner: string;
  let editor: string;
  let viewer: string;
  let outsider: string;
  let ws: string;
  let otherWs: string;

  beforeAll(async () => {
    owner = await createUser({ email: uniqueEmail("s-owner") });
    editor = await createUser({ email: uniqueEmail("s-editor") });
    viewer = await createUser({ email: uniqueEmail("s-viewer") });
    outsider = await createUser({ email: uniqueEmail("s-out") });
    ws = (await createWorkspaceAs(owner, "Agenda")).id;
    otherWs = (await createWorkspaceAs(outsider, "Outra agenda")).id;
    await addMember(ws, editor, "editor");
    await addMember(ws, viewer, "viewer");
  });

  describe("contas", () => {
    it("somente admin cria conta simulada; comportamento validado", async () => {
      await expectPgError(asUser(editor, (db) => db.query("select public.create_simulated_account($1, 'X')", [ws])), DENIED);
      await expectPgError(asUser(outsider, (db) => db.query("select public.create_simulated_account($1, 'X')", [ws])), DENIED);
      await expectPgError(asUser(owner, (db) => db.query("select public.create_simulated_account($1, 'X', 'hack')", [ws])), ["22023"]);
      const r = await asUser(owner, (db) => db.query("select (public.create_simulated_account($1, 'Teste')).platform as p", [ws]));
      expect(r.rows[0]?.p).toBe("mock");
    });

    it("cliente não insere contas diretamente nem altera status/plataforma", async () => {
      await expectPgError(
        asUser(owner, (db) => db.query("insert into public.social_accounts (workspace_id, platform, external_account_id, display_name) values ($1,'instagram','x','x')", [ws])),
        DENIED,
      );
      const c = await seedCampaign(owner, ws, 1);
      await expectPgError(asUser(owner, (db) => db.query("update public.social_accounts set status = 'active', platform = 'instagram' where id = $1", [c.account])), DENIED);
      const ok = await asUser(owner, (db) => db.query("update public.social_accounts set paused = true where id = $1", [c.account]));
      expect(ok.rowCount).toBe(1);
      const no = await asUser(editor, (db) => db.query("update public.social_accounts set paused = true where id = $1", [c.account]));
      expect(no.rowCount).toBe(0);
    });
  });

  describe("plano da campanha", () => {
    it("editor grava plano; jobs ficam em rascunho na campanha rascunho", async () => {
      const c = await seedCampaign(owner, ws, 3);
      const r = await savePlan(editor, c, [planJob(c, 0, inHours(24)), planJob(c, 1, inHours(48))]);
      expect(r).toMatchObject({ inserted: 2, skipped_duplicates: 0 });
      const st = await pool.query("select distinct status from public.publication_jobs where campaign_id = $1", [c.campaign]);
      expect(st.rows).toEqual([{ status: "draft" }]);
    });

    it("recusa horário no passado, alvo/item de outra campanha e viewer", async () => {
      const c = await seedCampaign(owner, ws, 1);
      const other = await seedCampaign(owner, ws, 1);
      await expectPgError(savePlan(editor, c, [planJob(c, 0, inHours(-1))]), ["22023"]);
      await expectPgError(savePlan(editor, c, [{ ...planJob(c, 0, inHours(5)), target_id: other.target }]), DENIED);
      await expectPgError(savePlan(editor, c, [{ ...planJob(c, 0, inHours(5)), campaign_media_id: other.cm[0] }]), DENIED);
      await expectPgError(savePlan(viewer, c, [planJob(c, 0, inHours(5))]), DENIED);
      await expectPgError(savePlan(outsider, c, [planJob(c, 0, inHours(5))]), DENIED);
    });

    it("impede duplicidade do mesmo vídeo no mesmo alvo", async () => {
      const c = await seedCampaign(owner, ws, 1);
      await savePlan(editor, c, [planJob(c, 0, inHours(24))]);
      const r = await savePlan(editor, c, [planJob(c, 0, inHours(30))], false);
      expect(r).toMatchObject({ inserted: 0, skipped_duplicates: 1 });
    });

    it("replanejar substitui apenas publicações futuras editáveis", async () => {
      const c = await seedCampaign(owner, ws, 2);
      await savePlan(editor, c, [planJob(c, 0, inHours(24)), planJob(c, 1, inHours(48))]);
      await pool.query("update public.publication_jobs set status = 'scheduled' where campaign_id = $1", [c.campaign]);
      await pool.query("update public.campaigns set status = 'active' where id = $1", [c.campaign]);
      // simula um já publicado
      const first = (await pool.query("select id from public.publication_jobs where campaign_media_id = $1", [c.cm[0]])).rows[0].id;
      await pool.query("update public.publication_jobs set status = 'queued' where id = $1", [first]);
      await pool.query("update public.publication_jobs set status = 'preparing' where id = $1", [first]);
      await pool.query("update public.publication_jobs set status = 'published' where id = $1", [first]);
      const r = await savePlan(editor, c, [planJob(c, 1, inHours(72))]);
      expect(r).toMatchObject({ inserted: 1, removed: 1 });
      const rows = await pool.query("select status from public.publication_jobs where campaign_id = $1 order by scheduled_at", [c.campaign]);
      expect(rows.rows.map((x) => x.status)).toEqual(["published", "scheduled"]);
    });

    it("cliente não escreve em publication_jobs diretamente", async () => {
      const c = await seedCampaign(owner, ws, 1);
      await savePlan(editor, c, [planJob(c, 0, inHours(24))]);
      await expectPgError(asUser(owner, (db) => db.query("update public.publication_jobs set status = 'published' where campaign_id = $1", [c.campaign])), DENIED);
      await expectPgError(asUser(owner, (db) => db.query("delete from public.publication_jobs where campaign_id = $1", [c.campaign])), DENIED);
      await expectPgError(
        asUser(owner, (db) =>
          db.query(
            "insert into public.publication_jobs (workspace_id, social_account_id, local_date, local_time, timezone, scheduled_at, status) values ($1,$2,current_date,'09:00','UTC',now(),'queued')",
            [ws, c.account],
          ),
        ),
        DENIED,
      );
    });
  });

  describe("ciclo da campanha", () => {
    it("ativar promove rascunhos; pausar/retomar; arquivar cancela futuras", async () => {
      const c = await seedCampaign(owner, ws, 2);
      await savePlan(editor, c, [planJob(c, 0, inHours(24)), planJob(c, 1, inHours(48))]);
      const act = await asUser(editor, (db) => db.query("select public.set_campaign_status($1, 'activate') as s", [c.campaign]), { commit: true });
      expect(act.rows[0]?.s).toBe("active");
      expect((await pool.query("select distinct status from public.publication_jobs where campaign_id = $1", [c.campaign])).rows).toEqual([{ status: "scheduled" }]);

      expect((await asUser(editor, (db) => db.query("select public.set_campaign_status($1, 'pause') as s", [c.campaign]), { commit: true })).rows[0]?.s).toBe("paused");
      await expectPgError(asUser(editor, (db) => db.query("select public.set_campaign_status($1, 'pause')", [c.campaign])), ["P0001"]);
      expect((await asUser(editor, (db) => db.query("select public.set_campaign_status($1, 'resume') as s", [c.campaign]), { commit: true })).rows[0]?.s).toBe("active");

      await asUser(editor, (db) => db.query("select public.set_campaign_status($1, 'archive')", [c.campaign]), { commit: true });
      expect((await pool.query("select distinct status from public.publication_jobs where campaign_id = $1", [c.campaign])).rows).toEqual([{ status: "cancelled" }]);
    });

    it("não ativa campanha sem publicações; viewer não muda status; status não é editável diretamente", async () => {
      const c = await seedCampaign(owner, ws, 1);
      await expectPgError(asUser(editor, (db) => db.query("select public.set_campaign_status($1, 'activate')", [c.campaign])), ["P0001"]);
      await expectPgError(asUser(viewer, (db) => db.query("select public.set_campaign_status($1, 'activate')", [c.campaign])), DENIED);
      await expectPgError(asUser(owner, (db) => db.query("update public.campaigns set status = 'active' where id = $1", [c.campaign])), DENIED);
    });

    it("arquivar é recusado com publicação em andamento", async () => {
      const c = await seedCampaign(owner, ws, 1);
      await savePlan(editor, c, [planJob(c, 0, inHours(24))]);
      await asUser(editor, (db) => db.query("select public.set_campaign_status($1, 'activate')", [c.campaign]), { commit: true });
      await pool.query("update public.publication_jobs set status = 'queued' where campaign_id = $1", [c.campaign]);
      await pool.query("update public.publication_jobs set status = 'preparing' where campaign_id = $1", [c.campaign]);
      await expectPgError(asUser(editor, (db) => db.query("select public.set_campaign_status($1, 'archive')", [c.campaign])), ["P0001"]);
    });
  });

  describe("edição de publicações", () => {
    it("reagendar converte o horário para o fuso da publicação", async () => {
      const c = await seedCampaign(owner, ws, 1);
      await savePlan(editor, c, [planJob(c, 0, inHours(24))]);
      const id = (await pool.query("select id from public.publication_jobs where campaign_id = $1", [c.campaign])).rows[0].id;
      const at = "2030-06-10T15:30:00Z"; // 12:30 em São Paulo
      await asUser(editor, (db) => db.query("select public.reschedule_job($1, $2)", [id, at]), { commit: true });
      const r = (await pool.query("select local_date::text, local_time::text, scheduled_at from public.publication_jobs where id = $1", [id])).rows[0];
      expect(r.local_date).toBe("2030-06-10");
      expect(r.local_time).toBe("12:30:00");
      await expectPgError(asUser(editor, (db) => db.query("select public.reschedule_job($1, now() - interval '1 hour')", [id])), ["22023"]);
    });

    it("não reagenda nem cancela publicação em andamento ou publicada", async () => {
      const c = await seedCampaign(owner, ws, 1);
      await savePlan(editor, c, [planJob(c, 0, inHours(24))]);
      const id = (await pool.query("select id from public.publication_jobs where campaign_id = $1", [c.campaign])).rows[0].id;
      await pool.query("update public.publication_jobs set status = 'scheduled' where id = $1", [id]);
      await pool.query("update public.publication_jobs set status = 'queued' where id = $1", [id]);
      await pool.query("update public.publication_jobs set status = 'preparing' where id = $1", [id]);
      await expectPgError(asUser(editor, (db) => db.query("select public.reschedule_job($1, $2)", [id, inHours(50)])), ["P0001"]);
      const n = await asUser(editor, (db) => db.query("select public.cancel_jobs($1::uuid[]) as n", [[id]]));
      expect(n.rows[0]?.n).toBe(0);
    });

    it("falha permanente pode ser reagendada (zera tentativas)", async () => {
      const c = await seedCampaign(owner, ws, 1);
      await savePlan(editor, c, [planJob(c, 0, inHours(24))]);
      const id = (await pool.query("select id from public.publication_jobs where campaign_id = $1", [c.campaign])).rows[0].id;
      for (const s of ["scheduled", "queued", "preparing", "failed_permanent"]) await pool.query("update public.publication_jobs set status = $2 where id = $1", [id, s]);
      await pool.query("update public.campaigns set status = 'active' where id = $1", [c.campaign]);
      await pool.query("update public.publication_jobs set attempt_count = 6 where id = $1", [id]);
      await asUser(editor, (db) => db.query("select public.reschedule_job($1, $2)", [id, inHours(3)]), { commit: true });
      expect((await pool.query("select status, attempt_count from public.publication_jobs where id = $1", [id])).rows[0]).toEqual({ status: "scheduled", attempt_count: 0 });
    });

    describe("reagendamento com horário vencido (trava só para 'scheduled')", () => {
      const jobOf = async (c: Ctx) => (await pool.query("select id from public.publication_jobs where campaign_id = $1", [c.campaign])).rows[0].id as string;
      const backdate = (id: string, sql: string) => pool.query(`update public.publication_jobs set scheduled_at = ${sql}, next_attempt_at = ${sql} where id = $1`, [id]);
      const errorOf = async (q: Promise<unknown>) => { try { await q; return "aceito"; } catch (e) { return `${(e as { code?: string }).code}:${(e as Error).message}`; } };
      const count = async (c: Ctx) => Number((await pool.query("select count(*) from public.publication_jobs where campaign_id = $1", [c.campaign])).rows[0].count);

      it("rascunho vencido (campanha em rascunho) pode ser reagendado: mesma publicação, continua rascunho", async () => {
        const c = await seedCampaign(owner, ws, 1);
        await savePlan(editor, c, [planJob(c, 0, inHours(24))]);
        const id = await jobOf(c);
        await backdate(id, "now() - interval '10 minutes'");
        await asUser(editor, (db) => db.query("select public.reschedule_job($1, $2)", [id, inHours(1)]), { commit: true });
        const r = (await pool.query("select id, status, pinned, scheduled_at > now() as futuro from public.publication_jobs where campaign_id = $1", [c.campaign])).rows;
        expect(r).toEqual([{ id, status: "draft", pinned: true, futuro: true }]);
      });

      it("rascunho vencido não aceita novo horário passado nem a menos de 2 min", async () => {
        const c = await seedCampaign(owner, ws, 1);
        await savePlan(editor, c, [planJob(c, 0, inHours(24))]);
        const id = await jobOf(c);
        await backdate(id, "now() - interval '10 minutes'");
        await expectPgError(asUser(editor, (db) => db.query("select public.reschedule_job($1, now() - interval '1 minute')", [id])), ["22023"]);
        await expectPgError(asUser(editor, (db) => db.query("select public.reschedule_job($1, now() + interval '1 minute')", [id])), ["22023"]);
        expect(await count(c)).toBe(1);
      });

      it("revisão vencida (ativada depois do horário) pode ser reagendada e volta a 'scheduled'", async () => {
        const c = await seedCampaign(owner, ws, 1);
        await savePlan(editor, c, [planJob(c, 0, inHours(24))]);
        const id = await jobOf(c);
        await backdate(id, "now() - interval '10 minutes'");
        await asUser(editor, (db) => db.query("select public.set_campaign_status($1, 'activate')", [c.campaign]), { commit: true });
        expect((await pool.query("select status, review_reason from public.publication_jobs where id = $1", [id])).rows[0]).toEqual({ status: "needs_review", review_reason: "scheduled_time_passed_before_activation" });
        await asUser(editor, (db) => db.query("select public.reschedule_job($1, $2)", [id, inHours(1)]), { commit: true });
        expect((await pool.query("select status, review_reason from public.publication_jobs where id = $1", [id])).rows[0]).toEqual({ status: "scheduled", review_reason: null });
        expect(await count(c)).toBe(1);
      });

      it("agendada dentro da janela de 2 min ou vencida continua bloqueada (o worker pode pegá-la)", async () => {
        const c = await seedCampaign(owner, ws, 1);
        await savePlan(editor, c, [planJob(c, 0, inHours(24))]);
        const id = await jobOf(c);
        await asUser(editor, (db) => db.query("select public.set_campaign_status($1, 'activate')", [c.campaign]), { commit: true });
        await backdate(id, "now() + interval '1 minute'");
        expect(await errorOf(asUser(editor, (db) => db.query("select public.reschedule_job($1, $2)", [id, inHours(3)])))).toMatch(/^P0001:.*too close/);
        await backdate(id, "now() - interval '5 minutes'");
        expect(await errorOf(asUser(editor, (db) => db.query("select public.reschedule_job($1, $2)", [id, inHours(3)])))).toMatch(/^P0001:.*too close/);
        expect((await pool.query("select status from public.publication_jobs where id = $1", [id])).rows[0].status).toBe("scheduled");
      });

      it("publicada continua sem reagendamento", async () => {
        const c = await seedCampaign(owner, ws, 1);
        await savePlan(editor, c, [planJob(c, 0, inHours(24))]);
        const id = await jobOf(c);
        for (const s of ["scheduled", "queued", "preparing", "uploading", "publishing", "published"]) await pool.query("update public.publication_jobs set status = $2 where id = $1", [id, s]);
        await expectPgError(asUser(editor, (db) => db.query("select public.reschedule_job($1, $2)", [id, inHours(3)])), ["P0001"]);
      });

      it("a antecedência mínima do banco é a mesma da interface (2 min)", async () => {
        expect((await pool.query("select extract(epoch from app.edit_freeze())::int as s")).rows[0].s).toBe(120);
      });
    });

    it("não membro não cancela, reagenda nem vê publicações", async () => {
      const c = await seedCampaign(owner, ws, 1);
      await savePlan(editor, c, [planJob(c, 0, inHours(24))]);
      const id = (await pool.query("select id from public.publication_jobs where campaign_id = $1", [c.campaign])).rows[0].id;
      await expectPgError(asUser(outsider, (db) => db.query("select public.cancel_jobs($1::uuid[])", [[id]])), DENIED);
      await expectPgError(asUser(outsider, (db) => db.query("select public.reschedule_job($1, $2)", [id, inHours(30)])), DENIED);
      expect((await asUser(outsider, (db) => db.query("select 1 from public.publication_jobs where id = $1", [id]))).rowCount).toBe(0);
    });

    it("confirmar publicação manual só a partir de revisão", async () => {
      const c = await seedCampaign(owner, ws, 1);
      await savePlan(editor, c, [planJob(c, 0, inHours(24))]);
      const id = (await pool.query("select id from public.publication_jobs where campaign_id = $1", [c.campaign])).rows[0].id;
      await expectPgError(asUser(editor, (db) => db.query("select public.confirm_job_published($1)", [id])), ["P0001"]);
      for (const s of ["scheduled", "needs_review"]) await pool.query("update public.publication_jobs set status = $2 where id = $1", [id, s]);
      await asUser(editor, (db) => db.query("select public.confirm_job_published($1, 'https://exemplo/p/1')", [id]), { commit: true });
      const ext = await pool.query("select source, permalink from public.external_publications where job_id = $1", [id]);
      expect(ext.rows[0]).toEqual({ source: "manual", permalink: "https://exemplo/p/1" });
    });
  });

  describe("isolamento", () => {
    it("alvo com conta de outro workspace e item com vídeo de outro workspace são recusados", async () => {
      const c = await seedCampaign(owner, ws, 1);
      const foreignAccount = await asUser(outsider, async (db) => (await db.query<{ id: string }>("select (public.create_simulated_account($1, 'F')).id", [otherWs])).rows[0]!.id, { commit: true });
      const [foreignMedia] = await seedMedia(otherWs, 1);
      await expectPgError(
        asUser(owner, (db) => db.query("insert into public.campaign_targets (campaign_id, workspace_id, social_account_id) values ($1,$2,$3)", [c.campaign, ws, foreignAccount])),
        DENIED,
      );
      await expectPgError(
        asUser(owner, (db) => db.query("insert into public.campaign_media (campaign_id, workspace_id, media_asset_id) values ($1,$2,$3)", [c.campaign, ws, foreignMedia])),
        DENIED,
      );
      // campanha de outro workspace, mesmo informando o próprio workspace_id
      await expectPgError(
        asUser(outsider, (db) => db.query("insert into public.campaign_media (campaign_id, workspace_id, media_asset_id) values ($1,$2,$3)", [c.campaign, otherWs, foreignMedia])),
        DENIED,
      );
    });

    it("tabelas operacionais do worker são inacessíveis", async () => {
      await expectPgError(asUser(owner, (db) => db.query("select * from public.mock_remote_posts")), DENIED);
      await expectPgError(asUser(owner, (db) => db.query("select * from public.worker_heartbeats")), DENIED);
      await expectPgError(asUser(owner, (db) => db.query("insert into public.publication_attempts (job_id, workspace_id, attempt_no, worker_id) values (gen_random_uuid(), $1, 1, 'x')", [ws])), DENIED);
    });

    it("automações: viewer lê; somente admin altera", async () => {
      await expectPgError(asUser(editor, (db) => db.query("select public.set_automation_rule($1, 'low_content_alert', false)", [ws])), DENIED);
      await asUser(owner, (db) => db.query("select public.set_automation_rule($1, 'low_content_alert', false, '{\"days\": 5}')", [ws]), { commit: true });
      const r = await asUser(viewer, (db) => db.query("select enabled, params from public.automation_rules where workspace_id = $1", [ws]));
      expect(r.rows[0]).toEqual({ enabled: false, params: { days: 5 } });
      await expectPgError(asUser(owner, (db) => db.query("select public.set_automation_rule($1, 'invented_rule', true)", [ws])), ["23514"]);
    });
  });
});

describe("recalcular preserva reagendamentos manuais", () => {
  it("publicação reagendada (fixada) não é removida no replanejamento", async () => {
    const owner = await createUser({ email: uniqueEmail("pin") });
    const ws = (await createWorkspaceAs(owner, "Pin")).id;
    const account = await asUser(owner, async (db) => (await db.query<{ id: string }>("select (public.create_simulated_account($1, 'S')).id", [ws])).rows[0]!.id, { commit: true });
    const campaign = (await pool.query<{ id: string }>(
      "insert into public.campaigns (workspace_id, name, timezone, weekdays, times, start_date, created_by) values ($1,'C','UTC','{1,2,3,4,5,6,7}','{09:00}',current_date,$2) returning id",
      [ws, owner],
    )).rows[0]!.id;
    const target = (await pool.query<{ id: string }>("insert into public.campaign_targets (campaign_id, workspace_id, social_account_id) values ($1,$2,$3) returning id", [campaign, ws, account])).rows[0]!.id;
    const media = (await pool.query<{ id: string }>(
      "insert into public.media_assets (workspace_id, name, original_filename, storage_path, mime_type, size_bytes, sha256) values ($1,'v','v',$2,'video/mp4',1,$3) returning id",
      [ws, `${ws}/${crypto.randomUUID()}/original.mp4`, "d".repeat(64)],
    )).rows[0]!.id;
    const cm = (await pool.query<{ id: string }>("insert into public.campaign_media (campaign_id, workspace_id, media_asset_id) values ($1,$2,$3) returning id", [campaign, ws, media])).rows[0]!.id;
    const at = new Date(Date.now() + 86_400_000).toISOString();
    await asUser(owner, (db) => db.query("select public.save_campaign_plan($1, $2::jsonb, true)", [campaign, JSON.stringify([{ campaign_media_id: cm, target_id: target, scheduled_at: at, local_date: at.slice(0, 10), local_time: "09:00", timezone: "UTC" }])]), { commit: true });
    const id = (await pool.query("select id from public.publication_jobs where campaign_id = $1", [campaign])).rows[0].id;
    await asUser(owner, (db) => db.query("select public.reschedule_job($1, now() + interval '3 days')", [id]), { commit: true });
    const r = await asUser(owner, async (db) => (await db.query("select * from public.save_campaign_plan($1, '[]'::jsonb, true)", [campaign])).rows[0], { commit: true });
    expect(r.removed).toBe(0);
    expect((await pool.query("select pinned from public.publication_jobs where id = $1", [id])).rows[0].pinned).toBe(true);
  });
});
