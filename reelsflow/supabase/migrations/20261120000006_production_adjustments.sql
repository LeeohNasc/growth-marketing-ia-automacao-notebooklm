-- ReelsFlow · Ajustes para o deploy (Supabase real + Edge Functions)
-- 1. search_path fixo em todas as funções auxiliares (aviso do Security Advisor).
-- 2. WebM removido: a análise no Edge Function lê MP4/MOV; Instagram/Facebook só aceitam MP4/MOV.
-- 3. Miniatura gerada no navegador: o editor pode gravar {ws}/{media}/thumb.jpg do próprio vídeo.
-- 4. Extensões para o agendador do worker (pg_cron + pg_net). O job é criado fora do
--    controle de versão porque usa um segredo (guardado no Vault).

-- 1 ---------------------------------------------------------------------------
alter function app.edit_freeze() set search_path = '';
alter function app.validate_schedule_fields() set search_path = '';
alter function app.try_uuid(text) set search_path = '';
alter function app.guard_media_status() set search_path = '';
alter function app.assert_timezone(text) set search_path = '';
alter function app.validate_profile() set search_path = '';
alter function app.role_rank(public.workspace_role) set search_path = '';
alter function app.set_updated_at() set search_path = '';
alter function app.validate_workspace() set search_path = '';
alter function app.job_transition_allowed(public.job_status, public.job_status) set search_path = '';
alter function app.guard_job_transition() set search_path = '';
alter function app.plan_defaults(text) set search_path = '';
alter function app.limit_error(text) set search_path = '';

-- 2 ---------------------------------------------------------------------------
alter table public.media_assets drop constraint if exists media_assets_mime_type_check;
alter table public.media_assets add constraint media_assets_mime_type_check
  check (mime_type in ('video/mp4', 'video/quicktime'));
update storage.buckets set allowed_mime_types = array['video/mp4', 'video/quicktime', 'image/jpeg'] where id = 'media';

create or replace function public.begin_media_upload(p_workspace uuid, p_files jsonb)
returns table (media_id uuid, storage_path text, original_filename text)
language plpgsql security definer set search_path = '' as $$
declare
  f jsonb;
  v_id uuid;
  v_path text;
  v_ext text;
  v_mime text;
  v_size bigint;
  v_name text;
  v_max bigint;
begin
  if not app.has_role(p_workspace, 'editor') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) = 0 or jsonb_array_length(p_files) > 200 then
    raise exception 'between 1 and 200 files per call' using errcode = '22023';
  end if;
  v_max := app.max_upload_bytes(p_workspace);

  for f in select * from jsonb_array_elements(p_files) loop
    v_mime := f ->> 'mime';
    v_size := (f ->> 'size')::bigint;
    v_name := left(trim(coalesce(f ->> 'name', '')), 255);
    v_ext := case v_mime when 'video/mp4' then 'mp4' when 'video/quicktime' then 'mov' end;
    if v_ext is null then
      raise exception 'unsupported mime type: %', v_mime using errcode = '22023';
    end if;
    if v_size is null or v_size <= 0 or v_size > v_max then
      raise exception 'file size out of range: %', v_name using errcode = '22023';
    end if;
    if v_name = '' then
      raise exception 'file name required' using errcode = '22023';
    end if;

    v_id := gen_random_uuid();
    v_path := p_workspace::text || '/' || v_id::text || '/original.' || v_ext;
    insert into public.media_assets (id, workspace_id, uploaded_by, name, original_filename, storage_path, mime_type, size_bytes, sha256)
    values (v_id, p_workspace, (select auth.uid()),
            left(regexp_replace(v_name, '\.[A-Za-z0-9]{1,5}$', ''), 200),
            v_name, v_path, v_mime, v_size, lower(f ->> 'sha256'));

    media_id := v_id; storage_path := v_path; original_filename := v_name;
    return next;
  end loop;
end $$;
revoke all on function public.begin_media_upload(uuid, jsonb) from public, anon;
grant execute on function public.begin_media_upload(uuid, jsonb) to authenticated;

-- 3 ---------------------------------------------------------------------------
-- Miniatura JPEG ao lado do original, só para vídeo do próprio workspace ainda sem miniatura.
create policy media_thumbnails_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and storage.objects.name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/thumb\.jpg$'
    and app.has_role(app.try_uuid((storage.foldername(name))[1]), 'editor')
    and exists (
      select 1 from public.media_assets m
       where m.id = app.try_uuid((storage.foldername(storage.objects.name))[2])
         and m.workspace_id = app.try_uuid((storage.foldername(storage.objects.name))[1])
         and m.deleted_at is null
         and m.thumbnail_path is null));

-- 4 ---------------------------------------------------------------------------
-- Condicional: o Postgres local de testes não tem pg_cron/pg_net (o Supabase tem).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
end $$;
