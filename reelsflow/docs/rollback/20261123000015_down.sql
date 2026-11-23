-- ROLLBACK da migration 20261123000015_reliability_alerts (Etapa 1).
-- Só remove o que a migration criou. Nenhum dado anterior depende destes objetos.
-- Executar SOMENTE se a Etapa 1 for revertida, e DEPOIS de voltar o worker (v4) e o site (itkbur1j6),
-- porque o código novo usa estes objetos.
begin;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and exists (select 1 from cron.job where jobname = 'reelsflow-worker-watchdog') then
    perform cron.unschedule('reelsflow-worker-watchdog');
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
