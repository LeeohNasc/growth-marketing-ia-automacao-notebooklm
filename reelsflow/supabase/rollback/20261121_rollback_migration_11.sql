-- ReelsFlow · ROLLBACK da migration 11 (editorial_cards). NÃO é aplicado automaticamente.
-- Backup lógico feito antes da aplicação: schema rf_backup_20261121 (media_assets + meta).
-- Estado ANTES: media_assets_mime_type_check = video/mp4, video/quicktime;
--   bucket media = video/mp4, video/quicktime, image/jpeg; 14 vídeos do usuário preservados.
-- ATENÇÃO: remove cards e as mídias em IMAGEM (que só existem a partir desta migration).
-- Os arquivos dessas imagens no storage ficam órfãos e são limpos pelo job purge abaixo.

begin;
-- Imagens (renders de cards) não cabem no esquema anterior: agenda limpeza e remove registros.
insert into public.media_jobs (workspace_id, media_asset_id, kind, payload)
select workspace_id, null, 'purge', jsonb_build_object('paths', jsonb_agg(storage_path))
  from public.media_assets where mime_type like 'image/%' group by workspace_id;
update public.publication_jobs set status = 'cancelled'
 where media_asset_id in (select id from public.media_assets where mime_type like 'image/%')
   and status in ('draft', 'scheduled', 'queued', 'failed_retryable', 'failed_permanent', 'needs_review');
delete from public.publication_jobs where media_asset_id in (select id from public.media_assets where mime_type like 'image/%') and status = 'cancelled';
delete from public.campaign_media where media_asset_id in (select id from public.media_assets where mime_type like 'image/%');
delete from public.media_assets where mime_type like 'image/%';

drop trigger if exists media_assets_sync_card on public.media_assets;
drop function if exists app.sync_card_render_from_media();
drop function if exists public.delete_editorial_card(uuid);
drop function if exists public.duplicate_editorial_card(uuid);
drop function if exists public.attach_card_render(uuid, uuid);
drop function if exists public.set_card_render_state(uuid, text, text);
drop policy if exists media_card_sources_insert on storage.objects;
alter table public.media_assets drop column if exists source_card_id;
drop table if exists public.editorial_cards;
drop function if exists app.guard_editorial_card();
drop function if exists app.card_paths_ok(uuid, text[]);
drop type if exists public.card_render_status;
alter table public.media_assets drop column if exists kind;

alter table public.media_assets drop constraint if exists media_assets_mime_type_check;
alter table public.media_assets add constraint media_assets_mime_type_check check (mime_type in ('video/mp4', 'video/quicktime'));
update storage.buckets set allowed_mime_types = array['video/mp4', 'video/quicktime', 'image/jpeg'] where id = 'media';

-- begin_media_upload: restaura a definição EXATA guardada no backup (rf_backup_20261121.meta).
do $$
declare v_def text;
begin
  select value into v_def from rf_backup_20261121.meta where item = 'begin_media_upload';
  if v_def is null then
    raise exception 'backup rf_backup_20261121.meta sem begin_media_upload: rollback interrompido';
  end if;
  execute v_def;
end $$;
revoke all on function public.begin_media_upload(uuid, jsonb) from public, anon;
grant execute on function public.begin_media_upload(uuid, jsonb) to authenticated;

delete from supabase_migrations.schema_migrations where name = 'editorial_cards';
commit;
