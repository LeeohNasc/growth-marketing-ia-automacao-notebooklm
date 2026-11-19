# Relatório — Fase 1 (Fundação)

Data: 2026-11-19

## Decisões assumidas (reversíveis) por falta de resposta às questões D1–D6
| Decisão | Assumido | Como reverter |
|---|---|---|
| D1 Repositório | Código em `reelsflow/` dentro deste repositório (não tenho permissão para criar repositórios) | `git subtree split --prefix reelsflow` para um repositório novo |
| D4 Projeto Supabase | **Não criado.** Em organização paga, cada projeto é cobrado; exige sua autorização | Criar projeto e rodar `supabase db push` |
| Versões | Next.js 16.4.5, React 19.3.1, TypeScript 5.9.3 (7.x evitado: ecossistema ainda imaturo), Zod 4.6.7, Tailwind 4.3.4 — versões com ≥ 2 semanas de publicação | Atualizar `package.json` |

## Implementado
- **Monorepo pnpm**: `apps/web`, `packages/domain`, `supabase/tests`; TypeScript strict com `noUncheckedIndexedAccess`.
- **Migration `20261119000001_foundation.sql`**: `profiles`, `workspaces`, `workspace_members`, `subscriptions`, `usage_records`, `notifications`, `audit_logs`; enum de papéis; `app.has_role`; RLS em todas as tabelas; grants por coluna; RPCs `create_workspace`, `mark_notifications_read`, `account_deletion_blockers`; triggers de auditoria, validação de fuso, proteção do último owner e limpeza de workspace vazio.
- **Auth** (Supabase Auth + `@supabase/ssr`): cadastro com aceite de termos, login, confirmação de e-mail (`/auth/confirm`, aceita `token_hash` e `code`), recuperação e redefinição de senha (encerra todas as sessões), logout só por POST, perfil, exclusão de conta (com bloqueio se for o único owner de workspace com membros).
- **Proteção de rotas** em `proxy.ts` (convenção do Next 16 que substitui `middleware`), com `getClaims()`; dados validados no servidor com `getUser()` e protegidos por RLS. Redirecionamento pós-login saneado contra open redirect.
- **Onboarding** de workspace; seletor e troca de workspace; layout com menu lateral (13 itens do PRD) e menu mobile em gaveta; tema escuro padrão e claro opcional (contraste AA verificado).
- **Telas com dados reais**: Visão Geral (membros, notificações; indicadores das fases futuras aparecem como “—” com a fase indicada, nada inventado), Configurações (nome, fuso, membros, sair, excluir), Notificações, Assinatura (plano provisório + uso medido). As demais telas mostram aviso explícito da fase em que serão implementadas.
- **Cabeçalhos de segurança** (X-Frame-Options, nosniff, Referrer-Policy, HSTS, Permissions-Policy).
- **CI** (`.github/workflows/reelsflow-ci.yml`): typecheck, lint, unitários, migrations + RLS em Postgres 16, build, E2E.

## Testes executados (todos neste ambiente)
| Suíte | Resultado |
|---|---|
| `pnpm typecheck` (3 pacotes) | OK |
| `pnpm lint` | OK, 0 avisos |
| Domínio (Vitest) | 15/15 |
| RLS / banco (Postgres 16 + shim do Supabase) | 39/39 |
| Mutação de segurança (RLS de `workspaces` desligada + policy de membros afrouxada) | 9 testes falharam como esperado → a suíte detecta regressões |
| `next build` | OK (18 rotas) |
| E2E Playwright, desktop + Pixel 7 | 32/32 |

## O que NÃO foi validado (e por quê)
- **Fluxo real de cadastro/login/e-mail**: não há projeto Supabase. Os E2E rodam com o Auth apontando para uma porta fechada (validam formulários, proteção de rotas e falha graciosa, não o login real).
- **Telas autenticadas renderizadas com dados**: compilam e passam no typecheck, mas não foram abertas no navegador com sessão real.
- **Shim vs. Supabase real**: os testes de RLS usam uma emulação mínima de `auth.users`/`auth.uid()`/papéis com os grants padrão permissivos do Supabase. Precisam ser repetidos contra o banco real (`supabase db push` + mesma suíte).
- **CI**: o workflow foi escrito mas ainda não rodou no GitHub.

## Pendências
1. Autorização para criar o projeto Supabase de desenvolvimento → aplicar migration, configurar URLs do Auth, gerar tipos (`supabase gen types`) no lugar de `lib/database.types.ts`, rodar fluxo real.
2. Termos de uso e política de privacidade: o checkbox de aceite existe, mas os documentos não (necessários também para o App Review da Meta).
3. Content-Security-Policy com nonce (adiada; os demais cabeçalhos estão ativos).
4. Convites de membros (o banco já suporta; UI fica para a fase de equipes).
5. Templates de e-mail do Supabase em português.

## Riscos
- Tipos do banco escritos à mão podem divergir do schema até a geração automática.
- Exclusão de workspace é imediata e em cascata (sem janela de desfazer); a política de retenção do DATABASE.md §5 ainda não foi implementada.
- Sem rate limiting próprio: depende dos limites do Supabase Auth.

## Próxima fase recomendada
Fase 2 — Biblioteca (upload TUS, storage com policies por workspace, worker de probe/thumbnail). **Pré-requisito:** projeto Supabase criado, porque upload e storage não podem ser validados só com Postgres local.
