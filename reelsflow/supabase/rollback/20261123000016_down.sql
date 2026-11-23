-- ROLLBACK da otimização do RLS: restaura as 52 políticas EXATAMENTE como eram (texto gerado do banco).
-- Não toca em dados. Pode ser executado com segurança a qualquer momento.


alter policy "audit_select" on public."audit_logs"
  using (app.has_role(workspace_id, 'admin'::workspace_role));

alter policy "automation_rules_select" on public."automation_rules"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "automation_runs_select" on public."automation_runs"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "campaign_media_delete" on public."campaign_media"
  using (app.has_role(workspace_id, 'editor'::workspace_role));

alter policy "campaign_media_select" on public."campaign_media"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "campaign_media_update" on public."campaign_media"
  using (app.has_role(workspace_id, 'editor'::workspace_role))
  with check (app.has_role(workspace_id, 'editor'::workspace_role));

alter policy "campaign_media_write" on public."campaign_media"
  with check (app.has_role(workspace_id, 'editor'::workspace_role));

alter policy "campaign_targets_delete" on public."campaign_targets"
  using (app.has_role(workspace_id, 'editor'::workspace_role));

alter policy "campaign_targets_select" on public."campaign_targets"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "campaign_targets_update" on public."campaign_targets"
  using (app.has_role(workspace_id, 'editor'::workspace_role))
  with check (app.has_role(workspace_id, 'editor'::workspace_role));

alter policy "campaign_targets_write" on public."campaign_targets"
  with check (app.has_role(workspace_id, 'editor'::workspace_role));

alter policy "campaigns_insert" on public."campaigns"
  with check ((app.has_role(workspace_id, 'editor'::workspace_role) AND (created_by = ( SELECT auth.uid() AS uid))));

alter policy "campaigns_select" on public."campaigns"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "campaigns_update" on public."campaigns"
  using ((app.has_role(workspace_id, 'editor'::workspace_role) AND (status = ANY (ARRAY['draft'::campaign_status, 'active'::campaign_status, 'paused'::campaign_status]))))
  with check (app.has_role(workspace_id, 'editor'::workspace_role));

alter policy "collection_items_delete" on public."collection_items"
  using (app.has_role(workspace_id, 'editor'::workspace_role));

alter policy "collection_items_insert" on public."collection_items"
  with check (app.has_role(workspace_id, 'editor'::workspace_role));

alter policy "collection_items_select" on public."collection_items"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "collections_delete" on public."collections"
  using (app.has_role(workspace_id, 'editor'::workspace_role));

alter policy "collections_insert" on public."collections"
  with check ((app.has_role(workspace_id, 'editor'::workspace_role) AND (created_by = ( SELECT auth.uid() AS uid))));

alter policy "collections_select" on public."collections"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "collections_update" on public."collections"
  using (app.has_role(workspace_id, 'editor'::workspace_role))
  with check (app.has_role(workspace_id, 'editor'::workspace_role));

alter policy "editorial_cards_insert" on public."editorial_cards"
  with check ((app.has_role(workspace_id, 'editor'::workspace_role) AND (created_by = ( SELECT auth.uid() AS uid)) AND (render_status = 'draft'::card_render_status) AND (rendered_media_id IS NULL)));

alter policy "editorial_cards_select" on public."editorial_cards"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "editorial_cards_update" on public."editorial_cards"
  using (app.has_role(workspace_id, 'editor'::workspace_role))
  with check (app.has_role(workspace_id, 'editor'::workspace_role));

alter policy "external_select" on public."external_publications"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "media_select" on public."media_assets"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "media_update" on public."media_assets"
  using ((app.has_role(workspace_id, 'editor'::workspace_role) AND (deleted_at IS NULL)))
  with check (app.has_role(workspace_id, 'editor'::workspace_role));

alter policy "notification_preferences_own" on public."notification_preferences"
  using (((user_id = ( SELECT auth.uid() AS uid)) AND app.has_role(workspace_id, 'viewer'::workspace_role)))
  with check (((user_id = ( SELECT auth.uid() AS uid)) AND app.has_role(workspace_id, 'viewer'::workspace_role)));

alter policy "notifications_select" on public."notifications"
  using (((user_id = ( SELECT auth.uid() AS uid)) AND app.has_role(workspace_id, 'viewer'::workspace_role)));

alter policy "attempts_select" on public."publication_attempts"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "jobs_select" on public."publication_jobs"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "templates_delete" on public."publication_templates"
  using (app.has_role(workspace_id, 'editor'::workspace_role));

alter policy "templates_insert" on public."publication_templates"
  with check ((app.has_role(workspace_id, 'editor'::workspace_role) AND (created_by = ( SELECT auth.uid() AS uid))));

alter policy "templates_select" on public."publication_templates"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "templates_update" on public."publication_templates"
  using (app.has_role(workspace_id, 'editor'::workspace_role))
  with check (app.has_role(workspace_id, 'editor'::workspace_role));

alter policy "capabilities_select" on public."social_account_capabilities"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "social_accounts_select" on public."social_accounts"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "social_accounts_update" on public."social_accounts"
  using (app.has_role(workspace_id, 'admin'::workspace_role))
  with check (app.has_role(workspace_id, 'admin'::workspace_role));

alter policy "subscriptions_select" on public."subscriptions"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "usage_select" on public."usage_records"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "invitations_select" on public."workspace_invitations"
  using (app.has_role(workspace_id, 'admin'::workspace_role));

alter policy "members_delete" on public."workspace_members"
  using (((user_id = ( SELECT auth.uid() AS uid)) OR (app.has_role(workspace_id, 'admin'::workspace_role) AND ((role <> 'owner'::workspace_role) OR app.has_role(workspace_id, 'owner'::workspace_role)))));

alter policy "members_insert" on public."workspace_members"
  with check ((app.has_role(workspace_id, 'admin'::workspace_role) AND ((role <> 'owner'::workspace_role) OR app.has_role(workspace_id, 'owner'::workspace_role))));

alter policy "members_select" on public."workspace_members"
  using (app.has_role(workspace_id, 'viewer'::workspace_role));

alter policy "members_update" on public."workspace_members"
  using ((app.has_role(workspace_id, 'admin'::workspace_role) AND ((role <> 'owner'::workspace_role) OR app.has_role(workspace_id, 'owner'::workspace_role))))
  with check ((app.has_role(workspace_id, 'admin'::workspace_role) AND ((role <> 'owner'::workspace_role) OR app.has_role(workspace_id, 'owner'::workspace_role))));

alter policy "workspaces_delete" on public."workspaces"
  using (app.has_role(id, 'owner'::workspace_role));

alter policy "workspaces_select" on public."workspaces"
  using (app.has_role(id, 'viewer'::workspace_role));

alter policy "workspaces_update" on public."workspaces"
  using (app.has_role(id, 'admin'::workspace_role))
  with check (app.has_role(id, 'admin'::workspace_role));

alter policy "media_card_sources_insert" on storage."objects"
  with check (((bucket_id = 'media'::text) AND (name ~ '^[0-9a-f-]{36}/cards/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,80}$'::text) AND app.has_role(app.try_uuid((storage.foldername(name))[1]), 'editor'::workspace_role) AND (EXISTS ( SELECT 1
   FROM editorial_cards c
  WHERE ((c.id = app.try_uuid((storage.foldername(objects.name))[3])) AND (c.workspace_id = app.try_uuid((storage.foldername(objects.name))[1])))))));

alter policy "media_objects_insert" on storage."objects"
  with check (((bucket_id = 'media'::text) AND app.has_role(app.try_uuid((storage.foldername(name))[1]), 'editor'::workspace_role) AND (EXISTS ( SELECT 1
   FROM media_assets m
  WHERE ((m.storage_path = objects.name) AND (m.status = 'uploading'::media_status) AND (m.workspace_id = app.try_uuid((storage.foldername(objects.name))[1])))))));

alter policy "media_objects_select" on storage."objects"
  using (((bucket_id = 'media'::text) AND app.has_role(app.try_uuid((storage.foldername(name))[1]), 'viewer'::workspace_role)));

alter policy "media_thumbnails_insert" on storage."objects"
  with check (((bucket_id = 'media'::text) AND (name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/thumb\.jpg$'::text) AND app.has_role(app.try_uuid((storage.foldername(name))[1]), 'editor'::workspace_role) AND (EXISTS ( SELECT 1
   FROM media_assets m
  WHERE ((m.id = app.try_uuid((storage.foldername(objects.name))[2])) AND (m.workspace_id = app.try_uuid((storage.foldername(objects.name))[1])) AND (m.deleted_at IS NULL) AND (m.thumbnail_path IS NULL))))));

drop function if exists app.member_workspace_ids(public.workspace_role);
drop table if exists app.rls_policy_backup_16;
