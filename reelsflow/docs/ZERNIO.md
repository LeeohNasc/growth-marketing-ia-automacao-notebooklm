# Zernio — integração (etapa 1: perfil e link de conexão)

> Referências: https://zernio.com/llms.txt e https://zernio.com/openapi.yaml (consultados em 2026-11-21).
> Estado: **perfil criado e link de conexão gerado na API real; nenhuma conta conectada; nada publicado.**

## O que existe

- `packages/connectors/src/zernio/client.ts` — cliente REST (somente servidor):
  `Authorization: Bearer` lido de `ZERNIO_API_KEY`; erros tipados (`status`, `type`, `code`, `details`,
  `x-request-id`, `Retry-After`, `retryable`); a chave nunca aparece em mensagens.
  Métodos: `listProfiles`, `createProfile`, `ensureProfile` (idempotente por `externalId`, trata 409),
  `getConnectUrl` (instagram, facebook, tiktok, youtube), `listAccounts`, `disconnectAccount`.
- `apps/worker/scripts/zernio-connect.ts` — garante o perfil, imprime o link de conexão e as contas.
- Testes com mocks: `packages/connectors/src/zernio/client.test.ts` (11 casos, sem chamadas reais).

## Como rodar

```bash
cd reelsflow/apps/worker
ZERNIO_API_KEY=... pnpm zernio:connect instagram      # ou facebook | tiktok | youtube
# opções: --external-id=<id do tenant> --name=<nome> --redirect=<url de retorno>
```

Neste ambiente de nuvem a chave é um segredo de rede injetado pelo proxy em `zernio.com`; o comando roda com
`ZERNIO_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1` (o `fetch` do Node só usa o proxy com essa flag).

## Executado em 2026-11-21

- Perfil `ReelsFlow` criado: `6b00e219a6e2ffc97925922b`, `externalId = reelsflow:default`.
  Segunda execução reaproveitou o mesmo perfil (sem duplicar).
- Link de conexão do Instagram gerado (app da Zernio no Instagram; retorno para o painel da Zernio).

## Observações

- O link usa o **app da Zernio** na Meta e pede, além de publicar, `instagram_business_manage_insights`,
  `..._manage_comments` e `..._manage_messages`. Dá para restringir com o parâmetro `scopes` do connect.
- Plano gratuito: 2 contas conectadas, 60 req/min. A partir da 3ª conta: US$ 6/conta/mês (faixa 1–10).
- Próximas etapas: registrar a conta conectada no ReelsFlow (callback/`account.connected`), conector de
  publicação (presign → upload → `POST /v1/posts` com `Idempotency-Key`), status, webhooks e métricas.
