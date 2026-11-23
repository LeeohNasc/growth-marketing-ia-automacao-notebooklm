-- ReelsFlow · Otimização do RLS (52 políticas em 24 tabelas). GERADO por scripts/gen-rls-migration.py.
--
-- Antes: app.has_role(workspace_id, papel) era avaliada UMA VEZ POR LINHA (função SECURITY DEFINER não é
-- "inlinável"), com uma busca em workspace_members a cada linha — custo linear no tamanho do workspace.
-- Agora: app.member_workspace_ids(papel) devolve os workspaces do usuário e é calculada UMA vez por consulta.
-- Semântica preservada: mesma regra de papel (role_rank >= mínimo), mesmo usuário (auth.uid()), e
-- COALESCE(..., false) reproduz o "false" de has_role quando o workspace é nulo. Demais condições de cada
-- política (deleted_at, created_by, status, caminhos de Storage...) ficam exatamente como estavam.
-- app.has_role continua existindo (usada por funções RPC); nenhuma tabela, dado ou permissão de coluna muda.
-- As definições ANTERIORES ficam guardadas em app.rls_policy_backup_16 (usadas pelo rollback e pelos testes).



create table if not exists app.rls_policy_backup_16 (
  schemaname text not null, tablename text not null, policyname text not null, cmd text not null,
  qual text, with_check text, saved_at timestamptz not null default now(),
  primary key (schemaname, tablename, policyname)
);
revoke all on app.rls_policy_backup_16 from public;
insert into app.rls_policy_backup_16 (schemaname, tablename, policyname, cmd, qual, with_check)
select schemaname, tablename, policyname, cmd, qual, with_check from pg_policies
 where qual ilike '%has_role(%' or with_check ilike '%has_role(%'
on conflict do nothing;

-- Workspaces em que o usuário atual tem pelo menos `min_role` (mesma regra de app.has_role).
create or replace function app.member_workspace_ids(min_role public.workspace_role)
returns setof uuid language sql stable security definer set search_path = '' as $$
  select m.workspace_id from public.workspace_members m
   where m.user_id = (select auth.uid()) and app.role_rank(m.role) >= app.role_rank(min_role)
$$;
revoke all on function app.member_workspace_ids(public.workspace_role) from public, anon;
grant execute on function app.member_workspace_ids(public.workspace_role) to authenticated;


-- public.audit_logs [SELECT]
alter policy "audit_select" on public."audit_logs"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('admin'::public.workspace_role)), false));

-- public.automation_rules [SELECT]
alter policy "automation_rules_select" on public."automation_rules"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.automation_runs [SELECT]
alter policy "automation_runs_select" on public."automation_runs"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.campaign_media [DELETE]
alter policy "campaign_media_delete" on public."campaign_media"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false));

-- public.campaign_media [SELECT]
alter policy "campaign_media_select" on public."campaign_media"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.campaign_media [UPDATE]
alter policy "campaign_media_update" on public."campaign_media"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false))
  with check (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false));

-- public.campaign_media [INSERT]
alter policy "campaign_media_write" on public."campaign_media"
  with check (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false));

-- public.campaign_targets [DELETE]
alter policy "campaign_targets_delete" on public."campaign_targets"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false));

-- public.campaign_targets [SELECT]
alter policy "campaign_targets_select" on public."campaign_targets"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.campaign_targets [UPDATE]
alter policy "campaign_targets_update" on public."campaign_targets"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false))
  with check (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false));

-- public.campaign_targets [INSERT]
alter policy "campaign_targets_write" on public."campaign_targets"
  with check (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false));

-- public.campaigns [INSERT]
alter policy "campaigns_insert" on public."campaigns"
  with check ((COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false) AND (created_by = ( SELECT auth.uid() AS uid))));

-- public.campaigns [SELECT]
alter policy "campaigns_select" on public."campaigns"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.campaigns [UPDATE]
alter policy "campaigns_update" on public."campaigns"
  using ((COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false) AND (status = ANY (ARRAY['draft'::campaign_status, 'active'::campaign_status, 'paused'::campaign_status]))))
  with check (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false));

-- public.collection_items [DELETE]
alter policy "collection_items_delete" on public."collection_items"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false));

-- public.collection_items [INSERT]
alter policy "collection_items_insert" on public."collection_items"
  with check (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false));

-- public.collection_items [SELECT]
alter policy "collection_items_select" on public."collection_items"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.collections [DELETE]
alter policy "collections_delete" on public."collections"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false));

-- public.collections [INSERT]
alter policy "collections_insert" on public."collections"
  with check ((COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false) AND (created_by = ( SELECT auth.uid() AS uid))));

-- public.collections [SELECT]
alter policy "collections_select" on public."collections"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.collections [UPDATE]
alter policy "collections_update" on public."collections"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false))
  with check (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false));

-- public.editorial_cards [INSERT]
alter policy "editorial_cards_insert" on public."editorial_cards"
  with check ((COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false) AND (created_by = ( SELECT auth.uid() AS uid)) AND (render_status = 'draft'::card_render_status) AND (rendered_media_id IS NULL)));

-- public.editorial_cards [SELECT]
alter policy "editorial_cards_select" on public."editorial_cards"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.editorial_cards [UPDATE]
alter policy "editorial_cards_update" on public."editorial_cards"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false))
  with check (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false));

-- public.external_publications [SELECT]
alter policy "external_select" on public."external_publications"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.media_assets [SELECT]
alter policy "media_select" on public."media_assets"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.media_assets [UPDATE]
alter policy "media_update" on public."media_assets"
  using ((COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false) AND (deleted_at IS NULL)))
  with check (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false));

-- public.notification_preferences [ALL]
alter policy "notification_preferences_own" on public."notification_preferences"
  using (((user_id = ( SELECT auth.uid() AS uid)) AND COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false)))
  with check (((user_id = ( SELECT auth.uid() AS uid)) AND COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false)));

-- public.notifications [SELECT]
alter policy "notifications_select" on public."notifications"
  using (((user_id = ( SELECT auth.uid() AS uid)) AND COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false)));

-- public.publication_attempts [SELECT]
alter policy "attempts_select" on public."publication_attempts"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.publication_jobs [SELECT]
alter policy "jobs_select" on public."publication_jobs"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.publication_templates [DELETE]
alter policy "templates_delete" on public."publication_templates"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false));

-- public.publication_templates [INSERT]
alter policy "templates_insert" on public."publication_templates"
  with check ((COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false) AND (created_by = ( SELECT auth.uid() AS uid))));

-- public.publication_templates [SELECT]
alter policy "templates_select" on public."publication_templates"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.publication_templates [UPDATE]
alter policy "templates_update" on public."publication_templates"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false))
  with check (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false));

-- public.social_account_capabilities [SELECT]
alter policy "capabilities_select" on public."social_account_capabilities"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.social_accounts [SELECT]
alter policy "social_accounts_select" on public."social_accounts"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.social_accounts [UPDATE]
alter policy "social_accounts_update" on public."social_accounts"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('admin'::public.workspace_role)), false))
  with check (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('admin'::public.workspace_role)), false));

-- public.subscriptions [SELECT]
alter policy "subscriptions_select" on public."subscriptions"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.usage_records [SELECT]
alter policy "usage_select" on public."usage_records"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.workspace_invitations [SELECT]
alter policy "invitations_select" on public."workspace_invitations"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('admin'::public.workspace_role)), false));

-- public.workspace_members [DELETE]
alter policy "members_delete" on public."workspace_members"
  using (((user_id = ( SELECT auth.uid() AS uid)) OR (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('admin'::public.workspace_role)), false) AND ((role <> 'owner'::workspace_role) OR COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('owner'::public.workspace_role)), false)))));

-- public.workspace_members [INSERT]
alter policy "members_insert" on public."workspace_members"
  with check ((COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('admin'::public.workspace_role)), false) AND ((role <> 'owner'::workspace_role) OR COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('owner'::public.workspace_role)), false))));

-- public.workspace_members [SELECT]
alter policy "members_select" on public."workspace_members"
  using (COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.workspace_members [UPDATE]
alter policy "members_update" on public."workspace_members"
  using ((COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('admin'::public.workspace_role)), false) AND ((role <> 'owner'::workspace_role) OR COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('owner'::public.workspace_role)), false))))
  with check ((COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('admin'::public.workspace_role)), false) AND ((role <> 'owner'::workspace_role) OR COALESCE((workspace_id) IN ( SELECT app.member_workspace_ids('owner'::public.workspace_role)), false))));

-- public.workspaces [DELETE]
alter policy "workspaces_delete" on public."workspaces"
  using (COALESCE((id) IN ( SELECT app.member_workspace_ids('owner'::public.workspace_role)), false));

-- public.workspaces [SELECT]
alter policy "workspaces_select" on public."workspaces"
  using (COALESCE((id) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false));

-- public.workspaces [UPDATE]
alter policy "workspaces_update" on public."workspaces"
  using (COALESCE((id) IN ( SELECT app.member_workspace_ids('admin'::public.workspace_role)), false))
  with check (COALESCE((id) IN ( SELECT app.member_workspace_ids('admin'::public.workspace_role)), false));

-- storage.objects [INSERT]
alter policy "media_card_sources_insert" on storage."objects"
  with check (((bucket_id = 'media'::text) AND (name ~ '^[0-9a-f-]{36}/cards/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,80}$'::text) AND COALESCE((app.try_uuid((storage.foldername(name))[1])) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false) AND (EXISTS ( SELECT 1
   FROM editorial_cards c
  WHERE ((c.id = app.try_uuid((storage.foldername(objects.name))[3])) AND (c.workspace_id = app.try_uuid((storage.foldername(objects.name))[1])))))));

-- storage.objects [INSERT]
alter policy "media_objects_insert" on storage."objects"
  with check (((bucket_id = 'media'::text) AND COALESCE((app.try_uuid((storage.foldername(name))[1])) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false) AND (EXISTS ( SELECT 1
   FROM media_assets m
  WHERE ((m.storage_path = objects.name) AND (m.status = 'uploading'::media_status) AND (m.workspace_id = app.try_uuid((storage.foldername(objects.name))[1])))))));

-- storage.objects [SELECT]
alter policy "media_objects_select" on storage."objects"
  using (((bucket_id = 'media'::text) AND COALESCE((app.try_uuid((storage.foldername(name))[1])) IN ( SELECT app.member_workspace_ids('viewer'::public.workspace_role)), false)));

-- storage.objects [INSERT]
alter policy "media_thumbnails_insert" on storage."objects"
  with check (((bucket_id = 'media'::text) AND (name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/thumb\.jpg$'::text) AND COALESCE((app.try_uuid((storage.foldername(name))[1])) IN ( SELECT app.member_workspace_ids('editor'::public.workspace_role)), false) AND (EXISTS ( SELECT 1
   FROM media_assets m
  WHERE ((m.id = app.try_uuid((storage.foldername(objects.name))[2])) AND (m.workspace_id = app.try_uuid((storage.foldername(objects.name))[1])) AND (m.deleted_at IS NULL) AND (m.thumbnail_path IS NULL))))));
