-- ReelsFlow · Contas publicadas pela Zernio (https://zernio.com).
-- Só acrescenta colunas/índices/função: nenhum dado existente é alterado.
--
-- Uma conta "zernio" é uma linha normal de social_accounts (platform = instagram, etc.), então
-- aparece nas campanhas, na fila, no calendário e no histórico como qualquer outra. Diferenças:
--   provider            = 'zernio' (worker usa o conector Zernio; não há token no ReelsFlow)
--   external_account_id = _id da conta na Zernio
--   provider_profile_id = _id do perfil Zernio que deve conter a conta (conferido antes de publicar)
-- Ambas as colunas novas NÃO são editáveis por clientes (o grant de UPDATE é por coluna).

alter table public.social_accounts
  add column if not exists provider text not null default 'native' check (provider in ('native', 'zernio')),
  add column if not exists provider_profile_id text check (provider_profile_id is null or provider_profile_id ~ '^[0-9a-f]{24}$');

alter table public.social_accounts drop constraint if exists social_accounts_zernio_profile_required;
alter table public.social_accounts add constraint social_accounts_zernio_profile_required
  check (provider <> 'zernio' or (provider_profile_id is not null and external_account_id ~ '^[0-9a-f]{24}$'));

-- Isolamento: uma conta da Zernio só pode estar ativa em UM workspace (senão dois tenants publicariam nela).
create unique index if not exists social_accounts_zernio_one_workspace
  on public.social_accounts (external_account_id) where provider = 'zernio' and status <> 'disconnected';

-- Vínculo de uma conta já conectada na Zernio a um workspace. SOMENTE service role/operador:
-- a chave da Zernio é única para o ReelsFlow, então um usuário comum não pode escolher IDs.
create or replace function public.link_zernio_account(
  p_workspace uuid,
  p_account_id text,
  p_profile_id text,
  p_platform public.social_platform,
  p_username text,
  p_display_name text,
  p_avatar_url text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_platform not in ('instagram', 'facebook', 'tiktok', 'youtube') then
    raise exception 'unsupported platform' using errcode = '22023';
  end if;
  if p_account_id !~ '^[0-9a-f]{24}$' or p_profile_id !~ '^[0-9a-f]{24}$' then
    raise exception 'invalid zernio id' using errcode = '22023';
  end if;
  if not exists (select 1 from public.workspaces where id = p_workspace) then
    raise exception 'workspace not found' using errcode = '22023';
  end if;

  insert into public.social_accounts (workspace_id, platform, external_account_id, display_name, avatar_url, status, provider, provider_profile_id, settings)
  values (p_workspace, p_platform, p_account_id, left(coalesce(nullif(trim(p_display_name), ''), '@' || p_username), 120), p_avatar_url, 'active',
          'zernio', p_profile_id, jsonb_build_object('username', nullif(trim(p_username), '')))
  on conflict (workspace_id, platform, external_account_id) do update
    set status = 'active', provider = 'zernio', provider_profile_id = excluded.provider_profile_id,
        display_name = excluded.display_name, avatar_url = coalesce(excluded.avatar_url, public.social_accounts.avatar_url),
        settings = public.social_accounts.settings || excluded.settings
  returning id into v_id;

  insert into public.social_account_capabilities (social_account_id, workspace_id, capability, granted, details)
  values (v_id, p_workspace, 'reels_publish', true, jsonb_build_object('provider', 'zernio'))
  on conflict (social_account_id, capability) do update set granted = true, details = excluded.details, checked_at = now();

  perform app.audit(p_workspace, 'account.connected', 'social_account', v_id::text,
    jsonb_build_object('platform', p_platform, 'provider', 'zernio', 'username', p_username));
  return v_id;
end $$;
revoke all on function public.link_zernio_account(uuid, text, text, public.social_platform, text, text, text) from public, anon, authenticated;
