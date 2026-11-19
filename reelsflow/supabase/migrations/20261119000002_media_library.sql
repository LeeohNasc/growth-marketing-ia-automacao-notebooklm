-- ReelsFlow · Fase 2 · Biblioteca de mídia
-- media_assets (inclui o estado de upload — substitui a tabela upload_sessions
-- prevista no DATABASE.md: uma linha por vídeo desde o início do envio),
-- collections, collection_items, media_jobs (fila técnica do worker),
-- bucket privado `media` e policies de storage.

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function app.try_uuid(v text)
returns uuid language plpgsql immutable as $$
begin
  return v::uuid;
exception when others then
  return null;
end $$;

-- Limite de bytes por arquivo. Vem de subscriptions.limits.max_upload_bytes
-- quando definido; senão, 50 MB (limite por arquivo do plano Free do
-- Supabase, que hospeda o storage nesta fase).
create or replace function app.max_upload_bytes(ws uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce((select (s.limits ->> 'max_upload_bytes')::bigint from public.subscriptions s where s.workspace_id = ws),
                  52428800)
$$;

-- ---------------------------------------------------------------------------
-- media_assets
-- ---------------------------------------------------------------------------
create type public.media_status as enum ('uploading', 'uploaded', 'processing', 'ready', 'failed');

create table public.media_assets (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  uploaded_by       uuid references auth.users (id) on delete set null,
  name              text not null check (char_length(trim(name)) between 1 and 200),
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  storage_path      text not null unique,
  mime_type         text not null check (mime_type in ('video/mp4', 'video/quicktime', 'video/webm')),
  size_bytes        bigint not null check (size_bytes > 0),
  sha256            text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status            public.media_status not null default 'uploading',
  failure_reason    text,
  -- metadados extraídos pelo worker (ffprobe)
  duration_ms       integer check (duration_ms >= 0),
  width             integer check (width > 0),
  height            integer check (height > 0),
  rotation          integer,
  fps               numeric(7, 3),
  video_codec       text,
  audio_codec       text,
  has_audio         boolean,
  bitrate           bigint,
  container         text,
  thumbnail_path    text,
  compatibility     jsonb not null default '{}'::jsonb,
  probed_at         timestamptz,
  -- conteúdo padrão (editável)
  default_caption   text check (char_length(default_caption) <= 2200),
  default_hashtags  text[] not null default '{}' check (cardinality(default_hashtags) <= 30),
  upload_expires_at timestamptz default (now() + interval '24 hours'),
  deleted_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index media_ws_created_idx on public.media_assets (workspace_id, created_at desc) where deleted_at is null;
create index media_ws_status_idx on public.media_assets (workspace_id, status) where deleted_at is null;
create index media_ws_sha_idx on public.media_assets (workspace_id, sha256) where deleted_at is null;
create index media_name_trgm_idx on public.media_assets using gin (name extensions.gin_trgm_ops);
create index media_uploading_expiry_idx on public.media_assets (upload_expires_at) where status = 'uploading';

create trigger media_assets_updated_at before update on public.media_assets
  for each row execute function app.set_updated_at();

-- Transições de status permitidas (defesa em profundidade; o cliente nem tem
-- grant na coluna status).
create or replace function app.guard_media_status()
returns trigger language plpgsql as $$
begin
  if new.status = old.status then return new; end if;
  if (old.status, new.status) in (
      ('uploading', 'uploaded'), ('uploading', 'failed'),
      ('uploaded', 'processing'), ('uploaded', 'failed'),
      ('processing', 'ready'), ('processing', 'failed'), ('processing', 'uploaded'),
      ('failed', 'uploaded'), ('ready', 'uploaded')) then
    return new;
  end if;
  raise exception 'invalid media status transition % -> %', old.status, new.status using errcode = 'P0001';
end $$;

create trigger media_assets_guard_status before update of status on public.media_assets
  for each row execute function app.guard_media_status();

-- ---------------------------------------------------------------------------
-- collections
-- ---------------------------------------------------------------------------
create table public.collections (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null check (char_length(trim(name)) between 1 and 80),
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index collections_ws_name_uq on public.collections (workspace_id, lower(name));
create trigger collections_updated_at before update on public.collections
  for each row execute function app.set_updated_at();

create table public.collection_items (
  collection_id  uuid not null references public.collections (id) on delete cascade,
  media_asset_id uuid not null references public.media_assets (id) on delete cascade,
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  position       integer not null default 0,
  added_at       timestamptz not null default now(),
  primary key (collection_id, media_asset_id)
);
create index collection_items_media_idx on public.collection_items (media_asset_id);
create index collection_items_order_idx on public.collection_items (collection_id, position);

-- Coleção e vídeo precisam pertencer ao mesmo workspace informado.
create or replace function app.guard_collection_item()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.collections c where c.id = new.collection_id and c.workspace_id = new.workspace_id)
     or not exists (select 1 from public.media_assets m where m.id = new.media_asset_id and m.workspace_id = new.workspace_id) then
    raise exception 'collection and media must belong to the same workspace' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger collection_items_guard before insert or update on public.collection_items
  for each row execute function app.guard_collection_item();

-- ---------------------------------------------------------------------------
-- media_jobs — fila técnica (probe/thumbnail, purge). Acesso só do worker.
-- ---------------------------------------------------------------------------
create table public.media_jobs (
  id               bigint generated always as identity primary key,
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  media_asset_id   uuid references public.media_assets (id) on delete cascade,
  kind             text not null check (kind in ('probe', 'purge')),
  status           text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  payload          jsonb not null default '{}'::jsonb,
  attempts         integer not null default 0,
  max_attempts     integer not null default 5,
  run_after        timestamptz not null default now(),
  lease_owner      text,
  lease_expires_at timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index media_jobs_claim_idx on public.media_jobs (run_after) where status = 'queued';
create index media_jobs_lease_idx on public.media_jobs (lease_expires_at) where status = 'running';
create unique index media_jobs_active_uq on public.media_jobs (media_asset_id, kind) where status in ('queued', 'running');
create trigger media_jobs_updated_at before update on public.media_jobs
  for each row execute function app.set_updated_at();

-- storage_gc — prefixos a apagar do storage quando um workspace é excluído.
-- Sem FK de propósito: precisa sobreviver à exclusão do workspace.
create table public.storage_gc (
  id         bigint generated always as identity primary key,
  bucket_id  text not null,
  prefix     text not null check (prefix ~ '^[0-9a-f-]{36}/$'),
  created_at timestamptz not null default now(),
  done_at    timestamptz,
  last_error text
);
create index storage_gc_pending_idx on public.storage_gc (created_at) where done_at is null;

create or replace function app.enqueue_workspace_storage_gc()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.storage_gc (bucket_id, prefix) values ('media', old.id::text || '/');
  return old;
end $$;
create trigger workspaces_storage_gc after delete on public.workspaces
  for each row execute function app.enqueue_workspace_storage_gc();

-- ---------------------------------------------------------------------------
-- RPCs do fluxo de upload
-- ---------------------------------------------------------------------------

-- Registra os vídeos ANTES do envio. Só caminhos pré-registrados podem ser
-- gravados no storage (ver policy media_insert). p_files: [{name, size, mime, sha256}]
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
    v_ext := case v_mime when 'video/mp4' then 'mp4' when 'video/quicktime' then 'mov' when 'video/webm' then 'webm' end;
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

-- Confirma que o objeto chegou ao storage com o tamanho declarado e enfileira o probe.
create or replace function public.complete_media_upload(p_media uuid)
returns public.media_status
language plpgsql security definer set search_path = '' as $$
declare
  m public.media_assets;
  obj_size bigint;
begin
  select * into m from public.media_assets where id = p_media for update;
  if m.id is null or not app.has_role(m.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;
  if m.status <> 'uploading' then
    return m.status;  -- idempotente
  end if;

  select (o.metadata ->> 'size')::bigint into obj_size
    from storage.objects o where o.bucket_id = 'media' and o.name = m.storage_path;
  if obj_size is null then
    raise exception 'object not found in storage' using errcode = 'P0002';
  end if;
  if obj_size <> m.size_bytes then
    update public.media_assets set status = 'failed', failure_reason = 'size_mismatch', upload_expires_at = null where id = m.id;
    insert into public.media_jobs (workspace_id, media_asset_id, kind, payload)
      values (m.workspace_id, m.id, 'purge', jsonb_build_object('paths', jsonb_build_array(m.storage_path), 'keep_row', true));
    return 'failed';
  end if;

  update public.media_assets set status = 'uploaded', upload_expires_at = null where id = m.id;
  insert into public.media_jobs (workspace_id, media_asset_id, kind) values (m.workspace_id, m.id, 'probe')
    on conflict do nothing;

  insert into public.usage_records (workspace_id, metric, quantity, period_start)
  values (m.workspace_id, 'uploads', 1, date_trunc('month', now())::date),
         (m.workspace_id, 'storage_bytes', m.size_bytes, date_trunc('month', now())::date)
  on conflict (workspace_id, metric, period_start)
  do update set quantity = public.usage_records.quantity + excluded.quantity, updated_at = now();

  return 'uploaded';
end $$;

-- Cancela um envio ainda não concluído (o cliente já abortou o TUS).
create or replace function public.cancel_media_upload(p_media uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  m public.media_assets;
begin
  select * into m from public.media_assets where id = p_media for update;
  if m.id is null or not app.has_role(m.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;
  if m.status <> 'uploading' then
    raise exception 'upload already completed' using errcode = 'P0001';
  end if;
  -- Se o objeto chegou a ser gravado, o worker o remove.
  if exists (select 1 from storage.objects o where o.bucket_id = 'media' and o.name = m.storage_path) then
    insert into public.media_jobs (workspace_id, kind, payload)
      values (m.workspace_id, 'purge', jsonb_build_object('paths', jsonb_build_array(m.storage_path)));
  end if;
  delete from public.media_assets where id = m.id;
end $$;

-- Exclusão lógica com janela de 30 dias para desfazer; o worker apaga os
-- arquivos depois. Registros históricos de publicação (Fase 3) não dependem
-- do arquivo.
create or replace function public.delete_media(p_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare
  m record;
  n integer := 0;
begin
  for m in select * from public.media_assets where id = any (p_ids) and deleted_at is null for update loop
    if not app.has_role(m.workspace_id, 'editor') then
      raise exception 'permission denied' using errcode = '42501';
    end if;
    update public.media_assets set deleted_at = now() where id = m.id;
    insert into public.media_jobs (workspace_id, media_asset_id, kind, run_after, payload)
      values (m.workspace_id, m.id, 'purge', now() + interval '30 days',
              jsonb_build_object('paths', to_jsonb(array_remove(array[m.storage_path, m.thumbnail_path], null))))
      on conflict do nothing;
    perform app.audit(m.workspace_id, 'media.deleted', 'media_asset', m.id::text, jsonb_build_object('name', m.name));
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.restore_media(p_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare
  m record;
  n integer := 0;
begin
  for m in select * from public.media_assets where id = any (p_ids) and deleted_at is not null for update loop
    if not app.has_role(m.workspace_id, 'editor') then
      raise exception 'permission denied' using errcode = '42501';
    end if;
    update public.media_jobs set status = 'cancelled'
      where media_asset_id = m.id and kind = 'purge' and status = 'queued';
    update public.media_assets set deleted_at = null where id = m.id;
    perform app.audit(m.workspace_id, 'media.restored', 'media_asset', m.id::text, '{}'::jsonb);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Reprocessa vídeos com falha de processamento.
create or replace function public.retry_media_processing(p_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare
  m record;
  n integer := 0;
begin
  for m in select * from public.media_assets
            where id = any (p_ids) and deleted_at is null and status = 'failed'
              and coalesce(failure_reason, '') <> 'size_mismatch' for update loop
    if not app.has_role(m.workspace_id, 'editor') then
      raise exception 'permission denied' using errcode = '42501';
    end if;
    update public.media_assets set status = 'uploaded', failure_reason = null where id = m.id;
    insert into public.media_jobs (workspace_id, media_asset_id, kind) values (m.workspace_id, m.id, 'probe')
      on conflict do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Define a ordem manual de uma coleção (posições 0..n-1 na ordem recebida).
create or replace function public.reorder_collection(p_collection uuid, p_media uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  c public.collections;
begin
  select * into c from public.collections where id = p_collection;
  if c.id is null or not app.has_role(c.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;
  update public.collection_items ci
     set position = o.ord - 1
    from unnest(p_media) with ordinality as o(media_id, ord)
   where ci.collection_id = p_collection and ci.media_asset_id = o.media_id;
end $$;

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.begin_media_upload(uuid, jsonb)', 'public.complete_media_upload(uuid)',
    'public.cancel_media_upload(uuid)', 'public.delete_media(uuid[])', 'public.restore_media(uuid[])',
    'public.retry_media_processing(uuid[])', 'public.reorder_collection(uuid, uuid[])'] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RLS das tabelas
-- ---------------------------------------------------------------------------
alter table public.media_assets     enable row level security;
alter table public.collections      enable row level security;
alter table public.collection_items enable row level security;
alter table public.media_jobs       enable row level security;
alter table public.storage_gc       enable row level security;

revoke all on public.media_assets, public.collections, public.collection_items, public.media_jobs, public.storage_gc from anon, authenticated;

grant select on public.media_assets to authenticated;
grant update (name, default_caption, default_hashtags) on public.media_assets to authenticated;

grant select, insert, delete on public.collections to authenticated;
grant update (name) on public.collections to authenticated;

grant select, insert, delete on public.collection_items to authenticated;

-- media_jobs: sem grants para clientes (somente worker / service role).

create policy media_select on public.media_assets for select to authenticated
  using (app.has_role(workspace_id, 'viewer'));
create policy media_update on public.media_assets for update to authenticated
  using (app.has_role(workspace_id, 'editor') and deleted_at is null)
  with check (app.has_role(workspace_id, 'editor'));

create policy collections_select on public.collections for select to authenticated
  using (app.has_role(workspace_id, 'viewer'));
create policy collections_insert on public.collections for insert to authenticated
  with check (app.has_role(workspace_id, 'editor') and created_by = (select auth.uid()));
create policy collections_update on public.collections for update to authenticated
  using (app.has_role(workspace_id, 'editor')) with check (app.has_role(workspace_id, 'editor'));
create policy collections_delete on public.collections for delete to authenticated
  using (app.has_role(workspace_id, 'editor'));

create policy collection_items_select on public.collection_items for select to authenticated
  using (app.has_role(workspace_id, 'viewer'));
create policy collection_items_insert on public.collection_items for insert to authenticated
  with check (app.has_role(workspace_id, 'editor'));
create policy collection_items_delete on public.collection_items for delete to authenticated
  using (app.has_role(workspace_id, 'editor'));

-- ---------------------------------------------------------------------------
-- Storage: bucket privado + policies
-- Estrutura de caminho: {workspace_id}/{media_id}/original.{ext} e .../thumb.jpg
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 52428800, array['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg'])
on conflict (id) do update set public = false;

-- Leitura: membros do workspace do primeiro segmento do caminho.
create policy media_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'media' and app.has_role(app.try_uuid((storage.foldername(name))[1]), 'viewer'));

-- Escrita: somente em caminho pré-registrado por begin_media_upload, ainda em
-- 'uploading', por editor do workspace. Thumbnails são gravadas pelo worker
-- (service role, ignora RLS).
create policy media_objects_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and app.has_role(app.try_uuid((storage.foldername(name))[1]), 'editor')
    and exists (
      select 1 from public.media_assets m
       where m.storage_path = storage.objects.name
         and m.status = 'uploading'
         and m.workspace_id = app.try_uuid((storage.foldername(storage.objects.name))[1])));

-- Sem update/delete pelo cliente: arquivos só são removidos pelo worker (purge).
