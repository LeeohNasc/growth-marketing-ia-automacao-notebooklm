-- ReelsFlow · Cobrança recorrente (Stripe Checkout + Billing) — primeira versão, modo de teste.
--
-- Reaproveita public.subscriptions (1 linha por workspace) e app.plan_defaults/app.workspace_limits.
-- Só ACRESCENTA: novos códigos de plano, colunas de vínculo com a Stripe, limite TOTAL de contas
-- sociais, registro idempotente de eventos e sessões de checkout. Nenhum dado existente é alterado:
-- todos os workspaces atuais continuam "starter" e `subscriptions.limits` (sobrescritas manuais)
-- continua tendo prioridade sobre os limites do plano.
--
-- Escrita de cobrança: SOMENTE pelo servidor (service_role) via funções billing_*; o cliente
-- (authenticated) só lê o próprio estado. O plano nunca é definido pelo navegador.

-- ---------------------------------------------------------------------------
-- Catálogo: códigos de plano e limites
-- ---------------------------------------------------------------------------
alter table public.subscriptions drop constraint if exists subscriptions_plan_check;
alter table public.subscriptions add constraint subscriptions_plan_check
  check (plan in ('starter', 'pro', 'business', 'premium', 'agency'));  -- 'agency' = legado, mantido

-- social_accounts = limite TOTAL de contas reais (todas as redes). Ausente = sem limite total
-- (só vale accounts_per_platform), preservando o comportamento atual do Starter e do legado.
-- Marcas ainda não existem no produto: não há limite de marca (benefício planejado).
-- Vídeos/armazenamento dos planos novos são provisórios (não definidos comercialmente).
create or replace function app.plan_defaults(p_plan text)
returns jsonb language sql immutable as $$
  select case p_plan
    when 'premium'  then '{"seats": 6, "social_accounts": 12, "accounts_per_platform": 12, "videos": 20000, "storage_bytes": 1099511627776}'::jsonb
    when 'business' then '{"seats": 3, "social_accounts": 4,  "accounts_per_platform": 4,  "videos": 5000,  "storage_bytes": 268435456000}'::jsonb
    when 'pro'      then '{"seats": 1, "social_accounts": 1,  "accounts_per_platform": 1,  "videos": 2000,  "storage_bytes": 107374182400}'::jsonb
    when 'agency'   then '{"seats": 20, "accounts_per_platform": 50, "videos": 20000, "storage_bytes": 1099511627776}'::jsonb
    else                 '{"seats": 1,  "accounts_per_platform": 1,  "videos": 200,   "storage_bytes": 10737418240}'::jsonb
  end
$$;

-- ---------------------------------------------------------------------------
-- Vínculo com a Stripe (na própria subscriptions)
-- ---------------------------------------------------------------------------
alter table public.subscriptions
  add column provider               text check (provider in ('stripe')),
  add column stripe_customer_id     text unique,
  add column stripe_subscription_id text unique,
  add column stripe_price_id        text,
  add column billing_interval       text check (billing_interval in ('month', 'year')),
  add column provider_status        text,           -- status bruto da Stripe (active, past_due, canceled…)
  add column current_period_end     timestamptz,
  add column cancel_at_period_end   boolean not null default false,
  add column provider_synced_at     timestamptz;     -- quando o estado aplicado foi lido da Stripe

-- O cliente lê só o necessário (sem os identificadores da Stripe).
revoke select on public.subscriptions from authenticated;
grant select (workspace_id, plan, status, limits, billing_interval, provider_status, current_period_end,
              cancel_at_period_end, created_at, updated_at)
  on public.subscriptions to authenticated;

-- Quem gerencia cobrança: owner e admin do workspace.
create or replace function app.can_manage_billing(p_workspace uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members m
                  where m.workspace_id = p_workspace and m.user_id = p_user and m.role in ('owner', 'admin'))
$$;
revoke all on function app.can_manage_billing(uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- Limite de contas sociais: por rede (existente) + TOTAL (novo), à prova de concorrência
-- ---------------------------------------------------------------------------
create or replace function app.enforce_account_limits()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_count bigint; v_total bigint; l jsonb;
begin
  if new.platform = 'mock' then return new; end if;
  if tg_op = 'UPDATE' and old.status <> 'disconnected' then return new; end if;
  if new.status = 'disconnected' then return new; end if;
  -- Serializa conexões do mesmo workspace: duas inserções simultâneas não passam juntas do limite.
  -- (READ COMMITTED: as contagens abaixo já enxergam o que a transação anterior confirmou.)
  perform pg_advisory_xact_lock(hashtextextended('rf:accounts:' || new.workspace_id::text, 0));
  l := app.workspace_limits(new.workspace_id);
  select count(*) filter (where platform = new.platform), count(*) into v_count, v_total
    from public.social_accounts
   where workspace_id = new.workspace_id and platform <> 'mock' and status <> 'disconnected' and id <> new.id
     -- Reconexão (INSERT … ON CONFLICT): o BEFORE INSERT roda antes do conflito; não contar a própria conta.
     and not (platform = new.platform and external_account_id = new.external_account_id);
  if v_count + 1 > (l ->> 'accounts_per_platform')::bigint then
    perform app.limit_error('accounts_per_platform');
  end if;
  if l ? 'social_accounts' and v_total + 1 > (l ->> 'social_accounts')::bigint then
    perform app.limit_error('social_accounts');
  end if;
  return new;
end $$;

-- Uso para a tela de assinatura: inclui o total de contas reais.
create or replace function public.workspace_usage(p_workspace uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  if not app.has_role(p_workspace, 'viewer') then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'limits', app.workspace_limits(p_workspace),
    'seats', (select count(*) from public.workspace_members m where m.workspace_id = p_workspace)
             + (select count(*) from public.workspace_invitations i where i.workspace_id = p_workspace and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()),
    'videos', (select count(*) from public.media_assets a where a.workspace_id = p_workspace and a.deleted_at is null),
    'storage_bytes', (select coalesce(sum(a.size_bytes), 0) from public.media_assets a where a.workspace_id = p_workspace),
    'accounts_total', (select count(*) from public.social_accounts sa
                        where sa.workspace_id = p_workspace and sa.platform <> 'mock' and sa.status <> 'disconnected'),
    'accounts_by_platform', coalesce((select jsonb_object_agg(platform, n) from (
        select platform::text, count(*) as n from public.social_accounts sa
         where sa.workspace_id = p_workspace and sa.platform <> 'mock' and sa.status <> 'disconnected' group by platform) x), '{}'::jsonb)
  ) into v;
  return v;
end $$;

-- Convites: serializa a verificação de assentos (dois convites simultâneos não passam do limite).
create or replace function app.lock_seats()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_used bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('rf:seats:' || new.workspace_id::text, 0));
  select (select count(*) from public.workspace_members m where m.workspace_id = new.workspace_id)
       + (select count(*) from public.workspace_invitations i where i.workspace_id = new.workspace_id
             and i.accepted_at is null and i.revoked_at is null and i.expires_at > now())
    into v_used;
  if v_used + 1 > (app.workspace_limits(new.workspace_id) ->> 'seats')::bigint then
    perform app.limit_error('seats');
  end if;
  return new;
end $$;
create trigger workspace_invitations_lock_seats before insert on public.workspace_invitations
  for each row execute function app.lock_seats();

-- ---------------------------------------------------------------------------
-- Sessões de checkout (anti-duplicidade) e eventos da Stripe (idempotência)
-- ---------------------------------------------------------------------------
create table public.billing_checkout_sessions (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  plan              text not null,
  billing_interval  text not null check (billing_interval in ('month', 'year')),
  stripe_price_id   text not null,
  stripe_session_id text unique,
  url               text,
  status            text not null default 'creating' check (status in ('creating', 'open', 'completed', 'expired', 'failed')),
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default now() + interval '35 minutes'
);
-- No máximo UMA sessão em andamento por workspace (clique repetido / reenvio).
create unique index billing_checkout_one_open on public.billing_checkout_sessions (workspace_id)
  where status in ('creating', 'open');

create table public.billing_events (
  event_id     text primary key,               -- evt_… (Stripe)
  type         text not null,
  stripe_created timestamptz not null,
  livemode     boolean not null,
  workspace_id uuid references public.workspaces (id) on delete set null,
  object_id    text,                           -- sub_/cs_/in_ para diagnóstico (sem dados de cartão)
  status       text not null default 'processing' check (status in ('processing', 'processed', 'ignored', 'failed')),
  attempts     integer not null default 1,
  note         text,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);
create index billing_events_ws on public.billing_events (workspace_id, received_at desc);

alter table public.billing_checkout_sessions enable row level security;
alter table public.billing_events enable row level security;
revoke all on public.billing_checkout_sessions, public.billing_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Funções do servidor (service_role). Nenhuma é executável pelo navegador.
-- ---------------------------------------------------------------------------

-- Início do checkout: valida permissão, bloqueia duplicidade e decide o que fazer.
-- Retorna {action: 'manage'|'reuse'|'create', ...}.
create or replace function public.billing_begin_checkout(
  p_workspace uuid, p_user uuid, p_plan text, p_interval text, p_price text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions; c public.billing_checkout_sessions; v_id uuid;
begin
  if p_plan not in ('pro', 'business', 'premium') or p_interval not in ('month', 'year') then
    raise exception 'invalid plan' using errcode = '22023';
  end if;
  if not app.can_manage_billing(p_workspace, p_user) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  select * into s from public.subscriptions where workspace_id = p_workspace for update;
  if s.workspace_id is null then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  -- Já tem assinatura paga vigente: gerenciar (trocar/cancelar) em vez de comprar outra.
  if s.stripe_subscription_id is not null and s.provider_status in ('active', 'trialing', 'past_due', 'unpaid') then
    return jsonb_build_object('action', 'manage', 'customer_id', s.stripe_customer_id);
  end if;
  update public.billing_checkout_sessions set status = 'expired'
   where workspace_id = p_workspace and status in ('creating', 'open') and expires_at < now();
  -- Sessão em andamento: reaproveita (mesmo preço) ou recusa (outro preço, até expirar ou concluir).
  select * into c from public.billing_checkout_sessions where workspace_id = p_workspace and status in ('creating', 'open');
  if c.id is not null then
    if c.stripe_price_id = p_price and c.status = 'open' and c.url is not null then
      return jsonb_build_object('action', 'reuse', 'checkout_id', c.id, 'url', c.url);
    end if;
    if c.stripe_price_id <> p_price and c.status = 'open' and c.stripe_session_id is not null then
      return jsonb_build_object('action', 'replace', 'checkout_id', c.id, 'session_id', c.stripe_session_id);
    end if;
    raise exception 'checkout in progress' using errcode = '55P03';
  end if;
  insert into public.billing_checkout_sessions (workspace_id, plan, billing_interval, stripe_price_id, created_by)
  values (p_workspace, p_plan, p_interval, p_price, p_user) returning id into v_id;
  return jsonb_build_object('action', 'create', 'checkout_id', v_id, 'customer_id', s.stripe_customer_id);
end $$;

-- Vincula o cliente da Stripe ao workspace (uma vez; nunca troca por outro).
create or replace function public.billing_set_customer(p_workspace uuid, p_customer text)
returns void language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  select stripe_customer_id into v from public.subscriptions where workspace_id = p_workspace for update;
  if v is not null and v <> p_customer then raise exception 'customer mismatch' using errcode = '42501'; end if;
  update public.subscriptions set provider = 'stripe', stripe_customer_id = p_customer where workspace_id = p_workspace;
end $$;

create or replace function public.billing_checkout_update(
  p_checkout uuid, p_status text, p_session text default null, p_url text default null, p_expires_at timestamptz default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.billing_checkout_sessions
     set status = p_status,
         stripe_session_id = coalesce(p_session, stripe_session_id),
         url = coalesce(p_url, url),
         expires_at = coalesce(p_expires_at, expires_at)
   where id = p_checkout;
end $$;

-- Atualiza a sessão pelo id da Stripe (eventos checkout.session.*).
create or replace function public.billing_checkout_by_session(p_session text, p_status text)
returns void language sql security definer set search_path = '' as $$
  update public.billing_checkout_sessions set status = p_status
   where stripe_session_id = p_session and status in ('creating', 'open');
$$;

-- Idempotência: 'process' (processar), 'skip' (já tratado) ou 'busy' (outro worker está tratando).
create or replace function public.billing_event_begin(
  p_event text, p_type text, p_created timestamptz, p_livemode boolean, p_object text)
returns text language plpgsql security definer set search_path = '' as $$
declare e public.billing_events;
begin
  insert into public.billing_events (event_id, type, stripe_created, livemode, object_id)
  values (p_event, p_type, p_created, p_livemode, p_object)
  on conflict (event_id) do nothing;
  if found then return 'process'; end if;
  select * into e from public.billing_events where event_id = p_event for update;
  if e.status in ('processed', 'ignored') then return 'skip'; end if;
  if e.status = 'processing' and e.received_at > now() - interval '2 minutes' then return 'busy'; end if;
  update public.billing_events set status = 'processing', attempts = attempts + 1, received_at = now() where event_id = p_event;
  return 'process';
end $$;

create or replace function public.billing_event_finish(p_event text, p_status text, p_workspace uuid default null, p_note text default null)
returns void language sql security definer set search_path = '' as $$
  update public.billing_events
     set status = p_status, workspace_id = coalesce(p_workspace, workspace_id), note = left(p_note, 500),
         processed_at = case when p_status in ('processed', 'ignored') then now() else processed_at end
   where event_id = p_event;
$$;

-- Aplica o estado da assinatura LIDO DA STRIPE (nunca o enviado pelo navegador).
-- Retorna: 'applied' | 'stale' | 'duplicate' (outra assinatura já vigente) | 'pending' (ainda não paga).
create or replace function public.billing_apply_subscription(
  p_workspace uuid, p_customer text, p_subscription text, p_price text, p_plan text, p_interval text,
  p_provider_status text, p_period_end timestamptz, p_cancel_at_period_end boolean, p_observed_at timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare s public.subscriptions; v_paid boolean; v_old text;
begin
  if p_plan not in ('pro', 'business', 'premium') then raise exception 'invalid plan' using errcode = '22023'; end if;
  select * into s from public.subscriptions where workspace_id = p_workspace for update;
  if s.workspace_id is null then raise exception 'workspace not found' using errcode = 'P0002'; end if;
  -- O cliente da Stripe precisa ser o que ESTE workspace criou no checkout (não usa e-mail).
  if s.stripe_customer_id is null or s.stripe_customer_id <> p_customer then
    raise exception 'customer mismatch' using errcode = '42501';
  end if;
  v_paid := p_provider_status in ('active', 'trialing', 'past_due');
  -- Já existe OUTRA assinatura vigente neste workspace: não troca; o chamador cancela a nova.
  if s.stripe_subscription_id is not null and s.stripe_subscription_id <> p_subscription
     and s.provider_status in ('active', 'trialing', 'past_due') then
    return case when v_paid then 'duplicate' else 'stale' end;
  end if;
  -- Leitura mais antiga que a já aplicada (eventos concorrentes): ignora.
  if s.stripe_subscription_id = p_subscription and s.provider_synced_at is not null and p_observed_at < s.provider_synced_at then
    return 'stale';
  end if;
  -- Não paga: só rebaixa se o plano atual veio DESTA assinatura (fim de acesso). Caso contrário
  -- (pagamento pendente, checkout expirado, assinatura antiga) registra o estado e não mexe no plano —
  -- um workspace com outro plano (manual/legado) nunca é rebaixado por uma compra que não se concluiu.
  if not v_paid and not coalesce(s.stripe_subscription_id = p_subscription and s.provider_status in ('active', 'trialing', 'past_due'), false) then
    update public.subscriptions set provider = 'stripe', stripe_subscription_id = p_subscription, stripe_price_id = p_price,
           billing_interval = p_interval, provider_status = p_provider_status, provider_synced_at = p_observed_at
     where workspace_id = p_workspace;
    return 'pending';
  end if;
  v_old := s.plan;
  update public.subscriptions
     set provider = 'stripe',
         stripe_subscription_id = p_subscription,
         stripe_price_id = p_price,
         billing_interval = p_interval,
         provider_status = p_provider_status,
         current_period_end = p_period_end,
         cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
         provider_synced_at = p_observed_at,
         -- Pago (inclui atraso em carência): plano contratado. Encerrado (canceled/unpaid/expired): Starter.
         -- Nada é apagado: conteúdo, agendamentos e contas permanecem; só os limites voltam ao Starter.
         plan = case when v_paid then p_plan else 'starter' end,
         status = case when p_provider_status = 'past_due' then 'past_due' else 'active' end
   where workspace_id = p_workspace;
  if v_old is distinct from (case when v_paid then p_plan else 'starter' end) then
    perform app.audit(p_workspace, 'billing.plan_changed', 'subscription', p_subscription,
      jsonb_build_object('plan', jsonb_build_array(v_old, case when v_paid then p_plan else 'starter' end), 'provider_status', p_provider_status));
  end if;
  return 'applied';
end $$;

-- Workspace pelo cliente da Stripe (eventos de fatura/assinatura sem metadados confiáveis).
create or replace function public.billing_workspace_for_customer(p_customer text)
returns uuid language sql stable security definer set search_path = '' as $$
  select workspace_id from public.subscriptions where stripe_customer_id = p_customer
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.billing_begin_checkout(uuid, uuid, text, text, text)',
    'public.billing_set_customer(uuid, text)',
    'public.billing_checkout_update(uuid, text, text, text, timestamptz)',
    'public.billing_checkout_by_session(text, text)',
    'public.billing_event_begin(text, text, timestamptz, boolean, text)',
    'public.billing_event_finish(text, text, uuid, text)',
    'public.billing_apply_subscription(uuid, text, text, text, text, text, text, timestamptz, boolean, timestamptz)',
    'public.billing_workspace_for_customer(text)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
