-- ReelsFlow · Tela Dividida (Split Screen)
--
-- Um projeto guarda só a CONFIGURAÇÃO da edição (layout, recortes, trechos, áudio) e aponta para
-- dois vídeos da Biblioteca do MESMO workspace. Os arquivos de origem nunca são alterados.
-- O vídeo final é renderizado no navegador e entra na Biblioteca como uma mídia NOVA
-- (begin/complete_media_upload → análise do worker); cada nova renderização gera outra mídia,
-- nunca sobrescreve a anterior.
-- Só acrescenta: nenhum dado existente é alterado.

create table public.split_projects (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  created_by        uuid references auth.users (id) on delete set null,
  title             text not null check (char_length(trim(title)) between 1 and 120),
  config            jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object' and octet_length(config::text) <= 20000),
  top_media_id      uuid references public.media_assets (id) on delete set null,
  bottom_media_id   uuid references public.media_assets (id) on delete set null,
  render_status     public.card_render_status not null default 'draft',
  render_error      text check (char_length(render_error) <= 500),
  rendered_media_id uuid references public.media_assets (id) on delete set null,
  render_started_at timestamptz,
  rendered_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index split_projects_ws_idx on public.split_projects (workspace_id, updated_at desc);
create trigger split_projects_updated_at before update on public.split_projects
  for each row execute function app.set_updated_at();

alter table public.media_assets
  add column if not exists source_split_id uuid references public.split_projects (id) on delete set null;

-- Integridade: origens e render do MESMO workspace, origens são vídeos; editar depois de pronto
-- volta a rascunho (o render antigo continua na Biblioteca).
create or replace function app.guard_split_project()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  foreach v_id in array array[new.top_media_id, new.bottom_media_id] loop
    if v_id is not null and not exists (
        select 1 from public.media_assets m
         where m.id = v_id and m.workspace_id = new.workspace_id and m.kind = 'video' and m.deleted_at is null) then
      raise exception 'source outside workspace or not a video' using errcode = '42501';
    end if;
  end loop;
  if new.rendered_media_id is not null and not exists (
      select 1 from public.media_assets m where m.id = new.rendered_media_id and m.workspace_id = new.workspace_id) then
    raise exception 'render outside workspace' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if new.workspace_id <> old.workspace_id then
      raise exception 'workspace is immutable' using errcode = '42501';
    end if;
    if old.render_status in ('processing', 'ready') and new.render_status = old.render_status
       and (new.config, new.top_media_id, new.bottom_media_id) is distinct from (old.config, old.top_media_id, old.bottom_media_id) then
      new.render_status := 'draft';
      new.render_error := null;
    end if;
  end if;
  return new;
end $$;
create trigger split_projects_guard before insert or update on public.split_projects
  for each row execute function app.guard_split_project();

alter table public.split_projects enable row level security;
revoke all on public.split_projects from anon, authenticated;
grant select, insert on public.split_projects to authenticated;
grant update (title, config, top_media_id, bottom_media_id) on public.split_projects to authenticated;

create policy split_projects_select on public.split_projects for select to authenticated
  using (app.has_role(workspace_id, 'viewer'));
create policy split_projects_insert on public.split_projects for insert to authenticated
  with check (app.has_role(workspace_id, 'editor') and created_by = (select auth.uid())
              and render_status = 'draft' and rendered_media_id is null);
create policy split_projects_update on public.split_projects for update to authenticated
  using (app.has_role(workspace_id, 'editor')) with check (app.has_role(workspace_id, 'editor'));

-- Estado do render dirigido pelo navegador (que renderiza), sem poder declarar "pronto".
create or replace function public.set_split_render_state(p_project uuid, p_state text, p_error text default null)
returns public.card_render_status language plpgsql security definer set search_path = '' as $$
declare p public.split_projects;
begin
  select * into p from public.split_projects where id = p_project for update;
  if p.id is null or not app.has_role(p.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;
  if p_state not in ('rendering', 'error', 'draft') then
    raise exception 'invalid state' using errcode = '22023';
  end if;
  update public.split_projects
     set render_status = p_state::public.card_render_status,
         render_error = case when p_state = 'error' then left(coalesce(p_error, 'Falha na renderização.'), 500) end,
         render_started_at = case when p_state = 'rendering' then now() else render_started_at end
   where id = p_project;
  return p_state::public.card_render_status;
end $$;
revoke all on function public.set_split_render_state(uuid, text, text) from public, anon;
grant execute on function public.set_split_render_state(uuid, text, text) to authenticated;

-- Liga o MP4 final (já enviado via begin/complete_media_upload) ao projeto. "Pronto" só depois da
-- análise do worker (trigger abaixo).
create or replace function public.attach_split_render(p_project uuid, p_media uuid)
returns public.card_render_status language plpgsql security definer set search_path = '' as $$
declare p public.split_projects; m public.media_assets; v_state public.card_render_status;
begin
  select * into p from public.split_projects where id = p_project for update;
  if p.id is null or not app.has_role(p.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;
  select * into m from public.media_assets where id = p_media for update;
  if m.id is null or m.workspace_id <> p.workspace_id or m.deleted_at is not null then
    raise exception 'media not found' using errcode = '42501';
  end if;
  if m.mime_type <> 'video/mp4' then
    raise exception 'render must be mp4' using errcode = '22023';
  end if;
  if m.id in (p.top_media_id, p.bottom_media_id) then
    raise exception 'render cannot be a source' using errcode = '22023';
  end if;
  if m.status = 'uploading' then
    raise exception 'upload not completed' using errcode = '22023';
  end if;
  v_state := case m.status when 'ready' then 'ready' when 'failed' then 'error' else 'processing' end;
  update public.media_assets set source_split_id = p.id where id = m.id;
  update public.split_projects
     set rendered_media_id = m.id, render_status = v_state, rendered_at = now(),
         render_error = case when v_state = 'error' then coalesce(m.failure_reason, 'invalid_render') end
   where id = p.id;
  perform app.audit(p.workspace_id, 'split.rendered', 'split_project', p.id::text, jsonb_build_object('media_id', m.id));
  return v_state;
end $$;
revoke all on function public.attach_split_render(uuid, uuid) from public, anon;
grant execute on function public.attach_split_render(uuid, uuid) to authenticated;

create or replace function app.sync_split_render_from_media()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status and new.status in ('ready', 'failed') then
    update public.split_projects
       set render_status = case when new.status = 'ready' then 'ready'::public.card_render_status else 'error'::public.card_render_status end,
           render_error = case when new.status = 'failed' then coalesce(new.failure_reason, 'invalid_render') end
     where rendered_media_id = new.id and render_status = 'processing';
  end if;
  return new;
end $$;
create trigger media_assets_sync_split after update of status on public.media_assets
  for each row execute function app.sync_split_render_from_media();

-- Duplicar (mesmas origens e configuração) e excluir (origens e renders ficam na Biblioteca).
create or replace function public.duplicate_split_project(p_project uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare p public.split_projects; v_id uuid;
begin
  select * into p from public.split_projects where id = p_project;
  if p.id is null or not app.has_role(p.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;
  insert into public.split_projects (workspace_id, created_by, title, config, top_media_id, bottom_media_id)
  values (p.workspace_id, (select auth.uid()), left('Cópia de ' || p.title, 120), p.config, p.top_media_id, p.bottom_media_id)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.duplicate_split_project(uuid) from public, anon;
grant execute on function public.duplicate_split_project(uuid) to authenticated;

create or replace function public.delete_split_project(p_project uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare p public.split_projects;
begin
  select * into p from public.split_projects where id = p_project for update;
  if p.id is null or not app.has_role(p.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;
  delete from public.split_projects where id = p.id;
  perform app.audit(p.workspace_id, 'split.deleted', 'split_project', p.id::text, '{}'::jsonb);
end $$;
revoke all on function public.delete_split_project(uuid) from public, anon;
grant execute on function public.delete_split_project(uuid) to authenticated;
