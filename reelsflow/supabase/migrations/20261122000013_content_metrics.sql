-- ReelsFlow · Analytics de conteúdo (MVP) — métricas reais das redes, lidas da Zernio.
--
-- Só ACRESCENTA tabelas. Nada existente muda.
-- - social_posts: um registro por post da conta na rede (publicado pelo ReelsFlow ou fora dele),
--   com as métricas MAIS RECENTES (acumuladas na vida do post), exatamente como a Zernio informa.
-- - social_post_metrics_daily: uma "foto" por post e dia (UTC) das métricas acumuladas. É a base para
--   resultados DENTRO de um período (diferença entre fotos) e para o histórico — sem inventar curvas:
--   só existe histórico a partir do primeiro dia em que o ReelsFlow sincronizou.
-- - metrics_sync_state: controle da sincronização por conta (frequência, erro, escopo ausente).
-- Escrita: somente o worker (conexão de servidor). Navegador: somente leitura via RLS (membros).
-- Métrica ausente = NULL (exibida como "Indisponível"); nunca zero por padrão.

create table public.social_posts (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid not null references public.workspaces (id) on delete cascade,
  social_account_id       uuid not null references public.social_accounts (id) on delete cascade,
  platform                public.social_platform not null,
  provider                text not null default 'zernio' check (provider in ('zernio')),
  provider_post_id        text,                    -- id do post na Zernio
  platform_post_id        text not null,           -- id nativo na rede (ex.: media id do Instagram)
  permalink               text,
  published_at            timestamptz not null,
  origin                  text not null check (origin in ('reelsflow', 'external')),
  external_publication_id uuid references public.external_publications (id) on delete set null,
  media_asset_id          uuid references public.media_assets (id) on delete set null,
  provider_sync_status    text,                    -- syncStatus da Zernio (pending, synced, failed…)
  provider_sync_error     text,
  provider_synced_at      timestamptz,             -- lastSyncedAt da Zernio (frescor real do dado)
  views                   bigint check (views >= 0),
  reach                   bigint check (reach >= 0),
  impressions             bigint check (impressions >= 0),
  likes                   bigint check (likes >= 0),
  comments                bigint check (comments >= 0),
  shares                  bigint check (shares >= 0),
  saves                   bigint check (saves >= 0),
  engagement              bigint check (engagement >= 0),
  engagement_rate         numeric(9, 4),           -- percentual, definição da Zernio/plataforma
  follows                 bigint check (follows >= 0),
  profile_views           bigint check (profile_views >= 0),
  avg_watch_ms            bigint check (avg_watch_ms >= 0),
  total_watch_ms          bigint check (total_watch_ms >= 0),
  skip_rate               numeric(9, 4),
  completion_rate         numeric(9, 4),
  metrics_updated_at      timestamptz,             -- quando o ReelsFlow gravou estes valores
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (social_account_id, platform_post_id)
);
create index social_posts_ws_published_idx on public.social_posts (workspace_id, published_at desc);
create index social_posts_ext_pub_idx on public.social_posts (external_publication_id) where external_publication_id is not null;
create trigger social_posts_updated_at before update on public.social_posts
  for each row execute function app.set_updated_at();

create table public.social_post_metrics_daily (
  social_post_id   uuid not null references public.social_posts (id) on delete cascade,
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  day              date not null,                  -- dia UTC da foto
  captured_at      timestamptz not null default now(),
  views            bigint,
  reach            bigint,
  likes            bigint,
  comments         bigint,
  shares           bigint,
  saves            bigint,
  engagement       bigint,
  follows          bigint,
  profile_views    bigint,
  total_watch_ms   bigint,
  primary key (social_post_id, day)
);
create index social_post_metrics_daily_ws_idx on public.social_post_metrics_daily (workspace_id, day);

create table public.metrics_sync_state (
  social_account_id uuid primary key references public.social_accounts (id) on delete cascade,
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  status            text not null default 'pending'
                    check (status in ('pending', 'ok', 'needs_analytics_scope', 'rate_limited', 'error', 'not_supported')),
  last_run_at       timestamptz,
  last_success_at   timestamptz,
  next_run_at       timestamptz not null default now(),
  last_error        text,
  posts_seen        integer not null default 0,
  updated_at        timestamptz not null default now()
);
create trigger metrics_sync_state_updated_at before update on public.metrics_sync_state
  for each row execute function app.set_updated_at();

alter table public.social_posts enable row level security;
alter table public.social_post_metrics_daily enable row level security;
alter table public.metrics_sync_state enable row level security;
revoke all on public.social_posts, public.social_post_metrics_daily, public.metrics_sync_state from anon, authenticated;
grant select on public.social_posts, public.social_post_metrics_daily, public.metrics_sync_state to authenticated;
create policy social_posts_select on public.social_posts for select to authenticated using (app.has_role(workspace_id, 'viewer'));
create policy social_post_metrics_daily_select on public.social_post_metrics_daily for select to authenticated using (app.has_role(workspace_id, 'viewer'));
create policy metrics_sync_state_select on public.metrics_sync_state for select to authenticated using (app.has_role(workspace_id, 'viewer'));
