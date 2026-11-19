-- ReelsFlow · Fase 3 · Agendamento e fila de publicações
-- Contas sociais (inclui conta SIMULADA para o conector mock), modelos,
-- campanhas, alvos, itens, publication_jobs (fila persistente com lease),
-- tentativas, publicações externas, automações, heartbeats do worker.

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
create type public.social_platform as enum ('instagram', 'facebook', 'tiktok', 'youtube', 'mock');
create type public.campaign_status as enum ('draft', 'active', 'paused', 'completed', 'archived');
create type public.job_status as enum (
  'draft', 'scheduled', 'queued', 'preparing', 'uploading', 'processing_remote', 'publishing',
  'published', 'failed_retryable', 'failed_permanent', 'uncertain', 'needs_review', 'cancelled');

-- Janela de congelamento: publicações a menos disto do horário não são editadas.
create or replace function app.edit_freeze() returns interval language sql immutable as $$ select interval '2 minutes' $$;

-- ---------------------------------------------------------------------------
-- social_accounts
-- ---------------------------------------------------------------------------
create table public.social_accounts (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces (id) on delete cascade,
  platform            public.social_platform not null,
  external_account_id text not null,
  display_name        text not null check (char_length(display_name) between 1 and 120),
  avatar_url          text,
  status              text not null default 'active' check (status in ('active', 'needs_reauth', 'disconnected')),
  paused              boolean not null default false,
  min_spacing_minutes integer not null default 30 check (min_spacing_minutes between 0 and 1440),
  settings            jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  connected_by        uuid references auth.users (id) on delete set null,
  token_expires_at    timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (workspace_id, platform, external_account_id)
);
create index social_accounts_ws_idx on public.social_accounts (workspace_id);
create trigger social_accounts_updated_at before update on public.social_accounts
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- publication_templates
-- ---------------------------------------------------------------------------
create table public.publication_templates (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces (id) on delete cascade,
  name                 text not null check (char_length(trim(name)) between 1 and 80),
  mode                 text not null default 'mirrored' check (mode in ('mirrored', 'independent')),
  timezone             text not null,
  weekdays             smallint[] not null check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[1,2,3,4,5,6,7]::smallint[]),
  times                text[] not null check (cardinality(times) between 1 and 24),
  caption              text check (char_length(caption) <= 2200),
  hashtags             text[] not null default '{}' check (cardinality(hashtags) <= 30),
  order_strategy       text not null default 'upload' check (order_strategy in ('upload', 'oldest', 'newest', 'manual', 'random')),
  max_lateness_minutes integer not null default 120 check (max_lateness_minutes between 5 and 10080),
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index publication_templates_ws_name_uq on public.publication_templates (workspace_id, lower(name));
create trigger publication_templates_updated_at before update on public.publication_templates
  for each row execute function app.set_updated_at();

create or replace function app.validate_schedule_fields()
returns trigger language plpgsql as $$
declare t text;
begin
  perform app.assert_timezone(new.timezone);
  foreach t in array new.times loop
    if t !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'invalid time: %', t using errcode = '22023';
    end if;
  end loop;
  return new;
end $$;
create trigger publication_templates_validate before insert or update on public.publication_templates
  for each row execute function app.validate_schedule_fields();

-- ---------------------------------------------------------------------------
-- campaigns, campaign_targets, campaign_media
-- ---------------------------------------------------------------------------
create table public.campaigns (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces (id) on delete cascade,
  template_id          uuid references public.publication_templates (id) on delete set null,
  source_collection_id uuid references public.collections (id) on delete set null,
  name                 text not null check (char_length(trim(name)) between 1 and 120),
  status               public.campaign_status not null default 'draft',
  mode                 text not null default 'mirrored' check (mode in ('mirrored', 'independent')),
  timezone             text not null,
  weekdays             smallint[] not null check (cardinality(weekdays) between 1 and 7 and weekdays <@ array[1,2,3,4,5,6,7]::smallint[]),
  times                text[] not null check (cardinality(times) between 1 and 24),
  start_date           date not null,
  end_date             date check (end_date is null or end_date >= start_date),
  order_strategy       text not null default 'upload' check (order_strategy in ('upload', 'oldest', 'newest', 'manual', 'random')),
  random_seed          bigint not null default (floor(random() * 2147483647))::bigint,
  caption              text check (char_length(caption) <= 2200),
  hashtags             text[] not null default '{}' check (cardinality(hashtags) <= 30),
  max_lateness_minutes integer not null default 120 check (max_lateness_minutes between 5 and 10080),
  activated_at         timestamptz,
  completed_at         timestamptz,
  summary              jsonb,
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index campaigns_ws_status_idx on public.campaigns (workspace_id, status);
create trigger campaigns_updated_at before update on public.campaigns
  for each row execute function app.set_updated_at();
create trigger campaigns_validate before insert or update on public.campaigns
  for each row execute function app.validate_schedule_fields();

create table public.campaign_targets (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       uuid not null references public.campaigns (id) on delete cascade,
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  social_account_id uuid not null references public.social_accounts (id) on delete cascade,
  offset_minutes    integer not null default 0 check (offset_minutes between -720 and 720),
  weekdays          smallint[] check (weekdays is null or (cardinality(weekdays) between 1 and 7 and weekdays <@ array[1,2,3,4,5,6,7]::smallint[])),
  times             text[] check (times is null or cardinality(times) between 1 and 24),
  caption_override  text check (char_length(caption_override) <= 2200),
  hashtags_override text[] check (hashtags_override is null or cardinality(hashtags_override) <= 30),
  enabled           boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (campaign_id, social_account_id)
);
create index campaign_targets_account_idx on public.campaign_targets (social_account_id);

create table public.campaign_media (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       uuid not null references public.campaigns (id) on delete cascade,
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  media_asset_id    uuid not null references public.media_assets (id) on delete cascade,
  target_id         uuid references public.campaign_targets (id) on delete cascade,
  position          integer not null default 0,
  caption_override  text check (char_length(caption_override) <= 2200),
  hashtags_override text[] check (hashtags_override is null or cardinality(hashtags_override) <= 30),
  added_at          timestamptz not null default now()
);
create unique index campaign_media_uq on public.campaign_media
  (campaign_id, media_asset_id, coalesce(target_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index campaign_media_order_idx on public.campaign_media (campaign_id, position);

-- Alvos e itens só podem referenciar objetos do mesmo workspace da campanha.
create or replace function app.guard_campaign_children()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.campaigns c where c.id = new.campaign_id and c.workspace_id = new.workspace_id) then
    raise exception 'campaign workspace mismatch' using errcode = '42501';
  end if;
  if tg_table_name = 'campaign_targets' then
    if not exists (select 1 from public.social_accounts a where a.id = new.social_account_id and a.workspace_id = new.workspace_id) then
      raise exception 'account workspace mismatch' using errcode = '42501';
    end if;
  else
    if not exists (select 1 from public.media_assets m where m.id = new.media_asset_id and m.workspace_id = new.workspace_id) then
      raise exception 'media workspace mismatch' using errcode = '42501';
    end if;
    if new.target_id is not null and not exists (
        select 1 from public.campaign_targets t where t.id = new.target_id and t.campaign_id = new.campaign_id) then
      raise exception 'target does not belong to campaign' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger campaign_targets_guard before insert or update on public.campaign_targets
  for each row execute function app.guard_campaign_children();
create trigger campaign_media_guard before insert or update on public.campaign_media
  for each row execute function app.guard_campaign_children();

-- ---------------------------------------------------------------------------
-- publication_jobs — fila persistente
-- ---------------------------------------------------------------------------
create table public.publication_jobs (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces (id) on delete cascade,
  campaign_id         uuid references public.campaigns (id) on delete set null,
  campaign_media_id   uuid references public.campaign_media (id) on delete set null,
  target_id           uuid references public.campaign_targets (id) on delete set null,
  social_account_id   uuid references public.social_accounts (id) on delete set null,
  media_asset_id      uuid references public.media_assets (id) on delete set null,
  post_group_key      text,
  local_date          date not null,
  local_time          time not null,
  timezone            text not null,
  scheduled_at        timestamptz not null,
  dst_adjusted        boolean not null default false,
  status              public.job_status not null default 'draft',
  caption_override    text check (char_length(caption_override) <= 2200),
  effective_config    jsonb,
  attempt_count       integer not null default 0,
  max_attempts        integer not null default 6 check (max_attempts between 1 and 20),
  next_attempt_at     timestamptz not null default now(),
  lease_owner         text,
  lease_expires_at    timestamptz,
  external_checkpoint jsonb,
  reconcile_attempts  integer not null default 0,
  last_error_class    text,
  last_error_message  text,
  review_reason       text,
  -- Reagendada manualmente: preservada quando a campanha é recalculada.
  pinned              boolean not null default false,
  published_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Mesmo vídeo, mesmo alvo, mesma campanha: no máximo uma publicação não cancelada.
create unique index publication_jobs_no_dup_uq on public.publication_jobs (campaign_id, target_id, media_asset_id)
  where status <> 'cancelled';
-- Garantia de banco: no máximo UMA publicação em andamento por conta.
create unique index publication_jobs_one_inflight_per_account on public.publication_jobs (social_account_id)
  where status in ('preparing', 'uploading', 'processing_remote', 'publishing');
create index publication_jobs_due_idx on public.publication_jobs (scheduled_at) where status = 'scheduled';
create index publication_jobs_claim_idx on public.publication_jobs (next_attempt_at) where status in ('queued', 'failed_retryable');
create index publication_jobs_lease_idx on public.publication_jobs (lease_expires_at)
  where status in ('preparing', 'uploading', 'processing_remote', 'publishing');
create index publication_jobs_uncertain_idx on public.publication_jobs (updated_at) where status = 'uncertain';
create index publication_jobs_ws_time_idx on public.publication_jobs (workspace_id, scheduled_at);
create index publication_jobs_account_time_idx on public.publication_jobs (social_account_id, scheduled_at);
create index publication_jobs_campaign_idx on public.publication_jobs (campaign_id, scheduled_at);
create trigger publication_jobs_updated_at before update on public.publication_jobs
  for each row execute function app.set_updated_at();

-- Máquina de estados (espelha packages/domain/src/scheduling/job-state.ts).
create or replace function app.job_transition_allowed(f public.job_status, t public.job_status)
returns boolean language sql immutable as $$
  select f = t or (f, t) in (
    ('draft','scheduled'), ('draft','cancelled'),
    ('scheduled','queued'), ('scheduled','needs_review'), ('scheduled','cancelled'), ('scheduled','draft'),
    ('queued','preparing'), ('queued','scheduled'), ('queued','needs_review'), ('queued','cancelled'),
    ('preparing','uploading'), ('preparing','processing_remote'), ('preparing','publishing'), ('preparing','published'),
    ('preparing','failed_retryable'), ('preparing','failed_permanent'), ('preparing','uncertain'), ('preparing','queued'),
    ('uploading','processing_remote'), ('uploading','publishing'), ('uploading','published'),
    ('uploading','failed_retryable'), ('uploading','failed_permanent'), ('uploading','uncertain'),
    ('processing_remote','publishing'), ('processing_remote','published'),
    ('processing_remote','failed_retryable'), ('processing_remote','failed_permanent'), ('processing_remote','uncertain'),
    ('publishing','published'), ('publishing','failed_retryable'), ('publishing','failed_permanent'), ('publishing','uncertain'),
    ('failed_retryable','preparing'), ('failed_retryable','scheduled'), ('failed_retryable','needs_review'),
    ('failed_retryable','failed_permanent'), ('failed_retryable','cancelled'),
    ('failed_permanent','scheduled'), ('failed_permanent','cancelled'),
    ('uncertain','published'), ('uncertain','failed_retryable'), ('uncertain','needs_review'), ('uncertain','failed_permanent'),
    ('needs_review','scheduled'), ('needs_review','cancelled'), ('needs_review','published'))
$$;

create or replace function app.guard_job_transition()
returns trigger language plpgsql as $$
begin
  if not app.job_transition_allowed(old.status, new.status) then
    raise exception 'invalid job transition % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger publication_jobs_guard_status before update of status on public.publication_jobs
  for each row execute function app.guard_job_transition();

-- ---------------------------------------------------------------------------
-- Tentativas, publicações externas, plataforma simulada
-- ---------------------------------------------------------------------------
create table public.publication_attempts (
  id                  bigint generated always as identity primary key,
  job_id              uuid not null references public.publication_jobs (id) on delete cascade,
  workspace_id        uuid not null references public.workspaces (id) on delete cascade,
  attempt_no          integer not null,
  worker_id           text not null,
  kind                text not null default 'publish' check (kind in ('publish', 'reconcile')),
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  phase_reached       text,
  outcome             text check (outcome in ('published', 'retry', 'permanent', 'uncertain', 'not_found', 'unknown', 'aborted')),
  error_class         text,
  error_code          text,
  error_message       text,
  retry_after_seconds integer,
  checkpoint          jsonb
);
create index publication_attempts_job_idx on public.publication_attempts (job_id, id);

create table public.external_publications (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null unique references public.publication_jobs (id) on delete cascade,
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  social_account_id uuid references public.social_accounts (id) on delete set null,
  platform          public.social_platform not null,
  external_id       text,
  permalink         text,
  published_at      timestamptz not null default now(),
  source            text not null default 'api' check (source in ('api', 'reconciled', 'manual')),
  created_at        timestamptz not null default now()
);
create index external_publications_ws_idx on public.external_publications (workspace_id, published_at desc);

-- Estado da "plataforma" simulada (conector mock). Persistido para que a
-- reconciliação funcione entre reinícios, como numa API real.
create table public.mock_remote_posts (
  id                text primary key default ('mock_' || replace(gen_random_uuid()::text, '-', '')),
  social_account_id uuid not null,
  upload_ref        text not null unique,
  caption           text,
  status            text not null default 'processing' check (status in ('processing', 'published')),
  created_at        timestamptz not null default now(),
  published_at      timestamptz
);

-- ---------------------------------------------------------------------------
-- Automações e operação
-- ---------------------------------------------------------------------------
create table public.automation_rules (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  rule_key     text not null check (rule_key in ('append_from_collection', 'retry_transient', 'low_content_alert', 'complete_campaign', 'pause_on_auth_loss')),
  enabled      boolean not null default true,
  params       jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  updated_by   uuid references auth.users (id) on delete set null,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, rule_key)
);

create table public.automation_runs (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  rule_key     text not null,
  subject_type text not null,
  subject_id   text,
  outcome      text not null,
  details      jsonb not null default '{}'::jsonb,
  dedupe_key   text unique,
  created_at   timestamptz not null default now()
);
create index automation_runs_ws_idx on public.automation_runs (workspace_id, created_at desc);

create table public.worker_heartbeats (
  worker_id    text primary key,
  kind         text not null,
  version      text,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Conta simulada para testar o fluxo sem redes reais. Sempre identificada como
-- "Simulada"; o conector mock nunca acessa serviços externos.
create or replace function public.create_simulated_account(p_workspace uuid, p_name text, p_behavior text default 'success')
returns public.social_accounts language plpgsql security definer set search_path = '' as $$
declare a public.social_accounts;
begin
  if not app.has_role(p_workspace, 'admin') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if p_behavior not in ('success', 'flaky', 'transient', 'permanent', 'timeout_before', 'timeout_after', 'rate_limit', 'auth_revoked', 'uncertain', 'slow') then
    raise exception 'invalid behavior' using errcode = '22023';
  end if;
  insert into public.social_accounts (workspace_id, platform, external_account_id, display_name, connected_by, settings)
  values (p_workspace, 'mock', 'sim_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), left(trim(p_name), 120),
          (select auth.uid()), jsonb_build_object('mock_behavior', p_behavior))
  returning * into a;
  perform app.audit(p_workspace, 'account.connected', 'social_account', a.id::text, jsonb_build_object('platform', 'mock'));
  return a;
end $$;

-- Remove conta: cancela publicações futuras editáveis; histórico é mantido.
create or replace function public.delete_social_account(p_account uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.social_accounts;
begin
  select * into a from public.social_accounts where id = p_account;
  if a.id is null or not app.has_role(a.workspace_id, 'admin') then
    raise exception 'not found' using errcode = '42501';
  end if;
  if exists (select 1 from public.publication_jobs j where j.social_account_id = a.id
              and j.status in ('preparing', 'uploading', 'processing_remote', 'publishing', 'uncertain')) then
    raise exception 'account has publications in progress' using errcode = 'P0001';
  end if;
  update public.publication_jobs set status = 'cancelled'
   where social_account_id = a.id and status in ('draft', 'scheduled', 'queued', 'failed_retryable', 'failed_permanent', 'needs_review');
  delete from public.social_accounts where id = a.id;
  perform app.audit(a.workspace_id, 'account.removed', 'social_account', a.id::text, jsonb_build_object('name', a.display_name));
end $$;

-- Grava o plano calculado pela aplicação (packages/domain buildPlan).
-- p_replace = true remove antes as publicações futuras ainda editáveis da campanha.
-- Validações de integridade e tempo são feitas aqui; o conteúdo do plano
-- (quais horários) é responsabilidade da aplicação.
create or replace function public.save_campaign_plan(p_campaign uuid, p_jobs jsonb, p_replace boolean default true)
returns table (inserted integer, skipped_duplicates integer, removed integer)
language plpgsql security definer set search_path = '' as $$
declare
  c public.campaigns;
  j jsonb;
  v_target public.campaign_targets;
  v_cm public.campaign_media;
  v_at timestamptz;
  v_status public.job_status;
  v_ins integer := 0;
  v_dup integer := 0;
  v_rem integer := 0;
  v_rows integer;
begin
  select * into c from public.campaigns where id = p_campaign for update;
  if c.id is null or not app.has_role(c.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;
  if c.status not in ('draft', 'active', 'paused') then
    raise exception 'campaign is not editable' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_jobs) <> 'array' or jsonb_array_length(p_jobs) > 5000 then
    raise exception 'invalid plan' using errcode = '22023';
  end if;

  if p_replace then
    delete from public.publication_jobs
     where campaign_id = c.id and status in ('draft', 'scheduled', 'needs_review') and not pinned
       and scheduled_at > now() + app.edit_freeze();
    get diagnostics v_rem = row_count;
  end if;

  v_status := case when c.status = 'draft' then 'draft'::public.job_status else 'scheduled'::public.job_status end;

  for j in select * from jsonb_array_elements(p_jobs) loop
    select * into v_target from public.campaign_targets where id = (j ->> 'target_id')::uuid and campaign_id = c.id;
    select * into v_cm from public.campaign_media where id = (j ->> 'campaign_media_id')::uuid and campaign_id = c.id;
    if v_target.id is null or v_cm.id is null then
      raise exception 'plan references objects outside the campaign' using errcode = '42501';
    end if;
    if v_cm.target_id is not null and v_cm.target_id <> v_target.id then
      raise exception 'media item belongs to another target' using errcode = '42501';
    end if;
    v_at := (j ->> 'scheduled_at')::timestamptz;
    if v_at <= now() + app.edit_freeze() then
      raise exception 'scheduled time must be in the future' using errcode = '22023';
    end if;
    perform app.assert_timezone(j ->> 'timezone');

    insert into public.publication_jobs
      (workspace_id, campaign_id, campaign_media_id, target_id, social_account_id, media_asset_id, post_group_key,
       local_date, local_time, timezone, scheduled_at, dst_adjusted, status, next_attempt_at)
    values
      (c.workspace_id, c.id, v_cm.id, v_target.id, v_target.social_account_id, v_cm.media_asset_id, j ->> 'post_group_key',
       (j ->> 'local_date')::date, (j ->> 'local_time')::time, j ->> 'timezone', v_at,
       coalesce((j ->> 'dst_adjusted')::boolean, false), v_status, v_at)
    on conflict (campaign_id, target_id, media_asset_id) where status <> 'cancelled' do nothing;
    get diagnostics v_rows = row_count;
    if v_rows = 1 then v_ins := v_ins + 1; else v_dup := v_dup + 1; end if;
  end loop;

  perform app.audit(c.workspace_id, 'campaign.planned', 'campaign', c.id::text,
    jsonb_build_object('inserted', v_ins, 'duplicates', v_dup, 'removed', v_rem));
  inserted := v_ins; skipped_duplicates := v_dup; removed := v_rem;
  return next;
end $$;

create or replace function public.set_campaign_status(p_campaign uuid, p_action text)
returns public.campaign_status language plpgsql security definer set search_path = '' as $$
declare
  c public.campaigns;
  v_new public.campaign_status;
begin
  select * into c from public.campaigns where id = p_campaign for update;
  if c.id is null or not app.has_role(c.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;

  if p_action = 'activate' and c.status = 'draft' then
    if not exists (select 1 from public.campaign_targets t where t.campaign_id = c.id and t.enabled) then
      raise exception 'campaign has no targets' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.publication_jobs j where j.campaign_id = c.id and j.status = 'draft') then
      raise exception 'campaign has no planned publications' using errcode = 'P0001';
    end if;
    update public.publication_jobs set status = 'needs_review', review_reason = 'scheduled_time_passed_before_activation'
     where campaign_id = c.id and status = 'draft' and scheduled_at <= now() + app.edit_freeze();
    update public.publication_jobs set status = 'scheduled' where campaign_id = c.id and status = 'draft';
    v_new := 'active';
    update public.campaigns set status = v_new, activated_at = now() where id = c.id;
  elsif p_action = 'pause' and c.status = 'active' then
    v_new := 'paused';
    update public.campaigns set status = v_new where id = c.id;
  elsif p_action = 'resume' and c.status = 'paused' then
    v_new := 'active';
    update public.campaigns set status = v_new where id = c.id;
  elsif p_action = 'archive' and c.status in ('draft', 'paused', 'completed', 'active') then
    if exists (select 1 from public.publication_jobs j where j.campaign_id = c.id
                and j.status in ('preparing', 'uploading', 'processing_remote', 'publishing', 'uncertain')) then
      raise exception 'campaign has publications in progress' using errcode = 'P0001';
    end if;
    update public.publication_jobs set status = 'cancelled'
     where campaign_id = c.id and status in ('draft', 'scheduled', 'queued', 'failed_retryable', 'failed_permanent', 'needs_review');
    v_new := 'archived';
    update public.campaigns set status = v_new where id = c.id;
  else
    raise exception 'invalid campaign action % from %', p_action, c.status using errcode = 'P0001';
  end if;

  perform app.audit(c.workspace_id, 'campaign.' || p_action, 'campaign', c.id::text,
    jsonb_build_object('from', c.status, 'to', v_new));
  return v_new;
end $$;

-- Cancela publicações (somente as que ainda não começaram ou já falharam).
create or replace function public.cancel_jobs(p_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare r record; n integer := 0;
begin
  for r in select * from public.publication_jobs where id = any (p_ids) for update loop
    if not app.has_role(r.workspace_id, 'editor') then
      raise exception 'permission denied' using errcode = '42501';
    end if;
    if r.status in ('draft', 'scheduled', 'queued', 'failed_retryable', 'failed_permanent', 'needs_review') then
      update public.publication_jobs set status = 'cancelled', lease_owner = null, lease_expires_at = null where id = r.id;
      n := n + 1;
    end if;
  end loop;
  if n > 0 then
    perform app.audit((select workspace_id from public.publication_jobs where id = p_ids[1]), 'jobs.cancelled', 'publication_job', null,
                      jsonb_build_object('count', n));
  end if;
  return n;
end $$;

-- Reagenda uma publicação (inclui "tentar novamente" de falhas e itens em revisão).
create or replace function public.reschedule_job(p_job uuid, p_at timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.publication_jobs; c public.campaigns;
begin
  select * into r from public.publication_jobs where id = p_job for update;
  if r.id is null or not app.has_role(r.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;
  if r.status not in ('draft', 'scheduled', 'needs_review', 'failed_retryable', 'failed_permanent') then
    raise exception 'publication cannot be rescheduled in status %', r.status using errcode = 'P0001';
  end if;
  if r.status in ('draft', 'scheduled') and r.scheduled_at <= now() + app.edit_freeze() then
    raise exception 'publication is too close to its scheduled time' using errcode = 'P0001';
  end if;
  if p_at <= now() + app.edit_freeze() then
    raise exception 'scheduled time must be in the future' using errcode = '22023';
  end if;
  select * into c from public.campaigns where id = r.campaign_id;
  update public.publication_jobs
     set scheduled_at = p_at,
         next_attempt_at = p_at,
         local_date = (p_at at time zone r.timezone)::date,
         local_time = (p_at at time zone r.timezone)::time,
         dst_adjusted = false,
         pinned = true,
         status = case when r.status = 'draft' or c.status = 'draft' then 'draft'::public.job_status else 'scheduled'::public.job_status end,
         attempt_count = case when r.status in ('failed_retryable', 'failed_permanent', 'needs_review') then 0 else attempt_count end,
         review_reason = null,
         last_error_class = case when r.status in ('failed_permanent', 'needs_review') then null else last_error_class end
   where id = r.id;
  perform app.audit(r.workspace_id, 'job.rescheduled', 'publication_job', r.id::text,
    jsonb_build_object('from', r.scheduled_at, 'to', p_at, 'status', r.status));
end $$;

create or replace function public.update_job_caption(p_job uuid, p_caption text)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.publication_jobs;
begin
  select * into r from public.publication_jobs where id = p_job for update;
  if r.id is null or not app.has_role(r.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;
  if r.status not in ('draft', 'scheduled', 'needs_review', 'failed_retryable', 'failed_permanent') then
    raise exception 'publication caption cannot be edited in status %', r.status using errcode = 'P0001';
  end if;
  update public.publication_jobs set caption_override = nullif(left(p_caption, 2200), '') where id = r.id;
end $$;

-- O usuário confirma que um item em revisão (ex.: incerto) já está publicado.
create or replace function public.confirm_job_published(p_job uuid, p_permalink text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.publication_jobs; a public.social_accounts;
begin
  select * into r from public.publication_jobs where id = p_job for update;
  if r.id is null or not app.has_role(r.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;
  if r.status <> 'needs_review' then
    raise exception 'only publications under review can be confirmed' using errcode = 'P0001';
  end if;
  select * into a from public.social_accounts where id = r.social_account_id;
  update public.publication_jobs set status = 'published', published_at = now(), review_reason = null where id = r.id;
  insert into public.external_publications (job_id, workspace_id, social_account_id, platform, permalink, source)
  values (r.id, r.workspace_id, r.social_account_id, coalesce(a.platform, 'mock'), nullif(p_permalink, ''), 'manual')
  on conflict (job_id) do nothing;
  perform app.audit(r.workspace_id, 'job.confirmed_published', 'publication_job', r.id::text, '{}'::jsonb);
end $$;

create or replace function public.set_automation_rule(p_workspace uuid, p_rule text, p_enabled boolean, p_params jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not app.has_role(p_workspace, 'admin') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  insert into public.automation_rules (workspace_id, rule_key, enabled, params, updated_by, updated_at)
  values (p_workspace, p_rule, p_enabled, coalesce(p_params, '{}'::jsonb), (select auth.uid()), now())
  on conflict (workspace_id, rule_key) do update
    set enabled = excluded.enabled, params = excluded.params, updated_by = excluded.updated_by, updated_at = now();
  perform app.audit(p_workspace, 'automation.updated', 'automation_rule', p_rule,
    jsonb_build_object('enabled', p_enabled, 'params', p_params));
end $$;

-- Último sinal de vida de qualquer worker (sem expor detalhes operacionais).
create or replace function public.worker_last_seen()
returns timestamptz language sql stable security definer set search_path = '' as $$
  select max(last_seen_at) from public.worker_heartbeats
$$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.worker_last_seen()',
    'public.create_simulated_account(uuid, text, text)', 'public.delete_social_account(uuid)',
    'public.save_campaign_plan(uuid, jsonb, boolean)', 'public.set_campaign_status(uuid, text)',
    'public.cancel_jobs(uuid[])', 'public.reschedule_job(uuid, timestamptz)', 'public.update_job_caption(uuid, text)',
    'public.confirm_job_published(uuid, text)', 'public.set_automation_rule(uuid, text, boolean, jsonb)'] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.social_accounts       enable row level security;
alter table public.publication_templates enable row level security;
alter table public.campaigns             enable row level security;
alter table public.campaign_targets      enable row level security;
alter table public.campaign_media        enable row level security;
alter table public.publication_jobs      enable row level security;
alter table public.publication_attempts  enable row level security;
alter table public.external_publications enable row level security;
alter table public.mock_remote_posts     enable row level security;
alter table public.automation_rules      enable row level security;
alter table public.automation_runs       enable row level security;
alter table public.worker_heartbeats     enable row level security;

revoke all on public.social_accounts, public.publication_templates, public.campaigns, public.campaign_targets,
              public.campaign_media, public.publication_jobs, public.publication_attempts, public.external_publications,
              public.mock_remote_posts, public.automation_rules, public.automation_runs, public.worker_heartbeats
  from anon, authenticated;

grant select on public.social_accounts to authenticated;
grant update (display_name, paused, min_spacing_minutes, settings) on public.social_accounts to authenticated;

grant select, insert, delete on public.publication_templates to authenticated;
grant update (name, mode, timezone, weekdays, times, caption, hashtags, order_strategy, max_lateness_minutes)
  on public.publication_templates to authenticated;

grant select on public.campaigns to authenticated;
grant insert (workspace_id, template_id, source_collection_id, name, mode, timezone, weekdays, times, start_date, end_date,
              order_strategy, caption, hashtags, max_lateness_minutes, created_by) on public.campaigns to authenticated;
grant update (template_id, source_collection_id, name, mode, timezone, weekdays, times, start_date, end_date,
              order_strategy, random_seed, caption, hashtags, max_lateness_minutes) on public.campaigns to authenticated;

grant select, insert, delete on public.campaign_targets to authenticated;
grant update (offset_minutes, weekdays, times, caption_override, hashtags_override, enabled) on public.campaign_targets to authenticated;
grant select, insert, delete on public.campaign_media to authenticated;
grant update (position, caption_override, hashtags_override) on public.campaign_media to authenticated;

grant select on public.publication_jobs, public.publication_attempts, public.external_publications,
                public.automation_rules, public.automation_runs to authenticated;

create policy social_accounts_select on public.social_accounts for select to authenticated
  using (app.has_role(workspace_id, 'viewer'));
create policy social_accounts_update on public.social_accounts for update to authenticated
  using (app.has_role(workspace_id, 'admin')) with check (app.has_role(workspace_id, 'admin'));

create policy templates_select on public.publication_templates for select to authenticated using (app.has_role(workspace_id, 'viewer'));
create policy templates_insert on public.publication_templates for insert to authenticated
  with check (app.has_role(workspace_id, 'editor') and created_by = (select auth.uid()));
create policy templates_update on public.publication_templates for update to authenticated
  using (app.has_role(workspace_id, 'editor')) with check (app.has_role(workspace_id, 'editor'));
create policy templates_delete on public.publication_templates for delete to authenticated using (app.has_role(workspace_id, 'editor'));

create policy campaigns_select on public.campaigns for select to authenticated using (app.has_role(workspace_id, 'viewer'));
create policy campaigns_insert on public.campaigns for insert to authenticated
  with check (app.has_role(workspace_id, 'editor') and created_by = (select auth.uid()));
create policy campaigns_update on public.campaigns for update to authenticated
  using (app.has_role(workspace_id, 'editor') and status in ('draft', 'active', 'paused'))
  with check (app.has_role(workspace_id, 'editor'));

create policy campaign_targets_select on public.campaign_targets for select to authenticated using (app.has_role(workspace_id, 'viewer'));
create policy campaign_targets_write on public.campaign_targets for insert to authenticated with check (app.has_role(workspace_id, 'editor'));
create policy campaign_targets_update on public.campaign_targets for update to authenticated
  using (app.has_role(workspace_id, 'editor')) with check (app.has_role(workspace_id, 'editor'));
create policy campaign_targets_delete on public.campaign_targets for delete to authenticated using (app.has_role(workspace_id, 'editor'));

create policy campaign_media_select on public.campaign_media for select to authenticated using (app.has_role(workspace_id, 'viewer'));
create policy campaign_media_write on public.campaign_media for insert to authenticated with check (app.has_role(workspace_id, 'editor'));
create policy campaign_media_update on public.campaign_media for update to authenticated
  using (app.has_role(workspace_id, 'editor')) with check (app.has_role(workspace_id, 'editor'));
create policy campaign_media_delete on public.campaign_media for delete to authenticated using (app.has_role(workspace_id, 'editor'));

create policy jobs_select on public.publication_jobs for select to authenticated using (app.has_role(workspace_id, 'viewer'));
create policy attempts_select on public.publication_attempts for select to authenticated using (app.has_role(workspace_id, 'viewer'));
create policy external_select on public.external_publications for select to authenticated using (app.has_role(workspace_id, 'viewer'));
create policy automation_rules_select on public.automation_rules for select to authenticated using (app.has_role(workspace_id, 'viewer'));
create policy automation_runs_select on public.automation_runs for select to authenticated using (app.has_role(workspace_id, 'viewer'));
-- mock_remote_posts e worker_heartbeats: sem policies (somente worker).
