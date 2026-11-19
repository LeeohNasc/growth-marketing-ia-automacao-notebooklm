# ReelsFlow

> "Seus vídeos. Suas regras. Tudo no automático."

SaaS de upload em massa e publicação automática e recorrente de vídeos curtos (Instagram Reels, Facebook Reels, TikTok, YouTube Shorts) usando **exclusivamente APIs oficiais**.

## Status atual

| Item | Estado |
|---|---|
| Fase 0 — Auditoria e planejamento | **Concluída (aguardando aprovação)** |
| Código de aplicação | Não iniciado (proposital — ver regra 12 do prompt mestre) |
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

## Stack proposta (resumo)

Next.js (App Router) + TypeScript strict + Tailwind + shadcn/ui · Supabase (Auth, Postgres com RLS, Storage) · Worker Node.js separado (fila em Postgres com lease) · ffmpeg/ffprobe no worker · Vitest + Playwright.

## Observação sobre o repositório

Este diretório vive temporariamente dentro do repositório `growth-marketing-ia-automacao-notebooklm`, que é um projeto de estudo sem relação com o ReelsFlow. **Recomendação:** mover para um repositório dedicado antes da Fase 1 (`git mv` / `git subtree split` preservam o histórico).
