# Migration 17 (`20261125000017_overdue_draft_fixes.sql`) — aplicação em produção

- **Quando:** 25/11/2026 02:37 UTC (24/11 23:37 em São Paulo), projeto Supabase `mxeazufhstmdvpvhfjhw`, commit `be6520b`.
- **O quê:** só esta migration (registrada como versão `20261125023702`, nome `overdue_draft_fixes`); nenhuma outra
  pendente aplicada; sem deploy do frontend.
- **Antes:** produção com 12 migrations (última: `reliability_alerts`); corpos instalados de `reschedule_job` (md5
  `b6bfe577…`) e `set_campaign_status` (md5 `cdc30745…`) **idênticos** aos de `docs/rollback/20261125000017_down.sql`;
  publicação do V41 e campanha em rascunho, 0 tentativas; nada agendado ou em andamento no worker.
- **Depois:** corpos instalados `949fe49f…` e `754baecd…` = os do arquivo da migration (testados: 128/128 banco, 91/91 worker);
  `SECURITY DEFINER`, `search_path` e permissões (`authenticated`, `service_role`, `postgres`: EXECUTE) inalterados;
  publicação do V41 intacta (rascunho, mesmo arquivo, conta e horário; 0 tentativas); totais de tentativas e posts
  externos inalterados (1 e 1, de 21/11).
- **Rollback:** `docs/rollback/20261125000017_down.sql` (restaura as duas funções exatamente; não toca em dados).

## Primeiro teste real após a correção — Card Editorial "Reunião de segunda — V41"
| Hora (São Paulo) | Evento |
|---|---|
| 23:40:15 | rascunho vencido (22:40) reagendado pelo usuário para 23:45 — aceito (antes da migration 17 era recusado) |
| 23:41:18 | campanha ativada → publicação agendada (planejamento não criou nada novo) |
| 23:45:46 | **publicado** no Instagram @pipocoumemes, 46 s após o horário, **1 tentativa**, 1 post externo (ID + link), 0 alertas |
