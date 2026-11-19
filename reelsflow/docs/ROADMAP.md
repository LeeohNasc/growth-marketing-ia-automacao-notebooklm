# Roadmap — ReelsFlow

Cada fase termina com relatório (implementado, arquivos, testes, resultados, pendências, riscos, próxima fase) e **aguarda aprovação** antes da seguinte.

## Fase 0 — Auditoria e planejamento ✅ aprovada
Entregáveis: README, PRD, ARCHITECTURE, DATABASE, API_INTEGRATIONS, SECURITY, ROADMAP, RISKS.

## Fase 1 — Fundação ✅ concluída no código (aguardando aprovação; ver PHASE-1.md)
- Monorepo pnpm (`apps/web`, `apps/worker`, `packages/*`), TypeScript strict, ESLint, Prettier, CI (typecheck, lint, test, varredura de segredos).
- Next.js App Router + Tailwind + shadcn/ui; tema grafite/coral, dark padrão, light opcional.
- Supabase: projeto de desenvolvimento (**requer sua autorização para criar**); migrations de `profiles`, `workspaces`, `workspace_members`, `audit_logs`, `notifications`, `subscriptions`, `usage_records`.
- Auth completo (cadastro, login, confirmação, recuperação, logout, perfil, exclusão).
- Onboarding de workspace; layout com menu lateral responsivo; dashboard com estados vazios reais.

**Critério de saída:** typecheck/lint/testes verdes; testes de RLS de isolamento A×B passando; fluxo de auth testado com Playwright.

## Fase 2 — Biblioteca
- Upload TUS em massa (progresso, cancelamento, retomada), hash no cliente, detecção de duplicados.
- Worker: job de probe (`ffprobe`), thumbnail, compatibilidade por plataforma.
- Biblioteca (grade/lista, filtros, busca, coleções, seleção múltipla, detalhes, player, exclusão com tratamento de dependências).
- Policies de storage + testes.

**Critério de saída:** 50+ vídeos enviados num teste, upload interrompido e retomado, duplicado detectado, arquivo inválido rejeitado, acesso cruzado ao storage negado.

## Fase 3 — Agendamento (100% com conector mock)
- `packages/domain`: slots, DST, precedência, ordem, máquina de estados.
- Modelos, campanhas (wizard), calendário (dia/semana/mês/lista, drag-and-drop), fila operacional, pausas, edição/recálculo.
- Worker: scheduler, claim com `SKIP LOCKED`, lease/heartbeat, reaper, retry com backoff, DLQ, reconciler, política de atraso, espaçamento.
- MockConnector com injeção de falhas; 5 regras de automação; notificações internas.
- Hospedagem do worker definida (**requer sua autorização se for pago**).

**Critério de saída:** todos os testes de agendamento e publicação simulada da seção 18 do prompt passando, incluindo 2+ workers concorrentes sem duplicidade e recuperação após matar o worker no meio do envio.

## Fase 4 — Integração Meta
- OAuth Meta, seleção de contas IG profissionais e Páginas, capacidades/permissões.
- Conectores Instagram Reels e Facebook Reels com checkpoints e reconciliação.
- Criptografia de tokens, refresh, perda de autorização → pausa + notificação.
- Páginas legais + callback de exclusão de dados; preparação do App Review.

**Critério de saída interno:** publicação real em contas com papel no app (modo desenvolvimento). **Critério externo:** App Review aprovado → publicação em contas de clientes. Este último **não depende de mim**.

## Fase 5 — Expansão (após validação)
TikTok (após auditoria), YouTube (após verificação/auditoria), IA (sugestões revisáveis), analytics com dados reais, cobrança, equipes/aprovação, e-mail transacional, transcodificação.

## Prontidão para produção (além das fases)
Testes de carga com volume real, monitoramento e alertas ativos, backup/restore testado, revisão de segurança, termos e política revisados juridicamente, plano de incidente, custos medidos — e autorização explícita para deploy.
