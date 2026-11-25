-- ROLLBACK da migration 20261125000017: restaura reschedule_job e set_campaign_status exatamente como em 20261119000003_scheduling.sql.
-- Não toca em dados.
create or replace function public.reschedule_job(p_job uuid, p_at timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.publication_jobs; c public.campaigns;
begin
  select * into r from public.publication_jobs where id = p_job for update;
  if r.id is null or not app.has_role(r.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;
  if r.status not in ('draft', 'scheduled', 'needs_review', 'failed_retryable', 'failed_permanent') then
    raise exception 'publication cannot be rescheduled in status %', r.status using errcode = 'P0001';
  end if;
  if r.status in ('draft', 'scheduled') and r.scheduled_at <= now() + app.edit_freeze() then
    raise exception 'publication is too close to its scheduled time' using errcode = 'P0001';
  end if;
  if p_at <= now() + app.edit_freeze() then
    raise exception 'scheduled time must be in the future' using errcode = '22023';
  end if;
  select * into c from public.campaigns where id = r.campaign_id;
  update public.publication_jobs
     set scheduled_at = p_at,
         next_attempt_at = p_at,
         local_date = (p_at at time zone r.timezone)::date,
         local_time = (p_at at time zone r.timezone)::time,
         dst_adjusted = false,
         pinned = true,
         status = case when r.status = 'draft' or c.status = 'draft' then 'draft'::public.job_status else 'scheduled'::public.job_status end,
         attempt_count = case when r.status in ('failed_retryable', 'failed_permanent', 'needs_review') then 0 else attempt_count end,
         review_reason = null,
         last_error_class = case when r.status in ('failed_permanent', 'needs_review') then null else last_error_class end
   where id = r.id;
  perform app.audit(r.workspace_id, 'job.rescheduled', 'publication_job', r.id::text,
    jsonb_build_object('from', r.scheduled_at, 'to', p_at, 'status', r.status));
end $$;
create or replace function public.set_campaign_status(p_campaign uuid, p_action text)
returns public.campaign_status language plpgsql security definer set search_path = '' as $$
declare
  c public.campaigns;
  v_new public.campaign_status;
begin
  select * into c from public.campaigns where id = p_campaign for update;
  if c.id is null or not app.has_role(c.workspace_id, 'editor') then
    raise exception 'not found' using errcode = '42501';
  end if;

  if p_action = 'activate' and c.status = 'draft' then
    if not exists (select 1 from public.campaign_targets t where t.campaign_id = c.id and t.enabled) then
      raise exception 'campaign has no targets' using errcode = 'P0001';
    end if;
    if not exists (select 1 from public.publication_jobs j where j.campaign_id = c.id and j.status = 'draft') then
      raise exception 'campaign has no planned publications' using errcode = 'P0001';
    end if;
    update public.publication_jobs set status = 'needs_review', review_reason = 'scheduled_time_passed_before_activation'
     where campaign_id = c.id and status = 'draft' and scheduled_at <= now() + app.edit_freeze();
    update public.publication_jobs set status = 'scheduled' where campaign_id = c.id and status = 'draft';
    v_new := 'active';
    update public.campaigns set status = v_new, activated_at = now() where id = c.id;
  elsif p_action = 'pause' and c.status = 'active' then
    v_new := 'paused';
    update public.campaigns set status = v_new where id = c.id;
  elsif p_action = 'resume' and c.status = 'paused' then
    v_new := 'active';
    update public.campaigns set status = v_new where id = c.id;
  elsif p_action = 'archive' and c.status in ('draft', 'paused', 'completed', 'active') then
    if exists (select 1 from public.publication_jobs j where j.campaign_id = c.id
                and j.status in ('preparing', 'uploading', 'processing_remote', 'publishing', 'uncertain')) then
      raise exception 'campaign has publications in progress' using errcode = 'P0001';
    end if;
    update public.publication_jobs set status = 'cancelled'
     where campaign_id = c.id and status in ('draft', 'scheduled', 'queued', 'failed_retryable', 'failed_permanent', 'needs_review');
    v_new := 'archived';
    update public.campaigns set status = v_new where id = c.id;
  else
    raise exception 'invalid campaign action % from %', p_action, c.status using errcode = 'P0001';
  end if;

  perform app.audit(c.workspace_id, 'campaign.' || p_action, 'campaign', c.id::text,
    jsonb_build_object('from', c.status, 'to', v_new));
  return v_new;
end $$;
