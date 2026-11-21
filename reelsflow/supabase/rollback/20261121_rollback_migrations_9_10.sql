-- ReelsFlow · ROLLBACK das migrations 9 (instagram_login) e 10 (zernio_accounts).
-- NÃO é aplicado automaticamente. Rodar só se for preciso desfazer a implantação de 2026-11-21.
--
-- Estado ANTES (capturado em produção em 2026-11-21, projeto mxeazufhstmdvpvhfjhw):
--   social_accounts: 0 linhas | social_account_tokens: 0 | social_account_capabilities: 0
--   oauth_states: 0 | external_publications: 0 | campaigns: 0 | publication_jobs: 0
--   oauth_states_provider_check            = CHECK ((provider = 'meta'::text))
--   social_account_tokens_token_type_check = CHECK ((token_type = ANY (ARRAY['page'::text, 'user'::text])))
--   social_accounts colunas: id, workspace_id, platform, external_account_id, display_name, avatar_url, status,
--     paused, min_spacing_minutes, settings, connected_by, token_expires_at, created_at, updated_at
--   social_account_tokens colunas: social_account_id, workspace_id, token_type, ciphertext, iv, auth_tag,
--     key_version, scopes, expires_at, meta_user_id, created_at, updated_at
--
-- ATENÇÃO: desvincula contas Zernio (apaga as linhas provider='zernio' e o que depende delas: campanhas
-- apontando para elas perdem o alvo) e tokens 'ig_user'. Confira antes com:
--   select id, display_name from public.social_accounts where provider = 'zernio';

begin;

-- 10 ------------------------------------------------------------------------
drop function if exists public.link_zernio_account(uuid, text, text, public.social_platform, text, text, text);
drop index if exists public.social_accounts_zernio_one_workspace;
delete from public.social_accounts where provider = 'zernio';
alter table public.social_accounts drop constraint if exists social_accounts_zernio_profile_required;
alter table public.social_accounts drop column if exists provider_profile_id;
alter table public.social_accounts drop column if exists provider;

-- 9 -------------------------------------------------------------------------
drop index if exists public.external_publications_account_idx;
drop function if exists public.connect_instagram_account(text, jsonb);
delete from public.social_account_tokens where token_type = 'ig_user';
drop index if exists public.social_account_tokens_expiry_idx;
alter table public.social_account_tokens drop column if exists last_refresh_error;
alter table public.social_account_tokens drop column if exists last_refresh_attempt_at;
alter table public.social_account_tokens drop column if exists issued_at;
alter table public.social_account_tokens drop constraint if exists social_account_tokens_token_type_check;
alter table public.social_account_tokens add constraint social_account_tokens_token_type_check check (token_type in ('page', 'user'));
delete from public.oauth_states where provider = 'instagram';
alter table public.oauth_states drop constraint if exists oauth_states_provider_check;
alter table public.oauth_states add constraint oauth_states_provider_check check (provider in ('meta'));

delete from supabase_migrations.schema_migrations where name in ('instagram_login', 'zernio_accounts');
commit;
