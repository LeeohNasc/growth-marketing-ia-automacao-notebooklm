-- ReelsFlow · Confiabilidade: alertas operacionais, vigia do worker e central de avisos por e-mail.
--
-- Só ACRESCENTA (tabelas, colunas, funções e um agendamento). Nenhum dado existente é alterado.
--  1. ops_alerts: problemas da OPERAÇÃO (servidor mal configurado, worker parado, onda de falhas),
--     para o responsável pelo ReelsFlow. Sem acesso pelo navegador.
--  2. worker_watchdog(): roda DENTRO do banco (pg_cron), independente da Edge Function — detecta o
--     worker parado mesmo que a função esteja fora do ar — e avisa os admins afetados (1 vez a cada 6 h).
--  3. Avisos por e-mail: preferências por usuário, fila de envio na própria notificação
--     (email_status) com tentativas, erro e horário. O envio só acontece se um provedor for configurado.

-- 1 ---------------------------------------------------------------------------
create table public.ops_alerts (
  id            bigint generated always as identity primary key,
  kind          text not null check (char_length(kind) <= 64),
  severity      text not null default 'error' check (severity in ('warning', 'error', 'critical')),
  workspace_id  uuid references public.workspaces (id) on delete cascade,
  message       text not null check (char_length(message) <= 500),
  details       jsonb not null default '{}'::jsonb,
  dedupe_key    text not null unique check (char_length(dedupe_key) <= 200),
  occurrences   integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  resolved_at   timestamptz
);
create index ops_alerts_open_idx on public.ops_alerts (last_seen_at desc) where resolved_at is null;
alter table public.ops_alerts enable row level security;
revoke all on public.ops_alerts from anon, authenticated;

-- Registra (ou repete) um alerta aberto; reabre se já estava resolvido.
create or replace function app.raise_ops_alert(p_kind text, p_severity text, p_workspace uuid, p_message text, p_details jsonb, p_dedupe text)
returns void language sql security definer set search_path = '' as $$
  insert into public.ops_alerts (kind, severity, workspace_id, message, details, dedupe_key)
  values (p_kind, p_severity, p_workspace, left(p_message, 500), coalesce(p_details, '{}'::jsonb), left(p_dedupe, 200))
  on conflict (dedupe_key) do update
     set occurrences = public.ops_alerts.occurrences + 1, last_seen_at = now(), message = excluded.message,
         details = excluded.details, severity = excluded.severity, resolved_at = null
$$;
create or replace function app.resolve_ops_alert(p_dedupe text)
returns void language sql security definer set search_path = '' as $$
  update public.ops_alerts set resolved_at = now() where dedupe_key = p_dedupe and resolved_at is null
$$;
-- Só o servidor (worker/vigia) registra ou resolve alertas: o navegador não pode criar alertas falsos.
revoke all on function app.raise_ops_alert(text, text, uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function app.resolve_ops_alert(text) from public, anon, authenticated;

-- 2 ---------------------------------------------------------------------------
-- Worker parado (sem sinal há > 5 min) com publicações vencidas: alerta operacional + aviso aos admins
-- dos workspaces afetados (no máximo 1 a cada 6 h por pessoa). Onda de falhas definitivas (≥ 5 na
-- última hora) também vira alerta. Volta ao normal → alertas resolvidos.
create or replace function public.worker_watchdog()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_last timestamptz;
  v_due integer;
  v_failed integer;
  v_stalled boolean;
begin
  select max(last_seen_at) into v_last from public.worker_heartbeats;
  select count(*) into v_due from public.publication_jobs
   where status in ('scheduled', 'queued', 'failed_retryable') and scheduled_at <= now();
  v_stalled := (v_last is null or v_last < now() - interval '5 minutes') and v_due > 0;

  if v_stalled then
    perform app.raise_ops_alert('worker_stalled', 'critical', null,
      'O processador de publicações não dá sinal desde ' || coalesce(to_char(v_last at time zone 'UTC', 'DD/MM HH24:MI "UTC"'), 'nunca') ||
      ' e há ' || v_due || ' publicação(ões) vencida(s).',
      jsonb_build_object('last_seen_at', v_last, 'due', v_due), 'worker_stalled');
    insert into public.notifications (workspace_id, user_id, type, payload, email_status)
    select distinct j.workspace_id, m.user_id, 'system.worker_stalled',
           jsonb_build_object('since', v_last, 'due', (select count(*) from public.publication_jobs x
                                                         where x.workspace_id = j.workspace_id and x.status in ('scheduled', 'queued', 'failed_retryable')
                                                           and x.scheduled_at <= now())),
           'pending'
      from public.publication_jobs j
      join public.workspace_members m on m.workspace_id = j.workspace_id and m.role in ('owner', 'admin')
     where j.status in ('scheduled', 'queued', 'failed_retryable') and j.scheduled_at <= now()
       and not exists (select 1 from public.notifications n where n.user_id = m.user_id and n.workspace_id = j.workspace_id
                          and n.type = 'system.worker_stalled' and n.created_at > now() - interval '6 hours');
  else
    perform app.resolve_ops_alert('worker_stalled');
  end if;

  select count(*) into v_failed from public.publication_jobs where status = 'failed_permanent' and updated_at > now() - interval '1 hour';
  if v_failed >= 5 then
    perform app.raise_ops_alert('publication_failure_spike', 'error', null,
      v_failed || ' publicações falharam de forma definitiva na última hora.', jsonb_build_object('failed_last_hour', v_failed), 'publication_failure_spike');
  else
    perform app.resolve_ops_alert('publication_failure_spike');
  end if;
  return jsonb_build_object('stalled', v_stalled, 'last_seen_at', v_last, 'due', v_due, 'failed_last_hour', v_failed);
end $$;
revoke all on function public.worker_watchdog() from public, anon, authenticated;

-- Agendamento a cada 5 min (condicional: o Postgres local de testes não tem pg_cron).
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron ausente: vigia do worker não agendado';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'reelsflow-worker-watchdog') then
    perform cron.unschedule('reelsflow-worker-watchdog');
  end if;
  perform cron.schedule('reelsflow-worker-watchdog', '*/5 * * * *', $c$select public.worker_watchdog()$c$);
end $$;

-- 3 ---------------------------------------------------------------------------
-- Tipos de aviso que merecem e-mail (o resto fica só no sistema).
create or replace function app.email_worthy(p_type text)
returns boolean language sql immutable set search_path = '' as $$
  select p_type in ('publication.failed', 'publication.needs_review', 'publication.late', 'account.disconnected',
                    'account.token_expiring', 'system.worker_stalled', 'upload.failed', 'plan.limit_reached')
$$;

create table public.notification_preferences (
  user_id        uuid not null references auth.users (id) on delete cascade,
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  email_enabled  boolean not null default true,
  -- categorias desligadas pelo usuário (o padrão é receber todas as importantes)
  muted_types    text[] not null default '{}' check (cardinality(muted_types) <= 20),
  updated_at     timestamptz not null default now(),
  primary key (user_id, workspace_id)
);
create trigger notification_preferences_updated_at before update on public.notification_preferences
  for each row execute function app.set_updated_at();
alter table public.notification_preferences enable row level security;
revoke all on public.notification_preferences from anon, authenticated;
grant select, insert, update (email_enabled, muted_types) on public.notification_preferences to authenticated;
create policy notification_preferences_own on public.notification_preferences for all to authenticated
  using (user_id = (select auth.uid()) and app.has_role(workspace_id, 'viewer'))
  with check (user_id = (select auth.uid()) and app.has_role(workspace_id, 'viewer'));

alter table public.notifications
  add column if not exists email_attempts integer not null default 0,
  add column if not exists email_error text check (char_length(email_error) <= 300),
  add column if not exists emailed_at timestamptz;
create index notifications_email_pending_idx on public.notifications (created_at) where email_status = 'pending';

-- Toda notificação importante nasce "pendente" para e-mail; o envio respeita preferências e limites.
create or replace function app.mark_notification_email()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.email_status is null and app.email_worthy(new.type) then
    new.email_status := 'pending';
  end if;
  return new;
end $$;
create trigger notifications_mark_email before insert on public.notifications
  for each row execute function app.mark_notification_email();
