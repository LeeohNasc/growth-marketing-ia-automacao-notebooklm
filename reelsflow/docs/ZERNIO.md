# Zernio — publicação automática pelo ReelsFlow

> Referências: https://zernio.com/llms.txt e https://zernio.com/openapi.yaml (consultados em 2026-11-21).
> Estado: **implementado e testado com a API simulada; NÃO implantado; nada publicado de verdade.**

## Como funciona

- O **ReelsFlow é dono do calendário** (campanhas, frequência diária, fila). No horário, o worker
  (Edge Function `worker-tick`, a cada minuto, via pg_cron — não depende de nenhum computador ligado)
  pede à Zernio a publicação imediata (`POST /v1/posts`, `publishNow: true`).
- A conta é uma linha comum de `social_accounts` com `provider = 'zernio'`,
  `external_account_id` = id da conta na Zernio e `provider_profile_id` = perfil Zernio esperado.
  Aparece nas campanhas, fila, calendário e histórico como qualquer conta.
- O vídeo vai por URL assinada do armazenamento do ReelsFlow, válida por 24 h (a Zernio baixa por ela).

## Garantias contra publicação duplicada

1. `Idempotency-Key` e `externalId` = `reelsflow-job-<id da publicação>`, iguais em todas as tentativas:
   a Zernio devolve o mesmo post em vez de criar outro (janela de 24 h).
2. Checkpoint gravado antes do pedido; depois, o id do post. Com o id salvo, o worker só consulta.
3. Falha sem resposta → estado "incerto" → reconciliação procura o post por `externalId`.
4. `409 duplicate_content` (mesmo vídeo+legenda na conta em 24 h) → falha definitiva, nada é reenviado.
5. 207 é tratado pelo `post.status`/status da plataforma, nunca pelo código HTTP.
6. Antes do 1º pedido, confere que a conta pertence ao perfil Zernio vinculado ao workspace.

## Erros e esperas

| Situação | Comportamento |
|---|---|
| Zernio ainda publicando | Nova consulta em ~1 min, sem gastar tentativa; após 6 h → incerto (reconciliação) |
| Falha transitória da rede/Zernio (`platform_error`, `system_error`…) | `POST /v1/posts/{id}/retry` no mesmo post, até 3× |
| Conteúdo rejeitado (`user_content`, `platform_rejected`…) | Falha definitiva com o motivo + notificação |
| Token expirado / conta desconectada na Zernio | Conta "requer reconexão", publicações aguardam, admins avisados |
| `ZERNIO_API_KEY` ausente ou inválida (401) | Publicações aguardam sem gastar tentativa; a conta NÃO é culpada |
| 429 | Respeita `Retry-After` |
| Saúde das contas | `GET /v1/accounts/health` a cada 10 min: desconectou → pausa e avisa; voltou → reativa sozinha |

## Segurança e isolamento

- `ZERNIO_API_KEY` só no servidor (segredo da Edge Function). Nunca no navegador, no código ou no Git.
- Vínculo de conta (`link_zernio_account`) só pelo operador/service role: nenhum usuário escolhe IDs.
- Uma conta Zernio só pode estar ativa em um workspace (índice único).
- `provider`, `provider_profile_id` e `external_account_id` não são editáveis por usuários.

## Colocar em produção (somente com autorização)

1. **Segredo**: Supabase → projeto `reelsflow-dev` → Edge Functions → Secrets → `ZERNIO_API_KEY`
   = chave de https://zernio.com/dashboard/api-keys (digitada por você no painel).
2. **Migrations** (aditivas, preservam dados): `20261120000009_instagram_login.sql` e
   `20261121000010_zernio_accounts.sql`.
3. **Vincular a Pipocou** ao workspace Leeoh Nasc:
   ```sql
   select public.link_zernio_account(
     'ee28d57b-cd47-45a3-be22-f164a029a03c',  -- workspace Leeoh Nasc
     '6b00e99db2568bfa4f7a2643',              -- conta @pipocoumemes na Zernio
     '6b00e219a6e2ffc97925922b',              -- perfil ReelsFlow na Zernio
     'instagram', 'pipocoumemes', '🍿 Pipocou | Humor e Memes');
   ```
4. **Worker**: republicar `worker-tick` importando o bundle do commit desta versão (lê `ZERNIO_API_KEY`).
5. **App**: `vercel deploy --prod` (selo "via Zernio" nas contas e na campanha).
6. **Homologação**: enviar 1 vídeo, campanha só para a Pipocou ≥ 5 min à frente; conferir `published`,
   ID e link do Reel no histórico e no Instagram.

## Limites

- Zernio grátis: 2 contas conectadas, 60 req/min. A partir da 3ª conta: US$ 6/conta/mês.
- Vídeos até 50 MB (limite do armazenamento gratuito da Supabase).
- Plano `starter` do ReelsFlow: 1 conta de Instagram por workspace (suficiente para a Pipocou).
- Webhooks da Zernio não implementados: o status é obtido por consulta (funciona sem eles).
- Repetir manualmente uma publicação rejeitada por conteúdo, com o mesmo vídeo e legenda, em menos de 24 h
  devolve o mesmo resultado (proteção contra duplicação); altere a legenda ou aguarde.

## Implantação em produção — 2026-11-21 (concluída)

| Etapa | Resultado |
|---|---|
| Estado/backup | Tabelas afetadas vazias (0 contas, tokens, campanhas, jobs); estrutura registrada em `supabase/rollback/20261121_rollback_migrations_9_10.sql` (rollback testado localmente com conta vinculada) |
| Migrations 9 e 10 | Aplicadas e conferidas (10 migrations registradas) |
| Vínculo | `@pipocoumemes` → workspace Leeoh Nasc, social_account `bef6f5b6-82eb-4461-9048-95378b2b461f`, provider `zernio` |
| Worker | `worker-tick` v3, bundle do commit `f6d88a6` (sha256 `dac41d0b…`), `zernio_configured: true`, saúde da conta `healthy` |
| App | Vercel produção (deploy `reelsflow-3vqniynku`) |
| Verificações | Agendador 7/7 ciclos ok; 0 campanhas ativadas; isolamento confirmado na interface; 0 posts na Zernio |
