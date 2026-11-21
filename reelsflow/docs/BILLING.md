# Cobrança recorrente — Stripe Checkout + Billing (v1, MODO DE TESTE)

> Estado em 2026-11-21: implementado e testado **localmente**. Não aplicado em produção, sem deploy,
> nenhuma compra no sandbox da Stripe ainda (falta a chave de teste). Chaves `sk_live_` são recusadas.

## Fluxo

```
Landing (#planos)
 ├─ Starter → /signup → onboarding → workspace novo já nasce "starter" (create_workspace). Sem checkout.
 └─ Pro/Business/Premium → /billing/start?plan=…&interval=month
       ├─ deslogado → /login?next=… (ou /signup?next=…) → volta
       ├─ sem workspace administrado → /onboarding?next=… → volta
       └─ confirma o workspace → POST /api/billing/checkout
             servidor: sessão + owner/admin (banco) + price_id da configuração conferido na Stripe
             (BRL, valor do catálogo, 1× mensal) + anti-duplicidade → Stripe Checkout hospedado
                ├─ cancelou → /w/{ws}/billing?checkout=canceled (nada muda)
                └─ pagou → /w/{ws}/billing?checkout=success → "Confirmando pagamento…" (só consulta)
Stripe → POST /api/billing/webhook (assinatura verificada no corpo bruto)
       → relê a assinatura na Stripe → workspace pelo CLIENTE gravado no checkout (nunca e-mail)
       → plano pelo preço contratado (configuração do servidor + conferência de moeda/valor/recorrência)
       → billing_apply_subscription → limites do plano passam a valer no banco
```

## Rotas e arquivos

| Item | Caminho |
|---|---|
| Catálogo (preços, limites exibidos) | `apps/web/lib/billing/catalog.ts` |
| Núcleo checkout/webhook (testável) | `apps/web/lib/billing/core.ts`, `db.ts`, `verify.ts` |
| Adaptadores do servidor (Stripe, service role, CSRF) | `apps/web/lib/billing/server.ts` |
| Início do checkout | `POST /api/billing/checkout` |
| Webhook | `POST /api/billing/webhook` |
| Gerenciar assinatura (portal da Stripe) | `POST /api/billing/portal` |
| Estado (somente leitura) | `GET /api/billing/status?workspace=` |
| Escolha do workspace | `/billing/start?plan=pro|business|premium&interval=month` |
| Tela do workspace | `/w/{slug}/billing` |
| Preparação do sandbox | `apps/web/scripts/stripe-test-setup.mjs` |
| Migration | `supabase/migrations/20261121000012_billing_stripe.sql` |
| Testes | `supabase/tests/src/billing.test.ts` (23), `apps/web/e2e/billing.spec.ts` (6) |

Também mudaram: landing (CTAs e itens "planejado"), onboarding e login/cadastro (preservam `next`).

## Banco (migration 12 — só acrescenta)

- `subscriptions` (reaproveitada): planos `starter | pro | business | premium | agency (legado)`;
  colunas `stripe_customer_id` (único), `stripe_subscription_id` (único), `stripe_price_id`,
  `billing_interval`, `provider_status`, `current_period_end`, `cancel_at_period_end`, `provider_synced_at`.
  O navegador lê plano/estado/limites, **não** os IDs da Stripe, e não escreve nada.
- `app.plan_defaults`: Pro 1 conta/1 usuário · Business 4 contas/3 membros · Premium 12 contas/6 membros
  (`social_accounts` = total de todas as redes). Starter e Agency **inalterados**.
- `app.workspace_limits` continua `padrão do plano || subscriptions.limits`: **sobrescritas manuais vencem**
  o plano. Auditoria em produção (21/11, leitura): 2 workspaces, ambos Starter, nenhum `limits` manual,
  nenhum `provider_ref` → nada a preservar além do comportamento atual.
- Limite de contas: por rede (existente) + total (novo), com trava por workspace → a 5ª conexão
  simultânea no Business não passa. Assentos: mesma trava nos convites.
- `billing_checkout_sessions`: no máximo 1 checkout em andamento por workspace (índice único parcial).
- `billing_events`: idempotência por `event_id`, tentativas, nota de diagnóstico (sem dados de cartão).
- Funções `billing_*` executáveis só por `service_role`.

## Regras de estado (provisórias — sandbox)

| Stripe | ReelsFlow |
|---|---|
| `active` / `trialing` | plano contratado, `status=active` |
| `past_due` (renovação falhou) | **mantém o plano** em carência, `status=past_due`, aviso na tela |
| `unpaid` / `canceled` (fim de acesso) | volta ao **Starter**; nada é apagado |
| `incomplete` (pagamento pendente) / `incomplete_expired` | nada liberado; nunca rebaixa outro plano |
| cancelamento pelo portal | ao fim do período (`cancel_at_period_end`), depois `canceled` |
| 2ª assinatura paga no mesmo workspace | mantém a vigente e **cancela** a nova (sem reembolso automático) |
| evento repetido | ignorado (`billing_events`) |
| evento fora de ordem | o estado é sempre relido na Stripe; leituras mais antigas são descartadas |
| falha temporária | HTTP 500 → a Stripe reenvia |
| `livemode=true` | ignorado nesta versão |

Downgrade não desconecta contas nem apaga conteúdo: acima do limite, só **novas** conexões/convites
ficam bloqueados.

## Configuração

Variáveis (somente servidor; nomes em `apps/web/.env.example`): `STRIPE_SECRET_KEY` (sk_test_),
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_BUSINESS_MONTHLY`,
`STRIPE_PRICE_PREMIUM_MONTHLY`, `STRIPE_PORTAL_CONFIGURATION` (opcional) e `SUPABASE_SERVICE_ROLE_KEY`.
Os CTAs pagos da landing só aparecem com isso configurado (avaliado no build).

Webhook: `<SITE>/api/billing/webhook` com os eventos `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
`checkout.session.expired`, `customer.subscription.created|updated|deleted|paused|resumed`,
`invoice.paid`, `invoice.payment_failed`.

## Reproduzir no sandbox (do clique ao desbloqueio)

1. `cd apps/web && STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-test-setup.mjs` → copie os IDs para `.env.local`.
2. Aplique a migration 12 num Supabase de **teste** (não produção) e configure `.env.local` desse projeto.
3. `stripe listen --forward-to localhost:3000/api/billing/webhook` → copie o `whsec_…` para `STRIPE_WEBHOOK_SECRET`.
4. `pnpm dev` → landing → "Assinar Business (teste)" → entre/crie conta → confirme o workspace → pague com
   `4242 4242 4242 4242` (qualquer data futura/CVC). Teste também `4000 0000 0000 9995` (recusado) e cancelar.
5. Volte em `/w/{ws}/billing`: "Confirmando pagamento…" → Business ativo; 4 contas → a 5ª é bloqueada.
6. Portal: "Gerenciar assinatura" → cancelar ao fim do período / trocar de plano; `stripe trigger` ou
   "Reenviar" no Dashboard para conferir idempotência.

## Pendente

- **Credencial**: chave de teste da Stripe (o pedido da chave nesta sessão foi recusado) e um projeto
  Supabase de teste para aplicar a migration 12 → sem isso, nenhuma compra no sandbox foi feita.
- **Decisões comerciais**: carência do `past_due` (configurar as novas tentativas na Stripe); reembolso de
  duplicidade; proration na troca de plano; política acima do limite após downgrade; Starter "1 conexão"
  na landing vs. backend "1 por rede" (inalterado); limites de vídeos/armazenamento dos pagos; meios de
  pagamento (cartão/boleto/Pix), impostos e nota fiscal; preços anuais.
- **Produto**: marcas (não existe no modelo) e recursos por plano (Card Editorial, permissões avançadas,
  aprovações, relatórios) não são bloqueados por plano — hoje todos os planos usam o que existe.
