-- ReelsFlow · Instagram API with Instagram Login
-- Contas do Instagram passam a usar exclusivamente o Instagram Login (graph.instagram.com):
-- token de usuário do Instagram (60 dias, renovável), sem Página do Facebook.
-- O Facebook Login continua apenas para Páginas do Facebook.

-- 1. Estado OAuth do novo provedor.
alter table public.oauth_states drop constraint if exists oauth_states_provider_check;
alter table public.oauth_states add constraint oauth_states_provider_check check (provider in ('meta', 'instagram'));

-- 2. Tokens: tipo ig_user + controle de renovação.
alter table public.social_account_tokens drop constraint if exists social_account_tokens_token_type_check;
alter table public.social_account_tokens add constraint social_account_tokens_token_type_check check (token_type in ('page', 'user', 'ig_user'));
alter table public.social_account_tokens
  add column if not exists issued_at timestamptz not null default now(),
  add column if not exists last_refresh_attempt_at timestamptz,
  add column if not exists last_refresh_error text;
create index if not exists social_account_tokens_expiry_idx on public.social_account_tokens (expires_at) where token_type = 'ig_user';

-- 3. Conexão de UMA conta do Instagram (o Instagram Login autoriza uma conta por vez).
--    Valida o state (mesmo usuário, não expirado, não usado, admin) e grava a conta e o token
--    CIFRADO no servidor web (AAD "instagram:<user_id>"). O banco nunca vê o token em claro.
create or replace function public.connect_instagram_account(p_state text, p_account jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  s public.oauth_states;
  v_account uuid;
  v_ext text := p_account ->> 'user_id';
  v_scopes text[] := array(select jsonb_array_elements_text(coalesce(p_account -> 'granted', '[]'::jsonb)));
  v_cap text;
  v_slug text;
begin
  select * into s from public.oauth_states where state = p_state for update;
  if s.state is null or s.provider <> 'instagram' or s.user_id <> (select auth.uid()) or s.expires_at < now()
     or s.consumed_at is not null or s.callback_at is not null then
    raise exception 'invalid oauth state' using errcode = '42501';
  end if;
  if not app.has_role(s.workspace_id, 'admin') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if v_ext is null or v_ext !~ '^[0-9]{1,30}$' or coalesce(p_account ->> 'username', '') = '' then
    raise exception 'invalid instagram account' using errcode = '22023';
  end if;
  if p_account -> 'token' ->> 'ciphertext' is null or p_account -> 'token' ->> 'iv' is null or p_account -> 'token' ->> 'tag' is null then
    raise exception 'token required' using errcode = '22023';
  end if;

  insert into public.social_accounts (workspace_id, platform, external_account_id, display_name, avatar_url, status, connected_by, settings, token_expires_at)
  values (s.workspace_id, 'instagram', v_ext,
          left(coalesce(nullif(p_account ->> 'name', ''), '@' || (p_account ->> 'username')), 120),
          p_account ->> 'avatar_url', 'active', s.user_id,
          jsonb_build_object('auth', 'instagram_login', 'username', p_account ->> 'username', 'account_type', p_account ->> 'account_type'),
          (p_account ->> 'expires_at')::timestamptz)
  on conflict (workspace_id, platform, external_account_id) do update
    set display_name = excluded.display_name, avatar_url = excluded.avatar_url, status = 'active', connected_by = excluded.connected_by,
        settings = (public.social_accounts.settings - 'page_id' - 'meta_user_id') || excluded.settings,
        token_expires_at = excluded.token_expires_at
  returning id into v_account;

  insert into public.social_account_tokens (social_account_id, workspace_id, token_type, ciphertext, iv, auth_tag, key_version, scopes, expires_at, meta_user_id, issued_at)
  values (v_account, s.workspace_id, 'ig_user', p_account -> 'token' ->> 'ciphertext', p_account -> 'token' ->> 'iv', p_account -> 'token' ->> 'tag',
          (p_account -> 'token' ->> 'keyVersion')::integer, v_scopes, (p_account ->> 'expires_at')::timestamptz, v_ext, now())
  on conflict (social_account_id) do update
    set token_type = 'ig_user', ciphertext = excluded.ciphertext, iv = excluded.iv, auth_tag = excluded.auth_tag, key_version = excluded.key_version,
        scopes = excluded.scopes, expires_at = excluded.expires_at, meta_user_id = excluded.meta_user_id, issued_at = now(),
        last_refresh_attempt_at = null, last_refresh_error = null;

  -- Capacidades: as permissões efetivamente concedidas (o usuário pode desmarcar alguma).
  delete from public.social_account_capabilities where social_account_id = v_account;
  foreach v_cap in array array['instagram_business_basic', 'instagram_business_content_publish'] loop
    insert into public.social_account_capabilities (social_account_id, workspace_id, capability, granted)
    values (v_account, s.workspace_id, v_cap, v_cap = any (v_scopes));
  end loop;
  insert into public.social_account_capabilities (social_account_id, workspace_id, capability, granted, details)
  values (v_account, s.workspace_id, 'reels_publish', 'instagram_business_content_publish' = any (v_scopes),
          jsonb_build_object('account_type', p_account ->> 'account_type'));

  perform app.audit(s.workspace_id, 'account.connected', 'social_account', v_account::text,
    jsonb_build_object('platform', 'instagram', 'auth', 'instagram_login', 'username', p_account ->> 'username'));

  update public.oauth_states set callback_at = now(), consumed_at = now(), pending = null where state = p_state;
  select slug into v_slug from public.workspaces where id = s.workspace_id;
  return v_slug;
end $$;
revoke all on function public.connect_instagram_account(text, jsonb) from public, anon;
grant execute on function public.connect_instagram_account(text, jsonb) to authenticated;

-- 4. Histórico por conta: índice para filtrar publicações de uma conta.
create index if not exists external_publications_account_idx on public.external_publications (social_account_id, published_at desc);
