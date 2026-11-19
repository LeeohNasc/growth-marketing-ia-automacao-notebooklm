-- ReelsFlow · Fase 4 · Integração Meta (Instagram + Facebook via Facebook Login)
-- Tokens cifrados (AES-256-GCM na aplicação; o banco só guarda cifra),
-- estado OAuth de uso único, capacidades por conta, exclusão de dados (LGPD/Meta).

-- ---------------------------------------------------------------------------
-- social_account_tokens — sem NENHUM acesso de cliente
-- ---------------------------------------------------------------------------
create table public.social_account_tokens (
  social_account_id uuid primary key references public.social_accounts (id) on delete cascade,
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  token_type        text not null check (token_type in ('page', 'user')),
  ciphertext        text not null,
  iv                text not null,
  auth_tag          text not null,
  key_version       integer not null,
  scopes            text[] not null default '{}',
  expires_at        timestamptz,
  meta_user_id      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index social_account_tokens_meta_user_idx on public.social_account_tokens (meta_user_id);
create trigger social_account_tokens_updated_at before update on public.social_account_tokens
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- social_account_capabilities — leitura por membros
-- ---------------------------------------------------------------------------
create table public.social_account_capabilities (
  social_account_id uuid not null references public.social_accounts (id) on delete cascade,
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  capability        text not null,
  granted           boolean not null,
  details           jsonb not null default '{}'::jsonb,
  checked_at        timestamptz not null default now(),
  primary key (social_account_id, capability)
);

-- ---------------------------------------------------------------------------
-- oauth_states — CSRF + sessão de conexão, uso único, expira em 15 min
-- ---------------------------------------------------------------------------
create table public.oauth_states (
  state        text primary key,
  provider     text not null check (provider in ('meta')),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '15 minutes'),
  callback_at  timestamptz,
  consumed_at  timestamptz,
  -- Candidatos retornados pela Meta. Tokens dentro daqui estão CIFRADOS.
  pending      jsonb
);
create index oauth_states_expiry_idx on public.oauth_states (expires_at);

-- ---------------------------------------------------------------------------
-- data_deletion_requests — callback de exclusão de dados da Meta
-- ---------------------------------------------------------------------------
create table public.data_deletion_requests (
  confirmation_code text primary key,
  provider          text not null default 'meta',
  external_user_id  text not null,
  status            text not null default 'completed' check (status in ('received', 'completed')),
  accounts_removed  integer not null default 0,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz
);

alter table public.social_account_tokens       enable row level security;
alter table public.social_account_capabilities enable row level security;
alter table public.oauth_states                enable row level security;
alter table public.data_deletion_requests      enable row level security;
revoke all on public.social_account_tokens, public.social_account_capabilities, public.oauth_states, public.data_deletion_requests
  from anon, authenticated;
grant select on public.social_account_capabilities to authenticated;
create policy capabilities_select on public.social_account_capabilities for select to authenticated
  using (app.has_role(workspace_id, 'viewer'));
-- social_account_tokens, oauth_states, data_deletion_requests: somente via funções abaixo / service role.

-- ---------------------------------------------------------------------------
-- RPCs do fluxo OAuth (chamadas pelo servidor web, como o usuário)
-- ---------------------------------------------------------------------------

-- 1) Início: somente admin; gera state aleatório amarrado a usuário + workspace.
create or replace function public.begin_oauth(p_workspace uuid, p_provider text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_state text;
begin
  if not app.has_role(p_workspace, 'admin') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  v_state := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.oauth_states (state, provider, workspace_id, user_id) values (v_state, p_provider, p_workspace, (select auth.uid()));
  delete from public.oauth_states where expires_at < now() - interval '1 day';
  return v_state;
end $$;

-- 1b) Verificação prévia no callback (antes de usar o code com a Meta).
create or replace function public.check_oauth_state(p_state text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.oauth_states s
                  where s.state = p_state and s.user_id = (select auth.uid()) and s.expires_at > now()
                    and s.consumed_at is null and s.callback_at is null)
$$;

-- 2) Callback: valida state (mesmo usuário, não expirado, não usado) e guarda candidatos (tokens já cifrados).
create or replace function public.complete_oauth(p_state text, p_pending jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare s public.oauth_states; v_slug text;
begin
  select * into s from public.oauth_states where state = p_state for update;
  if s.state is null or s.user_id <> (select auth.uid()) or s.expires_at < now() or s.consumed_at is not null or s.callback_at is not null then
    raise exception 'invalid oauth state' using errcode = '42501';
  end if;
  if not app.has_role(s.workspace_id, 'admin') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  update public.oauth_states set callback_at = now(), pending = p_pending where state = p_state;
  select slug into v_slug from public.workspaces where id = s.workspace_id;
  return v_slug;
end $$;

-- 3) Tela de seleção: candidatos SEM tokens.
create or replace function public.get_oauth_pending(p_state text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.oauth_states;
begin
  select * into s from public.oauth_states where state = p_state;
  if s.state is null or s.user_id <> (select auth.uid()) or s.expires_at < now() or s.consumed_at is not null or s.pending is null then
    raise exception 'invalid oauth state' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'workspace_id', s.workspace_id,
    'user_name', s.pending -> 'user_name',
    'granted', s.pending -> 'granted',
    'candidates', coalesce((
      select jsonb_agg(c - 'page_token' - 'user_token') from jsonb_array_elements(s.pending -> 'candidates') c), '[]'::jsonb));
end $$;

-- 4) Confirmação: cria/atualiza contas escolhidas e grava tokens cifrados. Uso único.
--    A cifra foi feita no servidor com contexto (AAD) "<platform>:<external_id>": não pode
--    ser reaproveitada em outra conta. O banco nunca vê o token em claro.
create or replace function public.finalize_oauth(p_state text, p_keys text[])
returns integer language plpgsql security definer set search_path = '' as $$
declare
  s public.oauth_states;
  c jsonb;
  v_account uuid;
  v_scopes text[];
  v_n integer := 0;
  v_cap text;
  v_required text[];
begin
  select * into s from public.oauth_states where state = p_state for update;
  if s.state is null or s.user_id <> (select auth.uid()) or s.expires_at < now() or s.consumed_at is not null or s.pending is null then
    raise exception 'invalid oauth state' using errcode = '42501';
  end if;
  if not app.has_role(s.workspace_id, 'admin') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  v_scopes := array(select jsonb_array_elements_text(coalesce(s.pending -> 'granted', '[]'::jsonb)));

  for c in select * from jsonb_array_elements(s.pending -> 'candidates') loop
    continue when not ((c ->> 'key') = any (p_keys));
    insert into public.social_accounts (workspace_id, platform, external_account_id, display_name, avatar_url, status, connected_by, settings, token_expires_at)
    values (s.workspace_id, (c ->> 'platform')::public.social_platform, c ->> 'external_id', left(c ->> 'name', 120), c ->> 'avatar_url', 'active',
            s.user_id, jsonb_build_object('page_id', c ->> 'page_id', 'meta_user_id', s.pending ->> 'meta_user_id'), null)
    on conflict (workspace_id, platform, external_account_id) do update
      set display_name = excluded.display_name, avatar_url = excluded.avatar_url, status = 'active', connected_by = excluded.connected_by,
          settings = public.social_accounts.settings || excluded.settings
    returning id into v_account;

    insert into public.social_account_tokens (social_account_id, workspace_id, token_type, ciphertext, iv, auth_tag, key_version, scopes, expires_at, meta_user_id)
    values (v_account, s.workspace_id, 'page', c -> 'page_token' ->> 'ciphertext', c -> 'page_token' ->> 'iv', c -> 'page_token' ->> 'tag',
            (c -> 'page_token' ->> 'keyVersion')::integer, v_scopes, null, s.pending ->> 'meta_user_id')
    on conflict (social_account_id) do update
      set ciphertext = excluded.ciphertext, iv = excluded.iv, auth_tag = excluded.auth_tag, key_version = excluded.key_version,
          scopes = excluded.scopes, expires_at = excluded.expires_at, meta_user_id = excluded.meta_user_id;

    v_required := case c ->> 'platform'
      when 'instagram' then array['instagram_basic', 'instagram_content_publish', 'pages_read_engagement']
      else array['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'] end;
    foreach v_cap in array v_required loop
      insert into public.social_account_capabilities (social_account_id, workspace_id, capability, granted)
      values (v_account, s.workspace_id, v_cap, v_cap = any (v_scopes))
      on conflict (social_account_id, capability) do update set granted = excluded.granted, checked_at = now();
    end loop;
    insert into public.social_account_capabilities (social_account_id, workspace_id, capability, granted, details)
    values (v_account, s.workspace_id, 'reels_publish', coalesce((c ->> 'can_publish')::boolean, false),
            jsonb_build_object('missing_scopes', c -> 'missing_scopes'))
    on conflict (social_account_id, capability) do update set granted = excluded.granted, details = excluded.details, checked_at = now();

    perform app.audit(s.workspace_id, 'account.connected', 'social_account', v_account::text,
      jsonb_build_object('platform', c ->> 'platform', 'name', c ->> 'name'));
    v_n := v_n + 1;
  end loop;

  update public.oauth_states set consumed_at = now(), pending = null where state = p_state;
  return v_n;
end $$;

-- Remove credenciais de uma conta (desconectar sem apagar histórico).
create or replace function public.disconnect_social_account(p_account uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.social_accounts;
begin
  select * into a from public.social_accounts where id = p_account;
  if a.id is null or not app.has_role(a.workspace_id, 'admin') then
    raise exception 'not found' using errcode = '42501';
  end if;
  delete from public.social_account_tokens where social_account_id = a.id;
  update public.social_accounts set status = 'disconnected' where id = a.id;
  perform app.audit(a.workspace_id, 'account.disconnected', 'social_account', a.id::text, '{}'::jsonb);
end $$;

-- Exclusão de dados solicitada pela Meta (assinatura validada no servidor).
-- Somente service role: não pode ser chamada por usuários.
create or replace function public.meta_data_deletion(p_meta_user_id text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_code text; v_n integer := 0; r record;
begin
  v_code := encode(extensions.gen_random_bytes(12), 'hex');
  for r in select distinct t.social_account_id from public.social_account_tokens t where t.meta_user_id = p_meta_user_id loop
    update public.publication_jobs set status = 'cancelled'
     where social_account_id = r.social_account_id and status in ('draft', 'scheduled', 'queued', 'failed_retryable', 'failed_permanent', 'needs_review');
    delete from public.social_account_tokens where social_account_id = r.social_account_id;
    update public.social_accounts set status = 'disconnected', display_name = 'Conta removida a pedido do titular', avatar_url = null,
           settings = settings - 'meta_user_id'
     where id = r.social_account_id;
    v_n := v_n + 1;
  end loop;
  delete from public.oauth_states where pending ->> 'meta_user_id' = p_meta_user_id;
  insert into public.data_deletion_requests (confirmation_code, external_user_id, status, accounts_removed, completed_at)
  values (v_code, encode(extensions.digest(p_meta_user_id, 'sha256'), 'hex'), 'completed', v_n, now());
  return v_code;
end $$;

-- Status público por código (código aleatório de 96 bits; nenhum dado pessoal retornado).
create or replace function public.data_deletion_status(p_code text)
returns table (status text, accounts_removed integer, created_at timestamptz, completed_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select d.status, d.accounts_removed, d.created_at, d.completed_at from public.data_deletion_requests d where d.confirmation_code = p_code
$$;

revoke all on function public.meta_data_deletion(text) from public, anon, authenticated;
grant execute on function public.meta_data_deletion(text) to service_role;
revoke all on function public.data_deletion_status(text) from public;
grant execute on function public.data_deletion_status(text) to anon, authenticated;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.begin_oauth(uuid, text)', 'public.check_oauth_state(text)', 'public.complete_oauth(text, jsonb)', 'public.get_oauth_pending(text)',
    'public.finalize_oauth(text, text[])', 'public.disconnect_social_account(uuid)'] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;
