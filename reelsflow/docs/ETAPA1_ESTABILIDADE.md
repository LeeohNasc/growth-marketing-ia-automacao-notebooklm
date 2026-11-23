# Etapa 1 — Estabilidade da publicação

Branch: `claude/reelsflow-stability` (a partir da linha de produção + correção do Card Editorial).
Nada disto está em produção. Produção atual: Vercel `itkbur1j6` (commit 8131fae), Supabase com 11 migrations,
worker `worker-tick` versão 4.

## Diagnóstico (antes das correções)

| Item | Situação encontrada |
|---|---|
| Agendador (pg_cron) | 1.441 execuções em 24 h, 0 falhas |
| Chamadas ao worker | 0 erros, 0 timeouts nas últimas 24 h |
| Worker | último sinal há < 1 min |
| Fila | 1 publicação (publicada); 1 limpeza de lixeira agendada para 21/12 (esperado) |
| Duplicidade | protegida: chave de idempotência na Zernio + estado "incerto" + reconciliação |
| Campanha/conta/fila pausadas | não publicam (coberto por teste) |

### Lacunas reais corrigidas
1. **Reconciliação curta demais**: publicação "incerta" ia para revisão em ~5 min. A Zernio pode segurar
   um post por horas; o usuário veria "revisão" e poderia republicar à mão (duplicata).
   → consultas espaçadas (30 s, 1, 2, 4… até 1 h) e revisão só após ~1 dia (30 consultas).
2. **Servidor mal configurado era silencioso**: chave da Zernio inválida/ausente ou plano exigindo
   pagamento deixava as publicações esperando sem ninguém saber; o 402 ainda gastava tentativas até
   virar "falha definitiva" por um problema que não é do cliente.
   → espera sem gastar tentativa + **alerta operacional** único (`ops_alerts`), resolvido sozinho
   quando volta a publicar.
3. **Worker parado não avisava ninguém** (só um aviso na tela, se alguém abrisse o painel).
   → **vigia dentro do banco** (`worker_watchdog`, pg_cron a cada 5 min), independente da Edge
   Function: alerta crítico + aviso aos admins dos workspaces com publicações vencidas (1 a cada 6 h).
   Também alerta onda de falhas (≥ 5 definitivas por hora).
4. **Sem e-mail**: central de avisos com **preferências** (ligar/desligar e escolher categorias),
   registro de entrega (enviado/falhou/pulado + motivo), limite por pessoa (10/h) e diário (90/dia),
   sem duplicar (mesmo assunto em 1 h), conteúdo sem dados sensíveis. O envio usa o Resend **somente
   se** `RESEND_API_KEY` e `EMAIL_FROM` forem configurados — hoje **desligado** (nenhum serviço contratado).

### Riscos registrados (não alterados — exigem autorização)
- **Worker baixa o próprio código do GitHub** a cada inicialização (função v4 importa de
  `raw.githubusercontent.com`, fixado em 8131fae). Se o GitHub falhar ou o repositório ficar privado,
  as publicações param. Correção pronta: publicar a função com o pacote embutido (`index.ts` +
  `worker.bundle.js`, já gerado nesta branch).
- **Contas simuladas ligadas em produção** (`ENABLE_SIMULATED_ACCOUNTS` ausente = ligado). Recomendado
  `false` antes de abrir para clientes.
- **URL do vídeo vale 24 h** para a Zernio. Se a Zernio segurar um post por mais de 24 h, o download
  falha e a publicação vira falha com motivo (não duplica).

## Checklist de publicação (quando autorizado)
1. Backup: exportar o banco (Supabase → Database → Backups; plano gratuito não tem PITR — fazer
   `pg_dump` antes).
2. Aplicar a migration `20261123000015_reliability_alerts.sql` (só acrescenta tabelas, colunas, funções
   e o agendamento do vigia). Rollback: `cron.unschedule('reelsflow-worker-watchdog')`, remover o
   trigger `notifications_mark_email` e as tabelas novas — nenhum dado antigo depende delas.
3. Publicar a função `worker-tick` com `index.ts` + `worker.bundle.js` (sem dependência do GitHub).
   Rollback: republicar a versão 4.
4. Deploy do web (Vercel) desta branch. Rollback: promover `itkbur1j6` de volta.
5. Opcional: `ENABLE_SIMULATED_ACCOUNTS=false`; segredos de e-mail (`RESEND_API_KEY`, `EMAIL_FROM` com
   domínio verificado, `APP_URL`).
6. Conferir: `select public.worker_watchdog();` → `stalled: false`; `select * from ops_alerts where resolved_at is null;` vazio.

## Plano — teste real de 7 dias (NÃO iniciado; aguarda autorização)
- **Conta**: somente @pipocoumemes (conta `bef6f5b6…`, via Zernio). Nenhuma outra rede.
- **Conteúdo**: 7 vídeos escolhidos por você na Biblioteca, com direitos confirmados. Legendas revisadas
  antes.
- **Agenda**: 1 Reel por dia, no horário que você escolher, por 7 dias; tolerância de atraso 120 min
  (se o sistema cair, nada sai em rajada — vai para revisão).
- **Pré-requisito recomendado**: publicar esta etapa antes (para validar o código novo, incluindo o
  vigia e a reconciliação).
- **Acompanhamento diário** (eu verifico e reporto): fila e histórico; o Reel no perfil; tentativas e
  erros; `ops_alerts`; execuções do agendador; custo na Zernio.
- **Sucesso**: 7/7 publicados, cada um até 5 min após o horário (ou com motivo registrado), **zero
  duplicatas**, zero publicação em conta errada, nenhum alerta sem explicação.
- **Interromper imediatamente se**: qualquer duplicata, publicação em conta diferente, 2 falhas seguidas
  ou alerta crítico sem causa clara. Como: pausar a campanha (um clique) ou a fila do workspace.
- **Custo**: a Zernio é cobrada por uso; o gasto até agora é 0 e o preço por publicação **não está
  confirmado** — verificar no painel da Zernio antes de iniciar.
