# Modelo de dados — ReelsFlow

Versão 0.1 · Fase 0 · PostgreSQL (Supabase). Schema definitivo será criado por migrations versionadas em `supabase/migrations/` na Fase 1.

## 1. Convenções
- PK `id uuid default gen_random_uuid()`; `created_at`, `updated_at timestamptz`.
- Toda tabela de domínio tem `workspace_id uuid not null` (desnormalizado de propósito: simplifica RLS e índices).
- Soft delete (`deleted_at`) apenas onde há dependência histórica (`media_assets`, `social_accounts`, `campaigns`).
- Enums Postgres para estados; mudanças de enum via migration.
- `users` = `auth.users` (Supabase) + `public.profiles` 1:1.

## 2. Entidades

### Identidade e tenancy
| Tabela | Colunas principais | Notas |
|---|---|---|
| `profiles` | `id` (= auth.users.id), `display_name`, `locale`, `default_timezone` | Criado por trigger no signup |
| `workspaces` | `name`, `slug` unique, `created_by` (nullable, set null), `default_timezone`, `is_demo bool`, `queue_paused bool`, `settings jsonb` (defaults globais) | |
| `workspace_members` | `workspace_id`, `user_id`, `role` (`owner/admin/editor/viewer`) | unique (workspace_id, user_id) |

### Contas sociais
| Tabela | Colunas principais | Notas |
|---|---|---|
| `social_accounts` | `platform`, `external_account_id`, `display_name`, `avatar_url`, `status` (`active/needs_reauth/disconnected`), `paused bool`, `settings jsonb` (defaults da conta), `token_expires_at` | unique (workspace_id, platform, external_account_id) |
| `social_account_tokens` | `social_account_id` PK, `ciphertext bytea`, `iv`, `auth_tag`, `key_version int`, `scopes text[]` | **Sem policy para `authenticated`** — só service role (worker/servidor) |
| `social_account_capabilities` | `social_account_id`, `capability` (ex.: `reels_publish`), `granted bool`, `details jsonb`, `checked_at` | |
| `platform_quota_usage` | `social_account_id`, `window_start`, `used`, `limit`, `source` (`api/local`) | Contabiliza cotas tipo "publicações/24 h" |

### Mídia
| Tabela | Colunas principais | Notas |
|---|---|---|
| `upload_sessions` | `user_id`, `filename`, `size_bytes`, `sha256`, `storage_path`, `status` (`pending/uploading/completed/failed/cancelled`), `expires_at` | Limpeza periódica das expiradas |
| `media_assets` | `name`, `storage_path`, `size_bytes`, `sha256`, `mime`, `duration_ms`, `width`, `height`, `aspect_ratio`, `video_codec`, `audio_codec`, `fps`, `thumbnail_path`, `status` (`uploaded/processing/ready/failed`), `compatibility jsonb` (por plataforma: ok/erros), `default_caption`, `default_hashtags text[]`, `overrides jsonb`, `deleted_at` | índice (workspace_id, sha256) — duplicado = aviso |
| `media_variants` | `media_asset_id`, `kind` (`transcoded/thumbnail`), `target_platform`, `storage_path`, `specs jsonb` | Pós-MVP para transcodificação |
| `collections` / `collection_items` | `name` · (`collection_id`, `media_asset_id`, `position`) | Pastas/coleções |

### Agendamento
| Tabela | Colunas principais | Notas |
|---|---|---|
| `publication_templates` | `name`, `mode` (`mirrored/independent`), `schedule jsonb` (weekdays, times, per_day, timezone), `caption_template`, `hashtags text[]`, `order_strategy`, `per_platform jsonb` | Limite de quantidade aplicado por plano |
| `campaigns` | `template_id` (nullable — cópia congelada em `config jsonb`), `name`, `status` (`draft/active/paused/completed/archived`), `start_date`, `end_date`, `timezone`, `random_seed bigint`, `max_lateness interval`, `overrides jsonb` | Campanha não muda se o modelo for editado depois (cópia) |
| `campaign_targets` | `campaign_id`, `social_account_id`, `schedule jsonb` (modo independente), `time_offset interval`, `overrides jsonb`, `enabled` | |
| `campaign_media` | `campaign_id`, `media_asset_id`, `position int`, `target_id` (null no modo espelhado), `overrides jsonb` | |
| `publication_jobs` | ver §3 | coração da fila |
| `publication_attempts` | `job_id`, `attempt_no`, `worker_id`, `started_at`, `finished_at`, `phase_reached`, `outcome`, `error_class`, `error_code`, `error_message` (sanitizado), `http_status`, `checkpoint jsonb`, `rate_limit_info jsonb` | Imutável |
| `external_publications` | `job_id` unique, `platform`, `external_id`, `permalink`, `published_at`, `raw_status jsonb` | Registro do resultado; nunca apagado com o vídeo |

### Operação, produto e conformidade
| Tabela | Colunas principais | Notas |
|---|---|---|
| `automation_rules` | `rule_key` (5 regras pré-definidas), `enabled`, `params jsonb` | |
| `automation_runs` | `rule_id`, `trigger_ref`, `action`, `result`, `created_at` | Auditoria das automações |
| `notifications` | `user_id` (null = todos do workspace), `type`, `payload jsonb`, `read_at`, `email_status` | |
| `audit_logs` | `actor_id` (null = sistema), `action`, `entity`, `entity_id`, `diff jsonb`, `ip_hash` | Append-only |
| `subscriptions` | `plan` (`starter/pro/agency`), `status`, `limits jsonb`, `provider_ref` (null até haver cobrança) | |
| `usage_records` | `metric` (`storage_bytes/uploads/publications/accounts/ai_tokens/processing_seconds`), `quantity`, `period_start` | |
| `worker_heartbeats` | `worker_id`, `last_seen_at`, `version` | Sem workspace_id; sem acesso do cliente |

### Regras de integridade implementadas na Fase 1
- Propriedade é definida por `workspace_members.role = 'owner'` (não por coluna em `workspaces`). `created_by` é só histórico.
- Trigger `guard_last_owner`: um workspace com outros membros nunca fica sem owner (rebaixamento, saída, remoção ou exclusão da conta do último owner são recusados).
- Trigger `cleanup_empty_workspace`: quando o último membro sai (ou tem a conta excluída), o workspace é apagado.
- Workspaces só são criados pela RPC `create_workspace` (exige e-mail confirmado), que cria membership owner + assinatura starter + auditoria na mesma transação.
- Grants por coluna: o cliente só altera `name/default_timezone/queue_paused/settings` (workspaces), `display_name/locale/default_timezone` (profiles) e `role` (members).

### Desvios do modelo original, adotados na Fase 2
- **`upload_sessions` não existe**: o vídeo é registrado em `media_assets` com `status = 'uploading'` desde o início do envio (`upload_expires_at` controla abandono). Uma tabela a menos e um só identificador do começo ao fim.
- **`media_jobs`**: fila técnica do worker (probe/thumbnail e purge), separada de `publication_jobs` (Fase 3), com lease, tentativas e backoff.
- **`storage_gc`**: prefixos de storage a apagar após exclusão de workspace — sem FK, para sobreviver à cascata.
- **Storage**: bucket privado `media`; caminho `{workspace_id}/{media_id}/original.{ext}` e `thumb.jpg`. O cliente só grava em caminhos pré-registrados por `begin_media_upload` e ainda em `uploading`; não altera nem apaga objetos.

## 3. `publication_jobs`

```sql
create type job_status as enum (
  'draft','scheduled','queued','preparing','uploading','processing_remote',
  'publishing','published','failed_retryable','failed_permanent',
  'uncertain','needs_review','cancelled');

create table publication_jobs (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id),
  campaign_id      uuid references campaigns(id),
  campaign_media_id uuid references campaign_media(id),
  target_id        uuid references campaign_targets(id),
  social_account_id uuid not null references social_accounts(id),
  media_asset_id   uuid references media_assets(id),   -- null se o vídeo for removido; histórico mantido
  post_group_id    uuid,                                -- modo espelhado
  local_date       date not null,
  local_time       time not null,
  timezone         text not null,
  scheduled_at     timestamptz not null,
  dst_adjusted     boolean not null default false,
  status           job_status not null default 'draft',
  effective_config jsonb,                               -- snapshot ao entrar em preparing
  caption_override text,
  attempt_count    int not null default 0,
  max_attempts     int not null default 6,
  next_attempt_at  timestamptz not null default now(),
  lease_owner      text,
  lease_expires_at timestamptz,
  external_checkpoint jsonb,                            -- container_id, video_id, upload offset...
  last_error_class text,
  last_error_message text,
  published_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- impede duplicidade acidental do mesmo vídeo na mesma conta/campanha
create unique index uq_job_media_target_active on publication_jobs (campaign_id, target_id, media_asset_id)
  where status <> 'cancelled';

-- claim do worker
create index ix_jobs_claim on publication_jobs (next_attempt_at)
  where status in ('queued','failed_retryable');
-- promoção pelo scheduler
create index ix_jobs_due on publication_jobs (scheduled_at) where status = 'scheduled';
-- reaper
create index ix_jobs_lease on publication_jobs (lease_expires_at)
  where status in ('preparing','uploading','processing_remote','publishing');
-- calendário/fila na UI
create index ix_jobs_ws_time on publication_jobs (workspace_id, scheduled_at);
create index ix_jobs_account_time on publication_jobs (social_account_id, scheduled_at);
```

Trigger `enforce_job_transition` rejeita transições fora da tabela permitida (mesma tabela de `packages/domain`).

## 4. RLS

Funções auxiliares (`security definer`, `stable`, `search_path` fixo):

```sql
create function app.has_role(ws uuid, min_role text) returns boolean ...
-- true se auth.uid() é membro do workspace com papel >= min_role
-- ordem: viewer < editor < admin < owner
```

Padrão por tabela de domínio:

| Operação | Regra |
|---|---|
| select | `app.has_role(workspace_id, 'viewer')` |
| insert/update | `app.has_role(workspace_id, 'editor')` (contas sociais, membros, settings: `admin`) |
| delete | `admin`; `workspaces`: só `owner` |

Exceções:
- `social_account_tokens`, `worker_heartbeats`, `platform_quota_usage`: **RLS habilitado sem policies para `authenticated`** → só service role.
- `publication_attempts`, `audit_logs`, `automation_runs`: select para membros; sem insert/update/delete pelo cliente (escritos pelo worker/servidor).
- Colunas operacionais de `publication_jobs` (`lease_*`, `attempt_count`, `external_checkpoint`) não são alteráveis pelo cliente: updates do usuário passam por funções RPC (`reschedule_job`, `cancel_job`) que validam estado e escrevem auditoria.

**Storage:** bucket `media` privado; policy em `storage.objects` usando o primeiro segmento do caminho (`workspace_id`) com `app.has_role(...)`. Leitura para reprodução via URL assinada de curta duração gerada no servidor.

**Testes de RLS (obrigatórios na Fase 1):** usuário A e B, workspaces WA e WB; cada tabela é testada para select/insert/update/delete cruzado; storage testado com download e upload no caminho do outro workspace.

## 5. Retenção (proposta, a validar juridicamente)
| Dado | Retenção |
|---|---|
| `upload_sessions` expiradas | 7 dias |
| Arquivos de vídeo de mídia excluída | removidos do storage em até 30 dias (janela de desfazer) |
| `publication_attempts` | 180 dias |
| `audit_logs` | 1 ano |
| Exclusão de conta/workspace | dados pessoais e arquivos removidos; registros agregados anonimizados |
