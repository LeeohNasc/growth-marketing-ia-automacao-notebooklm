-- ReelsFlow · Card Editorial (modelo de conteúdo renderizado pelo próprio ReelsFlow)
--
-- 1. media_assets passa a aceitar IMAGEM (JPEG) — o arquivo FINAL de um card em imagem é
--    publicado como qualquer mídia: upload verificado → análise no worker → pronto → campanha.
-- 2. editorial_cards guarda só o necessário para editar e re-renderizar o card.
--    Arquivos de origem (avatar, fotos, vídeo) ficam em {workspace}/cards/{card}/… e NUNCA são
--    agendáveis: só o render final (media_assets) entra em campanhas.
-- 3. Estado do render sincronizado com a mídia final por trigger (pronto/erro vêm do servidor).
-- Só acrescenta: nenhum dado existente é alterado.

-- 1 ---------------------------------------------------------------------------
alter table public.media_assets drop constraint if exists media_assets_mime_type_check;
alter table public.media_assets add constraint media_assets_mime_type_check
  check (mime_type in ('video/mp4', 'video/quicktime', 'image/jpeg'));
alter table public.media_assets
  add column if not exists kind text generated always as (case when mime_type like 'image/%' then 'image' else 'video' end) stored;

-- Origens do card: PNG/WebP de avatar/fotos além de JPEG e vídeo.
update storage.buckets
   set allowed_mime_types = array['video/mp4', 'video/quicktime', 'image/jpeg', 'image/png', 'image/webp']
 where id = 'media';

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
    v_ext := case v_mime when 'video/mp4' then 'mp4' when 'video/quicktime' then 'mov' when 'image/jpeg' then 'jpg' end;
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

-- 2 ---------------------------------------------------------------------------
create type public.card_render_status as enum ('draft', 'rendering', 'processing', 'ready', 'error');

-- Todos os caminhos de origem precisam estar sob {workspace}/cards/ (nada de outro workspace).
create or replace function app.card_paths_ok(p_ws uuid, p_paths text[])
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(bool_and(p ~ ('^' || p_ws::text || '/cards/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,80}$')), true)
    from unnest(p_paths) p
$$;

create table public.editorial_cards (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  created_by        uuid references auth.users (id) on delete set null,
  template_type     text not null default 'editorial_card' check (template_type = 'editorial_card'),
  template_version  integer not null default 1 check (template_version >= 1),
  title             text not null check (char_length(trim(title)) between 1 and 120),
  page_name         text not null default '' check (char_length(page_name) <= 120),
  username          text not null default '' check (char_length(username) <= 30 and username !~ '[^[:alnum:]._]'),
  -- 280 grafemas validados na aplicação; aqui o teto em code points (emoji compostos ocupam vários).
  headline          text not null default '' check (char_length(headline) <= 1200),
  caption           text check (char_length(caption) <= 2200),
  hashtags          text[] not null default '{}' check (cardinality(hashtags) <= 30),
  format            text not null default 'feed' check (format in ('feed', 'square', 'vertical')),
  media_kind        text not null default 'image' check (media_kind in ('image', 'image_pair', 'video')),
  fit               text not null default 'cover' check (fit in ('cover', 'contain')),
  style             jsonb not null default '{}'::jsonb check (jsonb_typeof(style) = 'object'),
  focal             jsonb not null default '[]'::jsonb check (jsonb_typeof(focal) = 'array'),
  avatar_path       text,
  media_paths       text[] not null default '{}' check (cardinality(media_paths) <= 2),
  media_meta        jsonb not null default '{}'::jsonb check (jsonb_typeof(media_meta) = 'object'),
  social_account_id uuid references public.social_accounts (id) on delete set null,
  render_status     public.card_render_status not null default 'draft',
  render_error      text check (char_length(render_error) <= 500),
  rendered_media_id uuid references public.media_assets (id) on delete set null,
  render_started_at timestamptz,
  rendered_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint editorial_cards_paths_in_workspace
    check (app.card_paths_ok(workspace_id, media_paths || coalesce(array[avatar_path], '{}')))
);
create index editorial_cards_ws_idx on public.editorial_cards (workspace_id, updated_at desc);
create trigger editorial_cards_updated_at before update on public.editorial_cards
  for each row execute function app.set_updated_at();

alter table public.media_assets
  add column if not exists source_card_id uuid references public.editorial_cards (id) on delete set null;

-- Integridade: conta e render final do MESMO workspace; edição de conteúdo invalida render pronto.
create or replace function app.guard_editorial_card()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.social_account_id is not null and not exists (
      select 1 from public.social_accounts a where a.id = new.social_account_id and a.workspace_id = new.workspace_id) then
    raise exception 'account outside workspace' using errcode = '42501';
  end if;
  if new.rendered_media_id is not null and not exists (
      select 1 from public.media_assets m where m.id = new.rendered_media_id and m.workspace_id = new.workspace_id) then
    raise exception 'render outside workspace' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if new.workspace_id <> old.workspace_id then
      raise exception 'workspace is immutable' using errcode = '42501';
    end if;
    -- Conteúdo mudou depois de renderizado: o render antigo continua na biblioteca (e agendado, se
    -- estiver), mas o card volta a rascunho até ser renderizado de novo.
    if old.render_status in ('processing', 'ready') and new.render_status = old.render_status and (
         new.page_name, new.username, new.headline, new.format, new.media_kind, new.fit, new.style, new.focal,
         new.avatar_path, new.media_paths)
       is distinct from (
         old.page_name, old.username, old.headline, old.format, old.media_kind, old.fit, old.style, old.focal,
         old.avatar_path, old.media_paths) then
      new.render_status := 'draft';
      new.render_error := null;
    end if;
  end if;
  return new;
end $$;
create trigger editorial_cards_guard before insert or update on public.editorial_cards
  for each row execute function app.guard_editorial_card();

alter table public.editorial_cards enable row level security;
revoke all on public.editorial_cards from anon, authenticated;
grant select, insert on public.editorial_cards to authenticated;
-- Conteúdo editável pelo cliente; estado do render só por RPC/trigger.
grant update (title, page_name, username, headline, caption, hashtags, format, media_kind, fit, style, focal,
              avatar_path, media_paths, media_meta, social_account_id) on public.editorial_cards to authenticated;

create policy editorial_cards_select on public.editorial_cards for select to authenticated
  using (app.has_role(workspace_id, 'viewer'));
create policy editorial_cards_insert on public.editorial_cards for insert to authenticated
  with check (app.has_role(workspace_id, 'editor') and created_by = (select auth.uid())
              and render_status = 'draft' and rendered_media_id is null);
create policy editorial_cards_update on public.editorial_cards for update to authenticated
  using (app.has_role(workspace_id, 'editor')) with check (app.has_role(workspace_id, 'editor'));

-- Arquivos de origem: editor grava em {ws}/cards/{card}/{arquivo} de um card existente do workspace.
create policy media_card_sources_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and storage.objects.name ~ '^[0-9a-f-]{36}/cards/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,80}$'
    and app.has_role(app.try_uuid((storage.foldername(name))[1]), 'editor')
    and exists (
      select 1 from public.editorial_cards c
       where c.id = app.try_uuid((storage.foldername(storage.objects.name))[3])
         and c.workspace_id = app.try_uuid((storage.foldername(storage.objects.name))[1])));

-- 3 ---------------------------------------------------------------------------
-- Estado do render dirigido pelo navegador (que renderiza), sem poder declarar "pronto".
create or replace function public.set_card_render_state(p_card uuid, p_state text, p_error text default null)
returns public.card_render_status language plpgsql security definer set search_path = '' as $$
declare c public.editorial_cards;
begin
  select * into c from public.editorial_cards where id = p_card for update;
  if c.id is null or not app.has_role(c.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;
  if p_state not in ('rendering', 'error', 'draft') then
    raise exception 'invalid state' using errcode = '22023';
  end if;
  update public.editorial_cards
     set render_status = p_state::public.card_render_status,
         render_error = case when p_state = 'error' then left(coalesce(p_error, 'Falha na renderização.'), 500) end,
         render_started_at = case when p_state = 'rendering' then now() else render_started_at end
   where id = p_card;
  return p_state::public.card_render_status;
end $$;
revoke all on function public.set_card_render_state(uuid, text, text) from public, anon;
grant execute on function public.set_card_render_state(uuid, text, text) to authenticated;

-- Liga o arquivo final (já enviado e concluído via begin/complete_media_upload) ao card.
-- O card só fica "pronto" quando o worker analisar o arquivo (trigger abaixo).
create or replace function public.attach_card_render(p_card uuid, p_media uuid)
returns public.card_render_status language plpgsql security definer set search_path = '' as $$
declare c public.editorial_cards; m public.media_assets; v_state public.card_render_status;
begin
  select * into c from public.editorial_cards where id = p_card for update;
  if c.id is null or not app.has_role(c.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;
  select * into m from public.media_assets where id = p_media for update;
  if m.id is null or m.workspace_id <> c.workspace_id or m.deleted_at is not null then
    raise exception 'media not found' using errcode = '42501';
  end if;
  if (c.media_kind = 'video') <> (m.mime_type = 'video/mp4') or (c.media_kind <> 'video' and m.mime_type <> 'image/jpeg') then
    raise exception 'render type does not match card' using errcode = '22023';
  end if;
  if m.status = 'uploading' then
    raise exception 'upload not completed' using errcode = '22023';
  end if;
  v_state := case m.status when 'ready' then 'ready' when 'failed' then 'error' else 'processing' end;
  update public.media_assets
     set source_card_id = c.id,
         default_caption = coalesce(default_caption, c.caption),
         default_hashtags = case when cardinality(default_hashtags) = 0 then c.hashtags else default_hashtags end
   where id = m.id;
  update public.editorial_cards
     set rendered_media_id = m.id, render_status = v_state, rendered_at = now(),
         render_error = case when v_state = 'error' then coalesce(m.failure_reason, 'invalid_render') end
   where id = c.id;
  perform app.audit(c.workspace_id, 'card.rendered', 'editorial_card', c.id::text, jsonb_build_object('media_id', m.id));
  return v_state;
end $$;
revoke all on function public.attach_card_render(uuid, uuid) from public, anon;
grant execute on function public.attach_card_render(uuid, uuid) to authenticated;

-- Quando o worker conclui a análise do arquivo final, o card acompanha.
create or replace function app.sync_card_render_from_media()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status and new.status in ('ready', 'failed') then
    update public.editorial_cards
       set render_status = case when new.status = 'ready' then 'ready'::public.card_render_status else 'error'::public.card_render_status end,
           render_error = case when new.status = 'failed' then coalesce(new.failure_reason, 'invalid_render') end
     where rendered_media_id = new.id and render_status = 'processing';
  end if;
  return new;
end $$;
create trigger media_assets_sync_card after update of status on public.media_assets
  for each row execute function app.sync_card_render_from_media();

-- Duplicar: novo rascunho com o mesmo conteúdo e as mesmas origens (mesmo workspace).
create or replace function public.duplicate_editorial_card(p_card uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare c public.editorial_cards; v_id uuid;
begin
  select * into c from public.editorial_cards where id = p_card;
  if c.id is null or not app.has_role(c.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;
  insert into public.editorial_cards (workspace_id, created_by, template_version, title, page_name, username, headline, caption, hashtags,
                                      format, media_kind, fit, style, focal, avatar_path, media_paths, media_meta, social_account_id)
  values (c.workspace_id, (select auth.uid()), c.template_version, left('Cópia de ' || c.title, 120), c.page_name, c.username, c.headline,
          c.caption, c.hashtags, c.format, c.media_kind, c.fit, c.style, c.focal, c.avatar_path, c.media_paths, c.media_meta, c.social_account_id)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.duplicate_editorial_card(uuid) from public, anon;
grant execute on function public.duplicate_editorial_card(uuid) to authenticated;

-- Excluir: remove o card e agenda a limpeza das origens que nenhum outro card usa.
-- O render final continua na biblioteca (é uma mídia do usuário, possivelmente agendada).
create or replace function public.delete_editorial_card(p_card uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.editorial_cards; v_orphans text[];
begin
  select * into c from public.editorial_cards where id = p_card for update;
  if c.id is null or not app.has_role(c.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;
  delete from public.editorial_cards where id = c.id;
  select coalesce(array_agg(p), '{}') into v_orphans
    from unnest(c.media_paths || coalesce(array[c.avatar_path], '{}')) p
   where not exists (select 1 from public.editorial_cards o
                      where o.workspace_id = c.workspace_id and (p = any (o.media_paths) or o.avatar_path = p));
  if cardinality(v_orphans) > 0 then
    insert into public.media_jobs (workspace_id, media_asset_id, kind, payload)
    values (c.workspace_id, null, 'purge', jsonb_build_object('paths', to_jsonb(v_orphans)));
  end if;
  perform app.audit(c.workspace_id, 'card.deleted', 'editorial_card', c.id::text, '{}'::jsonb);
end $$;
revoke all on function public.delete_editorial_card(uuid) from public, anon;
grant execute on function public.delete_editorial_card(uuid) to authenticated;
