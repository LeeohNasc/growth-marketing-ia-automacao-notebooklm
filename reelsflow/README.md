# ReelsFlow

> "Seus vídeos. Suas regras. Tudo no automático."

SaaS de upload em massa e publicação automática e recorrente de vídeos curtos (Instagram Reels, Facebook Reels, TikTok, YouTube Shorts) usando **exclusivamente APIs oficiais**.

## Status atual

| Item | Estado |
|---|---|
| Fase 0 — Auditoria e planejamento | Concluída e aprovada |
| Fase 1 — Fundação | Concluída no código — ver [docs/PHASE-1.md](docs/PHASE-1.md) |
| Fase 2 — Biblioteca | **Concluída no código (aguardando aprovação)** — ver [docs/PHASE-2.md](docs/PHASE-2.md) |
| Projeto Supabase | **Não criado** (requer sua autorização) — auth real ainda não exercitado |
| Integrações externas | Nenhuma conectada ou testada |
| Infraestrutura | Nenhum serviço criado, nenhum custo assumido |

Legenda usada em toda a documentação:

- **Implementado** — código existe e tem testes passando.
- **Simulado** — funciona contra o conector mock.
- **Bloqueado** — depende de credenciais, App Review, auditoria ou decisão do responsável.
- **Validado em produção** — executado com contas reais autorizadas.

## Documentação

| Documento | Conteúdo |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Produto, personas, requisitos, mapa de telas, critérios de aceitação |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Arquitetura, motor de agendamento, workers, decisões (ADRs), infraestrutura e custos |
| [docs/DATABASE.md](docs/DATABASE.md) | Modelo de dados, estados, índices, RLS |
| [docs/API_INTEGRATIONS.md](docs/API_INTEGRATIONS.md) | Meta (Instagram/Facebook), TikTok, YouTube — fatos verificados e pendências |
| [docs/SECURITY.md](docs/SECURITY.md) | Ameaças, controles, tokens, LGPD |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Fases, entregáveis e critérios de saída |
| [docs/RISKS.md](docs/RISKS.md) | Riscos técnicos, operacionais, jurídicos e decisões pendentes |

## Como rodar

Requisitos: Node 22, pnpm 10, Postgres 16 (só para os testes de RLS locais).

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local   # preencha com o projeto Supabase
pnpm dev                                       # http://localhost:3000

pnpm typecheck && pnpm lint                    # TypeScript strict + ESLint
pnpm test                                      # regras de domínio (Vitest)
pnpm test:db                                   # migrations + RLS + integração do worker (Postgres efêmero, ffmpeg)
pnpm build && pnpm test:e2e                    # build + Playwright (desktop e mobile)
```

Worker: `cp apps/worker/.env.example apps/worker/.env` e `pnpm --filter @reelsflow/worker start` (requer ffmpeg). Imagem: `apps/worker/Dockerfile`.

Aplicar o schema num projeto Supabase: `supabase link` + `supabase db push` (aplica `supabase/migrations/`).
Configuração do Auth no painel do Supabase: **Site URL** = `NEXT_PUBLIC_SITE_URL`; **Redirect URLs** incluindo `<site>/auth/confirm`; confirmação de e-mail ativada.

## Estrutura

```
apps/web/            Next.js 16 (App Router, proxy.ts), Tailwind 4, componentes no padrão shadcn/ui
apps/worker/         processo contínuo: fila de mídia (lease/retry), ffprobe/ffmpeg, limpeza de storage
packages/domain/     regras puras (papéis, validação Zod) — testadas
supabase/migrations/ schema versionado (única fonte de verdade)
supabase/tests/      testes de RLS (Vitest + pg) e shim mínimo do Supabase
scripts/test-db.sh   sobe Postgres efêmero, aplica migrations e roda os testes
```

## Stack proposta (resumo)

Next.js (App Router) + TypeScript strict + Tailwind + shadcn/ui · Supabase (Auth, Postgres com RLS, Storage) · Worker Node.js separado (fila em Postgres com lease) · ffmpeg/ffprobe no worker · Vitest + Playwright.

## Observação sobre o repositório

Este diretório vive temporariamente dentro do repositório `growth-marketing-ia-automacao-notebooklm`, que é um projeto de estudo sem relação com o ReelsFlow. **Recomendação:** mover para um repositório dedicado antes da Fase 1 (`git mv` / `git subtree split` preservam o histórico).
