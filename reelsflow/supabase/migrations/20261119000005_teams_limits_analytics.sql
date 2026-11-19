-- ReelsFlow · Fase 5 (escopo reduzido) · Equipes, limites de plano, analytics interno
-- Sem cobrança real. Limites são PROVISÓRIOS (o prompt deixa valores definitivos
-- para depois) e podem ser sobrescritos por workspace em subscriptions.limits.

-- ---------------------------------------------------------------------------
-- Limites por plano
-- ---------------------------------------------------------------------------
create or replace function app.plan_defaults(p_plan text)
returns jsonb language sql immutable as $$
  select case p_plan
    when 'agency' then '{"seats": 20, "accounts_per_platform": 50, "videos": 20000, "storage_bytes": 1099511627776}'::jsonb
    when 'pro'    then '{"seats": 3,  "accounts_per_platform": 5,  "videos": 2000,  "storage_bytes": 107374182400}'::jsonb
    else               '{"seats": 1,  "accounts_per_platform": 1,  "videos": 200,   "storage_bytes": 10737418240}'::jsonb
  end
$$;

-- Limites efetivos: padrão do plano + sobrescritas do workspace.
create or replace function app.workspace_limits(ws uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select app.plan_defaults(coalesce(s.plan, 'starter')) || coalesce(s.limits, '{}'::jsonb)
    from (select 1) one
    left join public.subscriptions s on s.workspace_id = ws
$$;

create or replace function app.limit_error(p_what text)
returns void language plpgsql as $$
begin
  raise exception 'plan limit: %', p_what using errcode = 'P0001';
end $$;

-- Uso atual (contagens reais) e limites, para a tela de assinatura.
create or replace function public.workspace_usage(p_workspace uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  if not app.has_role(p_workspace, 'viewer') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'limits', app.workspace_limits(p_workspace),
    'seats', (select count(*) from public.workspace_members m where m.workspace_id = p_workspace)
             + (select count(*) from public.workspace_invitations i where i.workspace_id = p_workspace and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()),
    'videos', (select count(*) from public.media_assets a where a.workspace_id = p_workspace and a.deleted_at is null),
    'storage_bytes', (select coalesce(sum(a.size_bytes), 0) from public.media_assets a where a.workspace_id = p_workspace),
    'accounts_by_platform', coalesce((select jsonb_object_agg(platform, n) from (
        select platform::text, count(*) as n from public.social_accounts sa
         where sa.workspace_id = p_workspace and sa.platform <> 'mock' and sa.status <> 'disconnected' group by platform) x), '{}'::jsonb)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Convites de equipe
-- ---------------------------------------------------------------------------
create table public.workspace_invitations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email        text not null check (email = lower(trim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role         public.workspace_role not null,
  token_hash   text not null unique,
  invited_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '7 days'),
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users (id) on delete set null,
  revoked_at   timestamptz
);
create unique index workspace_invitations_pending_uq on public.workspace_invitations (workspace_id, email)
  where accepted_at is null and revoked_at is null;

alter table public.workspace_invitations enable row level security;
revoke all on public.workspace_invitations from anon, authenticated;
-- Admins veem convites (sem o hash do token).
grant select (id, workspace_id, email, role, invited_by, created_at, expires_at, accepted_at, revoked_at) on public.workspace_invitations to authenticated;
create policy invitations_select on public.workspace_invitations for select to authenticated
  using (app.has_role(workspace_id, 'admin'));

-- Cria convite e retorna o token em claro UMA vez (o banco guarda só o hash).
create or replace function public.create_invitation(p_workspace uuid, p_email text, p_role public.workspace_role)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_token text;
  v_email text := lower(trim(p_email));
  v_used integer;
begin
  if not app.has_role(p_workspace, 'admin') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if p_role = 'owner' and not app.has_role(p_workspace, 'owner') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if exists (select 1 from public.workspace_members m join auth.users u on u.id = m.user_id
              where m.workspace_id = p_workspace and lower(u.email) = v_email) then
    raise exception 'already a member' using errcode = 'P0001';
  end if;
  update public.workspace_invitations set revoked_at = now()
   where workspace_id = p_workspace and email = v_email and accepted_at is null and revoked_at is null;
  select (public.workspace_usage(p_workspace) ->> 'seats')::integer into v_used;
  if v_used + 1 > (app.workspace_limits(p_workspace) ->> 'seats')::integer then
    perform app.limit_error('seats');
  end if;
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.workspace_invitations (workspace_id, email, role, token_hash, invited_by)
  values (p_workspace, v_email, p_role, encode(extensions.digest(v_token, 'sha256'), 'hex'), (select auth.uid()));
  perform app.audit(p_workspace, 'invitation.created', 'workspace_invitation', v_email, jsonb_build_object('role', p_role));
  return v_token;
end $$;

-- Aceite: o e-mail confirmado do usuário precisa ser o convidado. Retorna o slug.
create or replace function public.accept_invitation(p_token text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  i public.workspace_invitations;
  v_email text;
  v_slug text;
begin
  select * into i from public.workspace_invitations
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') for update;
  if i.id is null or i.revoked_at is not null or i.accepted_at is not null or i.expires_at < now() then
    raise exception 'invalid invitation' using errcode = 'P0002';
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = (select auth.uid()) and u.email_confirmed_at is not null;
  if v_email is null or v_email <> i.email then
    raise exception 'invitation is for another email' using errcode = '42501';
  end if;
  insert into public.workspace_members (workspace_id, user_id, role) values (i.workspace_id, (select auth.uid()), i.role)
  on conflict (workspace_id, user_id) do nothing;
  update public.workspace_invitations set accepted_at = now(), accepted_by = (select auth.uid()) where id = i.id;
  perform app.audit(i.workspace_id, 'invitation.accepted', 'workspace_invitation', i.email, jsonb_build_object('role', i.role));
  select slug into v_slug from public.workspaces where id = i.workspace_id;
  return v_slug;
end $$;

-- Pré-visualização do convite (sem login exigir associação): nome do workspace e papel.
create or replace function public.invitation_preview(p_token text)
returns table (workspace_name text, role public.workspace_role, email text, valid boolean)
language sql stable security definer set search_path = '' as $$
  select w.name, i.role, i.email, (i.accepted_at is null and i.revoked_at is null and i.expires_at > now())
    from public.workspace_invitations i join public.workspaces w on w.id = i.workspace_id
   where i.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

create or replace function public.revoke_invitation(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare i public.workspace_invitations;
begin
  select * into i from public.workspace_invitations where id = p_id for update;
  if i.id is null or not app.has_role(i.workspace_id, 'admin') then
    raise exception 'not found' using errcode = '42501';
  end if;
  update public.workspace_invitations set revoked_at = now() where id = p_id and accepted_at is null;
  perform app.audit(i.workspace_id, 'invitation.revoked', 'workspace_invitation', i.email, '{}'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- Aplicação dos limites nos pontos de entrada
-- ---------------------------------------------------------------------------

-- Vídeos e armazenamento: verificados ao registrar o upload.
create or replace function app.enforce_media_limits()
returns trigger language plpgsql security definer set search_path = '' as $$
declare l jsonb; v_count bigint; v_bytes bigint;
begin
  l := app.workspace_limits(new.workspace_id);
  select count(*), coalesce(sum(size_bytes), 0) into v_count, v_bytes
    from public.media_assets where workspace_id = new.workspace_id and deleted_at is null;
  if v_count + 1 > (l ->> 'videos')::bigint then perform app.limit_error('videos'); end if;
  if v_bytes + new.size_bytes > (l ->> 'storage_bytes')::bigint then perform app.limit_error('storage_bytes'); end if;
  return new;
end $$;
create trigger media_assets_enforce_limits before insert on public.media_assets
  for each row execute function app.enforce_media_limits();

-- Contas reais por rede (contas simuladas não contam).
create or replace function app.enforce_account_limits()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_count bigint;
begin
  if new.platform = 'mock' then return new; end if;
  if tg_op = 'UPDATE' and old.status <> 'disconnected' then return new; end if;
  if new.status = 'disconnected' then return new; end if;
  select count(*) into v_count from public.social_accounts
   where workspace_id = new.workspace_id and platform = new.platform and status <> 'disconnected' and id <> new.id
     -- Reconexão (INSERT … ON CONFLICT): o BEFORE INSERT roda antes do conflito; não contar a própria conta.
     and external_account_id <> new.external_account_id;
  if v_count + 1 > (app.workspace_limits(new.workspace_id) ->> 'accounts_per_platform')::bigint then
    perform app.limit_error('accounts_per_platform');
  end if;
  return new;
end $$;
create trigger social_accounts_enforce_limits before insert or update of status on public.social_accounts
  for each row execute function app.enforce_account_limits();

-- ---------------------------------------------------------------------------
-- Analytics interno (somente dados próprios do ReelsFlow; métricas das redes
-- exigem permissões de insights + App Review e não estão disponíveis).
-- ---------------------------------------------------------------------------
create or replace function public.publication_analytics(p_workspace uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; v_tz text;
begin
  if not app.has_role(p_workspace, 'viewer') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if p_to <= p_from or p_to - p_from > interval '366 days' then
    raise exception 'invalid range' using errcode = '22023';
  end if;
  select default_timezone into v_tz from public.workspaces where id = p_workspace;

  with j as (
    select * from public.publication_jobs
     where workspace_id = p_workspace and scheduled_at >= p_from and scheduled_at < p_to and status <> 'cancelled'
  ), done as (
    select * from j where status in ('published', 'failed_permanent')
  )
  select jsonb_build_object(
    'timezone', v_tz,
    'totals', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status::text, count(*) as n from j group by status) s),
    'published', (select count(*) from done where status = 'published'),
    'failed', (select count(*) from done where status = 'failed_permanent'),
    -- atraso = publicado − previsto (segundos); null quando não houve publicação
    'delay_p50_s', (select percentile_cont(0.5) within group (order by extract(epoch from published_at - scheduled_at)) from j where status = 'published' and published_at is not null),
    'delay_p95_s', (select percentile_cont(0.95) within group (order by extract(epoch from published_at - scheduled_at)) from j where status = 'published' and published_at is not null),
    'first_attempt_rate', (select case when count(*) = 0 then null else round(count(*) filter (where attempt_count <= 1)::numeric / count(*), 4) end from j where status = 'published'),
    'reconciled', (select count(*) from public.external_publications e join j on j.id = e.job_id where e.source = 'reconciled'),
    'by_day', (select coalesce(jsonb_agg(d order by d ->> 'day'), '[]'::jsonb) from (
        select jsonb_build_object('day', (scheduled_at at time zone v_tz)::date,
                                  'published', count(*) filter (where status = 'published'),
                                  'failed', count(*) filter (where status = 'failed_permanent'),
                                  'other', count(*) filter (where status not in ('published', 'failed_permanent'))) as d
          from j group by (scheduled_at at time zone v_tz)::date) days),
    'by_account', (select coalesce(jsonb_agg(a order by (a ->> 'published')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('account', coalesce(sa.display_name, 'Conta removida'), 'platform', sa.platform,
                                  'published', count(*) filter (where j.status = 'published'),
                                  'failed', count(*) filter (where j.status = 'failed_permanent'),
                                  'total', count(*)) as a
          from j left join public.social_accounts sa on sa.id = j.social_account_id
         group by sa.display_name, sa.platform) accs),
    'failure_reasons', (select coalesce(jsonb_agg(f order by (f ->> 'n')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('reason', coalesce(last_error_class, 'desconhecido'), 'n', count(*)) as f
          from j where status = 'failed_permanent' group by last_error_class) fr)
  ) into v;
  return v;
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.workspace_usage(uuid)', 'public.create_invitation(uuid, text, public.workspace_role)', 'public.accept_invitation(text)',
    'public.revoke_invitation(uuid)', 'public.publication_analytics(uuid, timestamptz, timestamptz)'] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
  revoke all on function public.invitation_preview(text) from public;
  grant execute on function public.invitation_preview(text) to anon, authenticated;
end $$;
