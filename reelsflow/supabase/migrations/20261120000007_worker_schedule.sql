-- ReelsFlow · Agendamento do worker (Edge Function "worker-tick") a cada minuto.
-- O segredo é gerado aqui, dentro do Vault, e nunca aparece em código ou logs:
-- o cron o lê de vault.decrypted_secrets; a função o lê pela própria conexão ao banco.
-- Condicional: o Postgres local de testes não tem pg_cron/pg_net/vault.
do $$
declare
  v_url text := 'https://mxeazufhstmdvpvhfjhw.supabase.co/functions/v1/worker-tick';
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net')
     or not exists (select 1 from pg_namespace where nspname = 'vault') then
    raise notice 'pg_cron/pg_net/vault ausentes: agendamento do worker não criado';
    return;
  end if;

  if not exists (select 1 from vault.secrets where name = 'worker_tick_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'worker_tick_secret',
                                'Cabeçalho x-worker-secret do worker-tick');
  end if;

  if exists (select 1 from cron.job where jobname = 'reelsflow-worker-tick') then
    perform cron.unschedule('reelsflow-worker-tick');
  end if;
  perform cron.schedule('reelsflow-worker-tick', '* * * * *', format($cmd$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'worker_tick_secret')),
      body := '{}'::jsonb,
      timeout_milliseconds := 5000)
  $cmd$, v_url));

  -- Histórico do pg_cron cresce 1.440 linhas/dia: mantém 3 dias.
  if exists (select 1 from cron.job where jobname = 'reelsflow-cron-history-cleanup') then
    perform cron.unschedule('reelsflow-cron-history-cleanup');
  end if;
  perform cron.schedule('reelsflow-cron-history-cleanup', '17 3 * * *',
    $c$delete from cron.job_run_details where end_time < now() - interval '3 days'$c$);
end $$;
