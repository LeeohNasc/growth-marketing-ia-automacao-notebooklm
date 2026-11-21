# Landing page e cobrança

> Estado em 2026-11-21: landing implementada na rota pública `/` (local, sem deploy). **Não existe cobrança.**

## Landing (`/`)

- Arquivos: `apps/web/app/page.tsx` + `apps/web/app/_landing/` (pasta privada do App Router, não vira rota).
- Estilos isolados em CSS Module (`landing.module.css`): nada afeta o dashboard. Sempre escura (identidade).
- `noindex, nofollow` só nesta página (pré-lançamento). Retirar quando as vendas abrirem.
- Demonstração, calculadora e depoimentos são **ilustrativos** e identificados como tal. Antes de produção
  comercial, trocar os depoimentos por avaliações autorizadas e verificáveis.
- Login (`/login`), cadastro (`/signup`) e o app (`/w/...`) não mudaram; o header e o rodapé têm "Entrar".
- Testes: `apps/web/e2e/landing.spec.ts` (15) + `public.spec.ts` atualizado.

## O que existe hoje de "plano"

| Item | Situação |
|---|---|
| `subscriptions` (plan `starter`/`pro`/`agency`, status, `limits`) | existe; criada como `starter` com o workspace |
| `app.plan_defaults` / `workspace_limits` / limites em RPCs (`plan limit`) | existem, valores **provisórios** |
| Tela `/w/{ws}/billing` | só leitura (plano e uso), marcada "Provisório" |
| Provedor de pagamento, checkout, webhook, portal do cliente | **não existem** |

## Lacunas para vender (fluxo: plano → login → checkout → liberação no workspace certo)

1. **Decisões de negócio** (bloqueiam o resto): provedor (Stripe, Mercado Pago, Asaas, Pagar.me…),
   meios (cartão/Pix/boleto), recorrência, impostos/nota fiscal, termos de assinatura e cancelamento,
   preço anual. Os planos da landing (Starter, Pro, Business, Premium) **não batem** com o banco
   (`starter`, `pro`, `agency`): é preciso definir o mapeamento e os limites reais de cada um
   (contas sociais, marcas, membros). "Marca" não existe no modelo de dados hoje.
2. **Banco (migration nova, só com autorização)**: aceitar os novos códigos de plano; tabela de clientes do
   provedor (`workspace_id` → `customer_id`); registro idempotente de eventos (`event_id` único);
   colunas de período/estado (`trialing`, `active`, `past_due`, `canceled`); `plan_defaults` com os limites
   aprovados. O cliente **nunca** grava plano/estado (só o servidor, via service role).
3. **Servidor**:
   - `POST /api/billing/checkout`: exige sessão, confere que o usuário é owner/admin do workspace
     escolhido, cria a sessão de checkout com `workspace_id` e o preço **do servidor** (nunca do navegador).
   - `POST /api/billing/webhook`: valida a assinatura do provedor, ignora eventos repetidos, e só então
     ativa/troca/cancela o plano no workspace indicado nos metadados. A liberação acontece aqui, nunca na
     página de retorno do checkout.
   - Portal para trocar cartão/cancelar; rebaixamento quando o uso excede o novo limite (bloquear novas
     conexões em vez de apagar dados).
4. **Interface**: CTA de cada plano → `/signup?plan=pro` (ou login) → escolher workspace → checkout →
   página de retorno que espera a confirmação do webhook. Hoje os cards mostram
   "Assinaturas ainda não abertas" e não há checkout simulado.
5. **Testes**: modo de teste do provedor + CLI de webhooks local; casos de pagamento aprovado, recusado,
   repetido, fora de ordem, assinatura falsa e workspace de outro usuário.
6. **Segredos**: chave secreta e segredo do webhook só no servidor (Vercel/Supabase), nunca no frontend.

Nada disso foi iniciado: nenhuma conta em provedor, nenhuma chave, nenhuma cobrança.
