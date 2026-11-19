-- ReelsFlow · Fase 1 · Fundação
-- Tabelas: profiles, workspaces, workspace_members, subscriptions, usage_records,
--          notifications, audit_logs.
-- Princípios: RLS em todas as tabelas; escrita sensível apenas via funções
-- SECURITY DEFINER; grants de coluna para impedir alteração de campos protegidos.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Schema privado para helpers (não exposto pela Data API)
-- ---------------------------------------------------------------------------
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

create type public.workspace_role as enum ('viewer', 'editor', 'admin', 'owner');

create or replace function app.role_rank(r public.workspace_role)
returns int language sql immutable as $$
  select case r when 'viewer' then 0 when 'editor' then 1 when 'admin' then 2 when 'owner' then 3 end
$$;

create or replace function app.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function app.assert_timezone(tz text)
returns void language plpgsql stable as $$
begin
  if tz is null or not exists (select 1 from pg_timezone_names where name = tz) then
    raise exception 'invalid timezone: %', tz using errcode = '22023';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- profiles (1:1 com auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id               uuid primary key references auth.users (id) on delete cascade,
  display_name     text not null default '' check (char_length(display_name) <= 80),
  locale           text not null default 'pt-BR' check (char_length(locale) <= 16),
  default_timezone text not null default 'America/Sao_Paulo',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create or replace function app.validate_profile()
returns trigger language plpgsql as $$
begin
  perform app.assert_timezone(new.default_timezone);
  return new;
end $$;

create trigger profiles_validate before insert or update on public.profiles
  for each row execute function app.validate_profile();
create trigger profiles_updated_at before update on public.profiles
  for each row execute function app.set_updated_at();

-- Cria profile automaticamente no signup.
create or replace function app.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), ''), 80)
  );
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- ---------------------------------------------------------------------------
-- workspaces
-- ---------------------------------------------------------------------------
create table public.workspaces (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (char_length(trim(name)) between 2 and 80),
  slug             text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  created_by       uuid references auth.users (id) on delete set null,
  default_timezone text not null default 'America/Sao_Paulo',
  is_demo          boolean not null default false,
  queue_paused     boolean not null default false,
  settings         jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index workspaces_created_by_idx on public.workspaces (created_by);

create or replace function app.validate_workspace()
returns trigger language plpgsql as $$
begin
  perform app.assert_timezone(new.default_timezone);
  return new;
end $$;

create trigger workspaces_validate before insert or update on public.workspaces
  for each row execute function app.validate_workspace();
create trigger workspaces_updated_at before update on public.workspaces
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- workspace_members
-- ---------------------------------------------------------------------------
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         public.workspace_role not null default 'viewer',
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_idx on public.workspace_members (user_id);

-- Helper central de autorização. SECURITY DEFINER evita recursão de RLS ao
-- consultar workspace_members dentro das próprias policies.
create or replace function app.has_role(ws uuid, min_role public.workspace_role)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws
      and m.user_id = (select auth.uid())
      and app.role_rank(m.role) >= app.role_rank(min_role)
  )
$$;

revoke all on function app.has_role(uuid, public.workspace_role) from public;
grant execute on function app.has_role(uuid, public.workspace_role) to authenticated, service_role;

-- Impede que um workspace com outros membros fique sem owner (rebaixamento,
-- remoção, saída ou exclusão da conta do último owner). Se o último owner é
-- também o último membro, a remoção é permitida e o workspace é apagado por
-- app.cleanup_empty_workspace.
create or replace function app.guard_last_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.role <> 'owner' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' then
    return new;
  end if;
  -- Workspace sendo apagado (cascata): nada a proteger.
  if not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return coalesce(new, old);
  end if;
  if exists (select 1 from public.workspace_members m
              where m.workspace_id = old.workspace_id and m.role = 'owner' and m.user_id <> old.user_id) then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from public.workspace_members m
              where m.workspace_id = old.workspace_id and m.user_id <> old.user_id) then
    return old;  -- último membro: workspace será removido
  end if;
  raise exception 'workspace must keep at least one owner; transfer ownership first'
    using errcode = 'P0001';
end $$;

create trigger workspace_members_guard_last_owner
  before update or delete on public.workspace_members
  for each row execute function app.guard_last_owner();

create or replace function app.cleanup_empty_workspace()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.workspace_members m where m.workspace_id = old.workspace_id) then
    delete from public.workspaces w where w.id = old.workspace_id;
  end if;
  return old;
end $$;

create trigger workspace_members_cleanup_empty
  after delete on public.workspace_members
  for each row execute function app.cleanup_empty_workspace();

-- ---------------------------------------------------------------------------
-- subscriptions / usage_records (sem cobrança real; só leitura pelo cliente)
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  plan         text not null default 'starter' check (plan in ('starter', 'pro', 'agency')),
  status       text not null default 'active' check (status in ('active', 'past_due', 'canceled')),
  limits       jsonb not null default '{}'::jsonb,
  provider_ref text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger subscriptions_updated_at before update on public.subscriptions
  for each row execute function app.set_updated_at();

create table public.usage_records (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  metric       text not null check (metric in
                 ('storage_bytes', 'uploads', 'publications', 'connected_accounts', 'ai_tokens', 'processing_seconds')),
  quantity     bigint not null default 0 check (quantity >= 0),
  period_start date not null,
  updated_at   timestamptz not null default now(),
  unique (workspace_id, metric, period_start)
);

-- ---------------------------------------------------------------------------
-- notifications (por usuário; broadcast = uma linha por membro)
-- ---------------------------------------------------------------------------
create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  type         text not null check (char_length(type) <= 64),
  payload      jsonb not null default '{}'::jsonb,
  read_at      timestamptz,
  email_status text check (email_status in ('pending', 'sent', 'failed', 'skipped')),
  created_at   timestamptz not null default now()
);
create index notifications_user_unread_idx on public.notifications (user_id, created_at desc) where read_at is null;
create index notifications_ws_idx on public.notifications (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- audit_logs (append-only)
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id           bigint generated always as identity primary key,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  actor_id     uuid,          -- sem FK: o registro sobrevive à exclusão do usuário
  action       text not null,
  entity       text not null,
  entity_id    text,
  diff         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index audit_logs_ws_idx on public.audit_logs (workspace_id, created_at desc);

create or replace function app.audit(
  p_workspace uuid, p_action text, p_entity text, p_entity_id text, p_diff jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_logs (workspace_id, actor_id, action, entity, entity_id, diff)
  values (p_workspace, (select auth.uid()), p_action, p_entity, p_entity_id, coalesce(p_diff, '{}'::jsonb));
$$;
revoke all on function app.audit(uuid, text, text, text, jsonb) from public;

create or replace function app.audit_workspace_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform app.audit(new.id, 'workspace.updated', 'workspace', new.id::text,
    jsonb_build_object(
      'name', jsonb_build_array(old.name, new.name),
      'default_timezone', jsonb_build_array(old.default_timezone, new.default_timezone),
      'queue_paused', jsonb_build_array(old.queue_paused, new.queue_paused)));
  return new;
end $$;
create trigger workspaces_audit after update on public.workspaces
  for each row when (old.name is distinct from new.name
                  or old.default_timezone is distinct from new.default_timezone
                  or old.queue_paused is distinct from new.queue_paused
                  or old.settings is distinct from new.settings)
  execute function app.audit_workspace_change();

create or replace function app.audit_member_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Não auditar cascatas de exclusão do próprio workspace.
  if tg_op = 'DELETE' and not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return old;
  end if;
  perform app.audit(
    coalesce(new.workspace_id, old.workspace_id),
    'member.' || lower(tg_op), 'workspace_member',
    coalesce(new.user_id, old.user_id)::text,
    jsonb_build_object('old_role', old.role, 'new_role', new.role));
  return coalesce(new, old);
end $$;
create trigger workspace_members_audit after insert or update or delete on public.workspace_members
  for each row execute function app.audit_member_change();

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Cria workspace + membership owner + assinatura starter, atomicamente.
create or replace function public.create_workspace(p_name text, p_timezone text)
returns public.workspaces
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  base text;
  candidate text;
  ws public.workspaces;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users u where u.id = uid and u.email_confirmed_at is not null) then
    raise exception 'email not confirmed' using errcode = '42501';
  end if;
  p_name := trim(coalesce(p_name, ''));
  if char_length(p_name) not between 2 and 80 then
    raise exception 'invalid workspace name' using errcode = '22023';
  end if;
  perform app.assert_timezone(p_timezone);

  base := lower(regexp_replace(
            translate(p_name,
              'áàâãäåéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ',
              'aaaaaaeeeeiiiiooooouuuucnAAAAAAEEEEIIIIOOOOOUUUUCN'),
            '[^a-zA-Z0-9]+', '-', 'g'));
  base := trim(both '-' from left(base, 48));
  if base = '' then base := 'workspace'; end if;

  loop
    candidate := base || '-' || substr(encode(extensions.gen_random_bytes(4), 'hex'), 1, 6);
    exit when not exists (select 1 from public.workspaces w where w.slug = candidate);
  end loop;

  insert into public.workspaces (name, slug, created_by, default_timezone)
  values (p_name, candidate, uid, p_timezone)
  returning * into ws;

  insert into public.workspace_members (workspace_id, user_id, role) values (ws.id, uid, 'owner');
  insert into public.subscriptions (workspace_id) values (ws.id);
  perform app.audit(ws.id, 'workspace.created', 'workspace', ws.id::text, jsonb_build_object('name', ws.name));
  return ws;
end $$;

revoke all on function public.create_workspace(text, text) from public, anon;
grant execute on function public.create_workspace(text, text) to authenticated;

-- Marca notificações como lidas (apenas as do próprio usuário).
create or replace function public.mark_notifications_read(p_ids uuid[])
returns int language sql security definer set search_path = '' as $$
  with u as (
    update public.notifications n set read_at = now()
     where n.id = any (p_ids) and n.user_id = (select auth.uid()) and n.read_at is null
    returning 1)
  select count(*)::int from u;
$$;
revoke all on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- Lista workspaces que impedem a exclusão da conta: o usuário é o único owner
-- e existem outros membros (que perderiam acesso).
create or replace function public.account_deletion_blockers()
returns table (workspace_id uuid, workspace_name text, other_members int)
language sql stable security definer set search_path = '' as $$
  select w.id, w.name,
         (select count(*)::int from public.workspace_members m2
           where m2.workspace_id = w.id and m2.user_id <> (select auth.uid()))
    from public.workspaces w
    join public.workspace_members m on m.workspace_id = w.id
   where m.user_id = (select auth.uid()) and m.role = 'owner'
     and not exists (select 1 from public.workspace_members o
                      where o.workspace_id = w.id and o.role = 'owner' and o.user_id <> (select auth.uid()))
     and exists (select 1 from public.workspace_members x
                  where x.workspace_id = w.id and x.user_id <> (select auth.uid()));
$$;
revoke all on function public.account_deletion_blockers() from public, anon;
grant execute on function public.account_deletion_blockers() to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.subscriptions     enable row level security;
alter table public.usage_records     enable row level security;
alter table public.notifications     enable row level security;
alter table public.audit_logs        enable row level security;

-- Nenhum acesso anônimo a dados de domínio.
revoke all on public.profiles, public.workspaces, public.workspace_members, public.subscriptions,
              public.usage_records, public.notifications, public.audit_logs from anon;

-- Grants mínimos para authenticated; RLS restringe linhas, grants restringem colunas.
revoke all on public.profiles, public.workspaces, public.workspace_members, public.subscriptions,
              public.usage_records, public.notifications, public.audit_logs from authenticated;

grant select on public.profiles to authenticated;
grant update (display_name, locale, default_timezone) on public.profiles to authenticated;

grant select on public.workspaces to authenticated;
grant update (name, default_timezone, queue_paused, settings) on public.workspaces to authenticated;
grant delete on public.workspaces to authenticated;

grant select, insert, delete on public.workspace_members to authenticated;
grant update (role) on public.workspace_members to authenticated;

grant select on public.subscriptions, public.usage_records, public.notifications, public.audit_logs to authenticated;

-- profiles: o próprio usuário, ou colegas de workspace (para exibir nomes).
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1 from public.workspace_members mine
      join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
      where mine.user_id = (select auth.uid()) and theirs.user_id = profiles.id)
  );
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- workspaces
create policy workspaces_select on public.workspaces for select to authenticated
  using (app.has_role(id, 'viewer'));
create policy workspaces_update on public.workspaces for update to authenticated
  using (app.has_role(id, 'admin')) with check (app.has_role(id, 'admin'));
create policy workspaces_delete on public.workspaces for delete to authenticated
  using (app.has_role(id, 'owner'));
-- insert: somente via create_workspace().

-- workspace_members
create policy members_select on public.workspace_members for select to authenticated
  using (app.has_role(workspace_id, 'viewer'));
create policy members_insert on public.workspace_members for insert to authenticated
  with check (
    app.has_role(workspace_id, 'admin')
    and (role <> 'owner' or app.has_role(workspace_id, 'owner')));
create policy members_update on public.workspace_members for update to authenticated
  using (
    app.has_role(workspace_id, 'admin')
    and (role <> 'owner' or app.has_role(workspace_id, 'owner')))
  with check (
    app.has_role(workspace_id, 'admin')
    and (role <> 'owner' or app.has_role(workspace_id, 'owner')));
create policy members_delete on public.workspace_members for delete to authenticated
  using (
    user_id = (select auth.uid())  -- sair do workspace (guard_last_owner protege o último owner)
    or (app.has_role(workspace_id, 'admin') and (role <> 'owner' or app.has_role(workspace_id, 'owner'))));

-- leitura por membros
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (app.has_role(workspace_id, 'viewer'));
create policy usage_select on public.usage_records for select to authenticated
  using (app.has_role(workspace_id, 'viewer'));
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = (select auth.uid()) and app.has_role(workspace_id, 'viewer'));
create policy audit_select on public.audit_logs for select to authenticated
  using (app.has_role(workspace_id, 'admin'));
