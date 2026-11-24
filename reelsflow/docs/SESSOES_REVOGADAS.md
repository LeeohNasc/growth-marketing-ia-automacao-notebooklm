# Sessões revogadas — auditoria e correção do ciclo /login ↔ /w

Branch: `claude/reelsflow-session-revocation` (a partir de `claude/reelsflow-nav-perf`). **Não integrada, não publicada.**
Tudo medido em Supabase LOCAL (GoTrue v2.198.0, mesmo modelo da produção: ES256, JWT de 3.600 s, rotação de
refresh token) com usuários e dados sintéticos. Nada foi alterado em produção.

## 1. Causa exata do ciclo
| Camada | O que confere | Detecta sessão revogada? |
|---|---|---|
| Proxy/middleware (`getClaims`, auth-js 2.119.0) | assinatura ES256 (chave pública em cache) + validade (`exp`); renova se expirado | **Não** (só confere no servidor com chaves HS) |
| Páginas/ações (`getUser`) | pergunta ao servidor do Auth | **Sim** → 403 `session_not_found` / `user_banned` / `user_not_found` |

Página recusa → `redirect("/login")` → o proxy vê JWT válido e trata `/login` como "só para visitantes" → `/w` →
página recusa → `/login`… → `ERR_TOO_MANY_REDIRECTS`. Dura até o JWT expirar (≤ 60 min): aí a renovação falha
(refresh revogado), o cookie é limpo e o login volta ao normal (medido com JWT de 30 s).

Ocorre em: logout global feito em outro dispositivo, usuário bloqueado (ban), conta excluída. Nenhuma tela com
dados é exibida em nenhum deles.

## 2. Comportamento do Supabase após revogação (medido)
| Situação | Navegação (antes) | API de dados com o token antigo |
|---|---|---|
| Sair neste dispositivo | /login normal | **continua lendo** tabelas, RPC e assinando arquivos do Storage |
| Logout global (outro dispositivo) | ciclo | **continua lendo** |
| Usuário bloqueado | ciclo | **continua lendo** |
| Conta excluída | ciclo | nada (vínculos apagados; RLS bloqueia) |
| Removido do workspace | 404 imediato | nada, imediato |
| Rebaixado admin → viewer | permissões novas imediatas | — |
| JWT adulterado (`sub` trocado) | /login | 401 em tudo |

- A API de dados (PostgREST) **não consulta sessões**: aceita o JWT até `exp` **+ ~30 s** (tolerância de relógio;
  medido: aceito 26 s após expirar, recusado aos 36 s). O Storage recusa assim que expira.
- Janela real após revogação: **até ~60,5 min** com a configuração atual. Só é explorável por quem já tem o
  token de acesso (dispositivo comprometido, XSS, token vazado). As leituras foram testadas; escritas com o mesmo
  token seguem as mesmas regras de RLS (inferência, não testado).
- Para tirar o acesso de alguém **na hora**, o que funciona hoje é **remover do workspace** (efeito imediato).
- Achado colateral: o botão "Sair" usa o escopo padrão (`global`) — encerra a sessão em todos os dispositivos.

## 3. Correção implementada nesta branch (sem mexer no middleware)
Nova rota `GET /auth/session-ended`, destino de toda página/ação que recebeu cookie mas o Auth recusou:
- Auth confirma sessão válida → volta para `/w` **sem deslogar** (um link de terceiros não desloga ninguém);
- Auth recusa (4xx) → `signOut({ scope: "local" })` (apaga o cookie antes de chamar o servidor) →
  `/login?notice=session-ended` com aviso;
- Auth fora do ar (rede/5xx) → **não desloga**; página 503 "tente novamente".

Arquivos: `app/auth/session-ended/route.ts` (novo), `lib/session.ts` (`SESSION_ENDED_PATH` em `requireUser` e
`requireWorkspace`), `app/w/[workspace]/settings/actions.ts`, `app/account/actions.ts`, callbacks OAuth
(`app/api/oauth/{meta,instagram}/callback/route.ts`), aviso em `app/(auth)/login/page.tsx`.

**Custo**: zero no caminho normal (o middleware não mudou; nenhuma chamada a mais). Só no caso de falha:
1 redirecionamento + 1 `getUser`.

Alternativa avaliada e não escolhida: no middleware, confirmar com `getUser` nas páginas de visitante
(/login, /signup, /forgot-password) quando houver cookie. Também resolve, mas mexe no middleware e soma 1 chamada
ao Auth (~400 ms da região atual) a toda visita ao login com cookie. Descartada: `getUser` em toda requisição
(+1 ida ao Auth em todas as páginas).

## 4. Reduzir a janela de acesso após revogação (propostas, nada aplicado)
| Opção | Efeito | Custo / risco |
|---|---|---|
| A. JWT mais curto (ex.: 900 s) — configuração do Auth em produção | janela ≤ ~15,5 min | 4 renovações/h por usuário ativo (~400 ms na requisição que renova). As renovações saem dos IPs da Vercel; o limite de renovação do Auth é por IP (local: 150 por 5 min) → acompanhar com mais usuários. Disponibilidade do ajuste no plano atual: **a confirmar no painel** |
| B. RLS restritiva "sessão ativa" (`auth.sessions`) em todas as tabelas + Storage | janela **0** para banco, RPC e Storage | medido: com a migration 16, +0,3 a 0,7 ms por consulta; **sem** a migration 16, até +19 ms (o planejador troca de plano e a `has_role` por linha roda mais vezes). Exige migration (~25 tabelas) depois da 16; depende da estrutura de `auth.sessions` (gerida pelo Supabase) → falha fechada se mudar; exige teste automatizado |
| C. Operacional | remover do workspace para cortar acesso na hora | nenhum; documentar no processo de desligamento |

Protótipo de B (testado só dentro de transação desfeita, nunca gravado):
```sql
create function app.session_is_active() returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.sessions s
                  where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
                    and (s.not_after is null or s.not_after > now()))
$$;
create policy rf_session_active on public.<tabela> as restrictive for all to authenticated
  using ((select app.session_is_active()));   -- "(select …)" = avaliada 1 vez por consulta
```
Resultado: sessão ativa → 10.270 linhas visíveis; sessão revogada → 0 (publication_jobs e workspaces).

## 5. A consulta paralela de workspace (otimização de navegação) adiciona risco?
Não encontrado. Testado:
- sessão revogada + membro: a consulta roda com o token (que já daria o mesmo acesso direto pela API), o resultado
  é descartado no servidor e nada é enviado ao navegador;
- sessão revogada + sem vínculo: resposta idêntica para workspace real e inexistente (não revela existência);
- JWT adulterado: recusado na conferência de assinatura antes de qualquer consulta, e 401 na API;
- o usuário validado por `getUser` precisa ser o mesmo do JWT (conferido no código).

## 6. Testes (Supabase local) — antes × depois da correção
| Cenário | Antes | Depois |
|---|---|---|
| owner/admin/editor/viewer: workspace próprio 200, outro 404 | ok | ok |
| sem vínculo: 404 em tudo; API sem dados | ok | ok |
| logout global em outro dispositivo | **ciclo**, cookie preso | /login com aviso, cookie limpo, novo login ok |
| usuário bloqueado | **ciclo** | /login com aviso |
| conta excluída | **ciclo** | /login com aviso |
| sair neste dispositivo | ok | ok |
| removido do workspace / rebaixado | imediato | imediato |
| JWT expirado com renovação válida (JWT de 30 s) | renova, 200 | renova, 200 |
| revogado e depois expirado (JWT de 30 s) | /login após expirar | /login antes e depois |
| link de terceiro para `/auth/session-ended` com sessão válida | — | não desloga (303 → /w) |
| Auth fora do ar | — | 503, cookie mantido; volta ao normal quando o Auth volta |
| Testes de segurança anteriores | 9/10 | **10/10** |
| Testes de experiência da navegação | 10/10 | 10/10 |
| Suíte e2e do projeto (desktop + celular) | 64/64 | 64/64 |

## 7. Pendências encontradas
- Com o Auth fora do ar, a página espera **60 s** pelo `getUser` antes de responder (já era assim). Proposta:
  limite de tempo (ex.: 5 s) na chamada ao Auth — mudança separada.
- A API continua aceitando o token revogado até ~60,5 min — exige A e/ou B, com autorização.
- Escopo do botão "Sair" (global × só este dispositivo) — decisão de produto.

## Rollback
Nada em produção. Na branch: `git revert <commit>`. Depois de integrado: promover o deploy anterior na Vercel.
Sem migration, sem mudança no middleware, no worker, na Zernio ou no RLS.
