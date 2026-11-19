# Arquitetura — ReelsFlow

Versão 0.1 · Fase 0

## 1. Visão geral

```
┌──────────────┐   TUS (resumable, JWT do usuário)   ┌─────────────────────┐
│  Navegador   │ ──────────────────────────────────▶ │  Supabase Storage   │ (bucket privado)
│  Next.js UI  │                                     └─────────▲───────────┘
└──────┬───────┘                                               │ service role
       │ HTTPS (cookies de sessão)                             │
┌──────▼───────────────────┐   SQL (RLS como usuário)  ┌───────┴─────────────┐
│ Next.js na Vercel        │ ────────────────────────▶ │ Supabase Postgres   │
│ Server Components,       │                           │ RLS · fila · auditoria│
│ Server Actions, Route    │                           └───────▲─────────────┘
│ Handlers (OAuth callback)│                                   │ SQL (service role, SKIP LOCKED)
└──────────────────────────┘                           ┌───────┴─────────────┐
                                                       │ Worker Node.js      │ processo contínuo
                                                       │ · scheduler tick    │ (container fora da Vercel)
                                                       │ · media (ffprobe)   │
                                                       │ · publisher         │──▶ Meta / TikTok / YouTube
                                                       │ · reconciler/reaper │
                                                       └─────────────────────┘
```

Princípio: **a Vercel só serve UI e requisições curtas.** Tudo que é longo, recorrente ou depende de rede externa lenta (probe de vídeo, envio de mídia, polling de status) roda no worker.

## 2. Estrutura do repositório (monorepo pnpm)

```
reelsflow/
  apps/
    web/                 Next.js (App Router)
      app/(auth)/ app/(app)/w/[workspace]/...
      components/ui/     shadcn/ui
      lib/supabase/      clientes server/browser (sem service role no browser)
    worker/              Node.js + TypeScript
      src/scheduler/ src/media/ src/publisher/ src/reconciler/ src/reaper/
  packages/
    domain/              regras puras: slots, precedência, máquina de estados, validação Zod
    connectors/          interface comum + mock + meta-instagram + meta-facebook + tiktok + youtube
    db/                  tipos gerados do Supabase, queries compartilhadas
    config/              tsconfig, eslint, tailwind preset
  supabase/
    migrations/          SQL versionado (única fonte de verdade do schema)
    tests/               testes de RLS
    seed.sql             apenas dados do workspace demo
  docs/
```

`packages/domain` não importa nada de rede, banco ou framework — é onde fica a lógica mais crítica e a mais testada.

## 3. Decisões técnicas (ADRs)

| # | Decisão | Alternativas consideradas | Motivo / trade-off |
|---|---|---|---|
| ADR-01 | Worker separado em container de execução contínua | Vercel Cron + funções; Supabase Edge Functions + pg_cron | Funções serverless têm limite de duração/memória incompatível com ffprobe em arquivos grandes, uploads longos e polling. Custo: mais um serviço para operar. |
| ADR-02 | Fila própria em Postgres (`publication_jobs` com lease) | pg-boss, graphile-worker, Redis/BullMQ | O job de publicação tem estados de domínio (incerto, reconciliação, checkpoints externos) que uma fila genérica não modela; Postgres já existe e dá transação única entre estado e fila. Trade-off: escrevemos e testamos lease/retry nós mesmos. Para jobs técnicos simples (probe de mídia) pode-se reavaliar pg-boss. |
| ADR-03 | Upload TUS direto ao Supabase Storage | Upload via Route Handler; S3/R2 com presigned multipart | TUS é resumível e suportado pelo Supabase; evita trafegar arquivos pelo Next.js. **Pendente:** limite de tamanho por arquivo do plano (ver §9) e custo de egress — R2 é alternativa se egress pesar. |
| ADR-04 | Jobs materializados (uma linha por publicação prevista) | Calcular slots "on the fly" a cada tick | Materializar permite calendário, edição pontual, auditoria e status independente por item. Volume é baixo (milhares de linhas por workspace). |
| ADR-05 | Snapshot das configurações efetivas no job ao entrar em `preparing` | Resolver sempre na hora | Evita alteração silenciosa depois que o envio começou; antes disso a edição continua refletindo. |
| ADR-06 | Datas guardadas como `local_date + local_time + timezone` **e** `scheduled_at timestamptz` | Só UTC | Permite recalcular corretamente se regras de fuso mudarem e mostrar exatamente o que o usuário escolheu. |
| ADR-07 | Criptografia de tokens na aplicação (AES-256-GCM, chave fora do banco) | Supabase Vault; texto puro protegido só por RLS | Vazamento do banco sozinho não expõe tokens. Trade-off: rotação de chave é responsabilidade nossa (campo `key_version`). |
| ADR-08 | Regras de automação pré-definidas no MVP | Motor genérico configurável | Menor superfície de erro; o genérico só se justifica com demanda observada. |
| ADR-09 | IA fora do caminho crítico | — | Publicação não pode depender de serviço de IA. |
| ADR-10 | Plano calculado na aplicação (packages/domain), gravado por RPC que revalida | Plano em PL/pgSQL | Regras de fuso/DST testáveis em TypeScript com Temporal; o banco garante propriedade, horários futuros e não duplicidade. Trade-off: duas camadas a manter coerentes. |
| ADR-11 | Janela de congelamento de 2 min (não 10 min) | 10 min | Permite testar com o conector simulado em minutos; revisar para conectores reais, cujo preparo (container IG) exige antecedência. |
| ADR-12 | Reagendamento manual "fixa" a publicação | Recalcular tudo | Recalcular não desfaz decisões do usuário; custo: um slot pode ficar com duas publicações (o espaçamento resolve e o conflito é mostrado). |
| ADR-13 | No máximo uma publicação em andamento por conta, garantida por índice único | Só lógica no claim | Defesa em profundidade contra condições de corrida. |

## 4. Motor de agendamento

### 4.1 Modelo conceitual
- **Campanha** → conjunto de **alvos** (`campaign_targets`: uma conta social + configuração por alvo).
- **Itens da campanha** (`campaign_media`): vídeos com `position`.
- **Slots**: gerados a partir da regra (dias da semana × horários × fuso, entre início e fim opcional).
- **Job** (`publication_jobs`): (item × alvo × slot). Status independente.

**Modo espelhado:** um "post lógico" (`post_group_id`) por slot; o mesmo vídeo gera um job por alvo, cada alvo podendo ter deslocamento de horário próprio.
**Modo filas independentes:** cada alvo tem sua própria lista ordenada e sua própria regra de horários; não há `post_group_id` compartilhado.

### 4.2 Geração de slots (função pura em `packages/domain`)
```
generateSlots(rule, fromInstant, count | untilDate) -> Slot[]
  rule = { timezone, weekdays[], times["09:00","13:00","19:00"], perDay, startDate, endDate? }
```
- Iteração em **datas locais** no fuso da regra; conversão para instante com biblioteca de fuso (Temporal polyfill ou Luxon — escolha fixada na Fase 3 após checar versão estável).
- **Horário inexistente** (avanço do relógio no DST): desloca para o primeiro instante válido seguinte e marca `dst_adjusted = true`.
- **Horário ambíguo** (retrocesso): usa a primeira ocorrência.
- Slots com instante ≤ `now + lead_time` são descartados (bloqueio de passado).
- Obs.: `America/Sao_Paulo` não tem horário de verão desde 2019, mas o motor precisa tratar outros fusos e eventual reintrodução — a base IANA é a fonte, nunca offsets fixos.

### 4.3 Atribuição de vídeos
- Ordem: `upload_order | oldest | newest | manual | random(seed)`. A semente é persistida na campanha → reprocessar gera a mesma sequência.
- Vídeos incompatíveis com um alvo são pulados **para aquele alvo** e listados na revisão (não silenciosamente).
- Duplicidade: restrição única `(campaign_id, target_id, media_id)` enquanto status não for `cancelled`.

### 4.4 Edição e recálculo
- Só jobs em `draft | scheduled | needs_review` com `scheduled_at > now + freeze_window` (padrão 10 min, configurável) são editáveis.
- Reordenar/remover recalcula **apenas** os jobs posteriores ao ponto alterado, na mesma campanha e alvo.
- Jobs em execução ou concluídos nunca são alterados por recálculo.
- Toda alteração gera registro em `audit_logs`.

### 4.5 Pausas
Pausa é **flag** (campanha, conta social, workspace), não mudança de status dos jobs. O scheduler filtra. Retomar: jobs cujo horário passou durante a pausa seguem a política de atraso (§4.7).

### 4.6 Ciclo do worker

```
scheduler tick (a cada 30 s):
  promove scheduled → queued  onde scheduled_at <= now + prep_lead
    e campanha ativa e conta ativa e workspace não pausado

claim (cada worker):
  UPDATE publication_jobs SET status = 'preparing', lease_owner = $worker,
         lease_expires_at = now() + interval '5 min', attempt_count = attempt_count + 1
  WHERE id IN (SELECT id FROM publication_jobs
               WHERE status IN ('queued','failed_retryable') AND next_attempt_at <= now()
               ORDER BY scheduled_at
               FOR UPDATE SKIP LOCKED LIMIT $n)
  RETURNING *;

execução (por job):
  cria publication_attempts(attempt_no)
  fase → persiste checkpoint externo (container_id / video_id / upload offset) ANTES de prosseguir
  heartbeat a cada 60 s estende lease
  resultado → transição validada (§4.8)

reaper (a cada 60 s):
  lease expirado:
    se nenhum efeito externo iniciado → volta a 'queued'
    senão → 'uncertain' → reconciler

reconciler:
  consulta a plataforma pelo checkpoint salvo (ex.: status do container IG)
  publicado → 'published'; não recebido → 'failed_retryable'; indeterminável → 'needs_review'
```

### 4.7 Política de atraso e espaçamento
- `max_lateness` por campanha (padrão 2 h): se `now − scheduled_at` exceder, job vai para `needs_review` — evita publicar 20 vídeos de uma vez após indisponibilidade.
- `min_spacing` por conta (padrão 30 min): o claim não pega um job de uma conta que publicou há menos que isso.
- Cotas por plataforma (ex.: limite de publicações em 24 h do Instagram) consultadas/contabilizadas por conta; sem cota → `failed_retryable` com `next_attempt_at` no fim da janela.

### 4.8 Máquina de estados

```
draft ──activate──▶ scheduled ──tick──▶ queued ──claim──▶ preparing ─▶ uploading ─▶ processing_remote ─▶ publishing ─▶ published
                        │                  │                  │             │                │                 │
                        │                  │                  └─────────────┴────────────────┴─────────────────┤
                        │                  │                                        erro transitório / rate limit ▼
                        │                  │                                                   failed_retryable ──(backoff)──▶ queued
                        │                  │                                        erro permanente / tentativas esgotadas ▼
                        │                  │                                                   failed_permanent (DLQ)
                        │                  │                                        timeout após efeito externo ▼
                        │                  │                                                   uncertain ──reconcile──▶ published | failed_retryable | needs_review
                        ├──late────────────┴──────────────────────────────────────────────▶ needs_review ──user──▶ scheduled | cancelled
                        └──user─────────────────────────────────────────────────────────────▶ cancelled
```

Transições são validadas em `packages/domain` **e** por trigger no banco (defesa em profundidade). Estados terminais: `published`, `failed_permanent`, `cancelled`.

### 4.9 Retry
- Backoff exponencial com jitter: base 60 s, fator 2, teto 1 h, máximo 6 tentativas (configurável).
- `Retry-After` e cabeçalhos de uso da plataforma têm precedência sobre o backoff calculado.
- **Timeout não é falha**: se a requisição que causa efeito externo expira, o job vai para `uncertain`, nunca direto para retry.
- Sem garantia de exatamente-uma-vez onde a plataforma não oferece idempotência nem consulta de estado (ver API_INTEGRATIONS). Garantia real: **no máximo uma tentativa ativa por job** + reconciliação antes de repetir.

## 5. Mídia
1. Cliente calcula SHA-256 (streaming em Web Worker) → `POST upload_sessions` (server action) checa duplicado e cota → retorna caminho `workspace_id/media_id/original.ext`.
2. Upload TUS direto ao bucket privado.
3. Conclusão → `media_assets.status = 'uploaded'` → job técnico de probe.
4. Worker baixa (ou faz range read), roda `ffprobe`, gera thumbnail com `ffmpeg`, grava metadados, calcula compatibilidade por plataforma a partir de uma **tabela de especificações versionada** (`packages/connectors/*/spec.ts`), preenchida a partir da documentação oficial no momento da implementação.
5. Transcodificação para variantes (`media_variants`) fica para depois; o MVP marca incompatibilidade e explica o motivo.

Entrega às plataformas:
- Instagram exige URL acessível publicamente → URL assinada de curta duração do storage.
- Facebook, TikTok, YouTube → envio de bytes pelo worker (upload em partes/retomável) para não depender de verificação de domínio.

## 6. Conectores

```ts
interface SocialConnector {
  platform: Platform;
  beginAuth(ctx): { url; state; codeVerifier? };
  completeAuth(ctx, code, state): TokenSet;
  listAccounts(token): ExternalAccount[];
  getCapabilities(account, token): Capabilities;      // permissões, cotas, privacidade permitida
  validateMedia(meta: MediaMeta, target): ValidationResult;
  publish(job: PreparedJob, io: CheckpointIO): PublishResult;  // grava checkpoints via io
  getStatus(checkpoint): RemoteStatus;                 // usado pelo reconciler
  refreshToken(token): TokenSet;
  revoke(token): void;
  classifyError(err): 'transient' | 'rate_limited' | 'auth' | 'permanent' | 'unknown';
  fetchMetrics?(externalId, token): Metrics;           // só quando autorizado
}
```

`MockConnector` com injeção de falhas configurável (sucesso, transitório, permanente, timeout antes/depois do efeito, rate limit, token revogado, resultado incerto) é o que valida a Fase 3 inteira.

## 7. Observabilidade
- Logs estruturados JSON (pino) com `job_id`, `attempt_no`, `platform`, nunca tokens nem URLs assinadas.
- Sentry (plano gratuito, sujeito a autorização) em web e worker.
- Métricas de fila expostas em tabela/visão: jobs por status, idade do job mais antigo em `queued`, taxa de `uncertain`.
- Health check do worker: heartbeat em `worker_heartbeats`; alerta interno se ausente > 2 min.

## 8. Testes
| Camada | Ferramenta | Foco |
|---|---|---|
| Domínio | Vitest | slots, DST, precedência, ordem aleatória determinística, máquina de estados |
| Banco | Supabase CLI local + pgTAP ou Vitest com JWTs | RLS, isolamento de workspace, triggers de transição |
| Worker | Vitest + Postgres real + MockConnector | concorrência entre 2+ workers, lease, reaper, reconciliação |
| E2E | Playwright | fluxo principal, upload interrompido/retomado |

Observação do ambiente atual: Docker não está disponível neste container, o que impede `supabase start` aqui. Alternativas: projeto Supabase de desenvolvimento dedicado (gratuito) ou Postgres via serviço de CI. Decisão na Fase 1.

## 9. Infraestrutura mínima e custos estimados

Valores aproximados, **não verificados nesta fase** — confirmar nas páginas de preço antes de contratar.

| Componente | Desenvolvimento | Produção inicial | Observação |
|---|---|---|---|
| Vercel | Hobby (grátis) | Pro (~US$ 20/mês) | O plano Hobby é para uso pessoal/não comercial; SaaS cobrando clientes exige Pro. |
| Supabase | Free | Pro (~US$ 25/mês) | No Free, o limite de tamanho por arquivo é baixo (dezenas de MB) — insuficiente para vídeos reais. Pro inclui mais storage/egress com cobrança por excedente. |
| Worker | Local | Railway / Fly.io / Render / VPS (~US$ 5–10/mês) | 1 GB de RAM recomendado por causa do ffmpeg. |
| Sentry | Free | Free/Team | — |
| Domínio | — | ~US$ 10–15/ano | Necessário para URLs de política de privacidade/OAuth e App Review. |

Ordem de grandeza de volume (exemplo, não previsão): 100 vídeos de 50 MB = 5 GB armazenados; publicando cada um em 4 redes, ~20 GB de saída (download pelo worker ou pela plataforma). Egress é o custo que mais cresce — por isso R2 (sem cobrança de egress) fica como alternativa registrada no ADR-03.

**Custo mínimo para operar com clientes reais: ~US$ 50–60/mês** antes de qualquer escala. Nada será contratado sem autorização.
