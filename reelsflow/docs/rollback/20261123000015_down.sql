-- ROLLBACK da migration 20261123000015_reliability_alerts (Etapa 1).
-- Só remove o que a migration criou. Nenhum dado anterior depende destes objetos.
-- Executar SOMENTE se a Etapa 1 for revertida, e DEPOIS de voltar o worker (v4) e o site (itkbur1j6),
-- porque o código novo usa estes objetos.
-- TRAVA: se já existirem dados criados depois do deploy (preferências de aviso, alertas operacionais
-- ou registros de entrega de e-mail), este script PARA sem apagar nada. Só prossegue com autorização
-- explícita do responsável, sinalizada nesta mesma sessão por:
--   set reelsflow.confirm_rollback_15 = 'autorizado';
-- e, mesmo assim, copia esses dados para o esquema rf_backup antes de remover.
begin;
do $$
declare v_new integer;
begin
  select (select count(*) from public.notification_preferences)
       + (select count(*) from public.ops_alerts)
       + (select count(*) from public.notifications where email_attempts > 0 or email_error is not null or emailed_at is not null)
    into v_new;
  if v_new > 0 and coalesce(current_setting('reelsflow.confirm_rollback_15', true), '') <> 'autorizado' then
    raise exception 'Rollback interrompido: % registro(s) novo(s) seriam perdidos. Requer autorização explícita.', v_new;
  end if;
  if v_new > 0 then
    create schema if not exists rf_backup;
    execute 'create table if not exists rf_backup.notification_preferences_pre_rollback as select * from public.notification_preferences';
    execute 'create table if not exists rf_backup.ops_alerts_pre_rollback as select * from public.ops_alerts';
    execute 'create table if not exists rf_backup.notifications_email_pre_rollback as select id, email_status, email_attempts, email_error, emailed_at from public.notifications';
  end if;
end $$;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.unschedule(jobid) from cron.job where jobname = 'reelsflow-worker-watchdog'$q$;
  end if;
end $$;
drop trigger if exists notifications_mark_email on public.notifications;
drop function if exists app.mark_notification_email();
drop index if exists public.notifications_email_pending_idx;
alter table public.notifications drop column if exists email_attempts, drop column if exists email_error, drop column if exists emailed_at;
drop table if exists public.notification_preferences;
drop function if exists app.email_worthy(text);
drop function if exists public.worker_watchdog();
drop function if exists app.resolve_ops_alert(text);
drop function if exists app.raise_ops_alert(text, text, uuid, text, jsonb, text);
drop table if exists public.ops_alerts;
-- email_status de notificações criadas depois do deploy fica como está (coluna é anterior à migration).
delete from supabase_migrations.schema_migrations where version = '20261123000015';
commit;
