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
- **Worker com código vindo do GitHub** (função v4 importa de `raw.githubusercontent.com`, fixado em
  8131fae). Correção da avaliação inicial: o Supabase empacota as dependências **no deploy** (ESZip; a v4
  tem `ezbr_sha256`), então o GitHub é necessário para *publicar/republicar* a função, não a cada
  inicialização. O risco real: um novo deploy ou rollback depende do GitHub estar acessível e do arquivo
  continuar público; e o código em execução não fica versionado junto da função. O pacote embutido
  (`index.ts` + `worker.bundle.js`, só `npm:` fixados e módulos nativos) remove o GitHub de todo o caminho.
- **Contas simuladas ligadas em produção** (`ENABLE_SIMULATED_ACCOUNTS` ausente = ligado). Recomendado
  `false` antes de abrir para clientes (fora deste deploy).
- **URL do vídeo vale 24 h** para a Zernio. Se a Zernio segurar um post por mais de 24 h, o download
  falha e a publicação vira falha com motivo (não duplica).
- **Integração futura (Etapa 3)**: a fusão de código com a branch unificada conflita só em
  `apps/worker/src/worker.ts` (dois passos novos na manutenção) — trivial. As migrations 12–14 foram
  testadas aplicadas DEPOIS da 15 (cenário real): 151 testes de banco + 82 do worker da branch unificada
  e os 16 da Etapa 1, todos verdes.

## Revisão final de segurança e compatibilidade (antes do deploy)
| Verificação | Resultado |
|---|---|
| Migration 15 × produção (nomes, colunas, extensões) | sem conflitos; pg_cron 1.6.4 presente; 6 notificações antigas sem e-mail retroativo |
| Migration 15 × 12/13/14 (duas ordens) | aplica nas duas; suítes de todas as branches verdes |
| Worker atual (v4) com a migration 15 aplicada | roda normalmente (testado em Deno 2.9.6) → migration pode ir primeiro |
| Pacote novo sem código remoto | confirmado (só `npm:` com versão fixa e `node:`) |
| Reconciliação | nunca recria o post (teste: 10 consultas com a Zernio processando → publica com 1 único pedido) |
| Alertas sem e-mail | notificações no sistema, `ops_alerts` e vigia independem do provedor (testado) |
| Preferências na tela | defeito encontrado e corrigido (upsert bloqueado pela permissão por coluna); validado inserir e atualizar |
| Card Editorial (correção pendente) | 29/29 testes de renderização real |

## Roteiro de deploy (ordem exata) — somente com autorização
**Antes (passo 0 — backup e referência, só leitura):**
- exportar via SQL as linhas das tabelas `publication_jobs`, `external_publications`, `campaigns`,
  `media_assets`, `social_accounts`, `editorial_cards`, `notifications`, `workspaces` para arquivo local
  privado (fora do repositório). O plano gratuito não tem backup baixável/PITR;
- registrar a assinatura (md5) das mesmas tabelas. Referência de 23/11: campaigns 1 `cc61d9ac`,
  editorial_cards 2 `2f469b71`, external_publications 1 `9ff39d11`, media_assets 16 `332316b4`,
  migrations 11 `d4d3d9bb`, notifications 6 `8c4e48e1`, publication_jobs 1 `896809df`,
  social_accounts 2 `c556e480`, workspaces 2 `84df6dec`;
- rollback pronto: `docs/rollback/20261123000015_down.sql`, `docs/rollback/worker-tick-v4/`
  (index + pacote de 8131fae, sha256 `2d6dfaae`), site anterior `dpl_7yDQAD9ZfqyLbcY9asNDhqwwyVGn`.

**Passo 1 — migration 15** (aditiva; o worker v4 e o site atual continuam funcionando com ela).
Testes logo após:
1. objetos criados (`ops_alerts`, `notification_preferences`, 3 colunas em `notifications`, trigger);
2. `cron.job` contém `reelsflow-worker-watchdog` (*/5) além dos 2 jobs atuais;
3. `select public.worker_watchdog()` → `stalled: false`; `ops_alerts` abertos = 0;
4. assinaturas das tabelas iguais à referência (notifications comparada sem as 3 colunas novas);
5. 3 ciclos do worker v4 depois (≈3 min): `cron.job_run_details` sem falha, worker com sinal < 2 min.

**Passo 2 — função `worker-tick` v5** (`index.ts` + `worker.bundle.js` desta branch, `verify_jwt` desligado,
mesmos segredos). Testes logo após (10 min):
1. respostas do cron 2xx, sem timeout; logs `tick done` com `email_configured:false`, sem `tick failed`;
2. worker com sinal < 2 min; `worker_watchdog()` → `stalled: false`;
3. notificações novas importantes ficam `skipped/provider_not_configured` (esperado, sem provedor);
4. assinaturas das tabelas inalteradas.

**Passo 3 — site (Vercel)**: primeiro um deploy de *preview* desta branch apontando para a produção do
Supabase, conferir, e só então promover. Testes no preview e depois em produção:
1. login; Visão Geral; Fila/Histórico mostram o Reel publicado com o link; Biblioteca com 15 vídeos;
2. Campanhas mostra a campanha concluída; Card Editorial abre e preserva os arquivos escolhidos;
3. Notificações: lista e "Avisos por e-mail" salvam (inserir e alterar);
4. nenhuma resposta 5xx nos logs da Vercel.

**Passo 4 — observação 24 h** (eu verifico em intervalos): cron, worker, `ops_alerts`, assinaturas.

**Interromper e reverter se:**
- a migration falhar (ela roda em transação: nada fica pela metade) → parar, sem rollback necessário;
- qualquer assinatura de dado existente mudar → reverter o passo atual e investigar;
- worker sem sinal > 3 min, resposta não-2xx ou `tick failed` após o passo 2 → republicar a v4
  (`docs/rollback/worker-tick-v4/`);
- erro 5xx ou tela quebrada após o passo 3 → promover `dpl_7yDQAD9ZfqyLbcY9asNDhqwwyVGn`;
- alerta crítico inesperado em `ops_alerts`.
Ordem do rollback completo: site → worker v4 → `20261123000015_down.sql`.

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

## Diário do deploy em produção — 23/11/2026 (UTC)
| Hora | Passo | Resultado |
|---|---|---|
| 02:14 | 0 · backup | cópia de 13 tabelas no esquema `rf_backup` (sufixo `_20261123`), idêntica linha a linha; sem acesso pela API |
| 02:16 | 1 · migration 15 | aplicada (transação); objetos e vigia criados; assinaturas idênticas; 3 ciclos do worker v4 sem falha |
| 02:20 | 2 · worker v5 | publicado (versão 5, `verify_jwt` desligado). **Desvio autorizado**: pacote importado do GitHub fixado no commit `0a9d4c2` (sha256 `7043ea31…`, conferido byte a byte), não embutido — a ferramenta de deploy exigiria transcrever 2.946 linhas sem verificação por assinatura. Dependência do GitHub só em deploys futuros (como na v4) |
| 02:20–02:32 | 2 · testes | 12 ciclos 202, 0 erros, vigia ativo, Zernio saudável (checagem feita pelo v5), assinaturas idênticas |
| 02:35 | 3 · prévia | `reelsflow-9xfmaexw8` — páginas públicas 200, rotas protegidas → login; testes logados com conta temporária autorizada: 8 telas 200, editor do Card, preferências (inserir/alterar), 0 erros |
| 02:41 | 3 · produção | `dpl_Dw6UZ7FpiXJxY3Gf6UQ6L9Dmxdqk` em `reelsflow-xi.vercel.app` (deploy de produção do mesmo commit, variáveis de produção); mesmos testes: tudo ok |
| 02:43 | 3 · limpeza | conta temporária, 2 workspaces de teste, cards e preferências removidos (com travas); usuários = 3 |
| 02:45 | 4 · observação | 25 ciclos sem erro, 6 execuções do vigia, 0 alertas, assinaturas idênticas; verificações agendadas em +1 h, +8 h e +24 h |

Rollback disponível: site `dpl_7yDQAD9ZfqyLbcY9asNDhqwwyVGn`; worker `docs/rollback/worker-tick-v4/`;
banco `docs/rollback/20261123000015_down.sql` (com trava contra perda de dados novos).

### Observação — ocorrências (até 11:05 UTC de 23/11)
Medição: 525 execuções do agendador (`reelsflow-worker-tick`), 0 falhas; 525 `tick done`, 0 `tick failed`;
106 execuções do vigia; 0 `ops_alerts`; assinaturas dos dados inalteradas; Zernio `healthy` (checagem 10:56).

| Minuto (UTC) | O que os registros mostram | Causa | Efeito |
|---|---|---|---|
| 07:20 | sem linha no log de borda da função, mas pg_net registrou **202** e o worker registrou `booted` + `tick done` | falha só no registro de log da borda (a chamada aconteceu) | nenhum |
| 08:40 | cron `succeeded` (apenas enfileira); pg_net: **timeout de 5 s inteiramente na resolução de DNS**, 0 ms de conexão; a função não recebeu chamada | falha transitória de DNS na rede do Supabase (pg_net), fora do código do ReelsFlow | 1 ciclo pulado; o das 08:41 rodou normalmente |

Por que um ciclo pulado não gera duplicata nem perda: o worker é sem estado entre ciclos; publicações vencidas
são reivindicadas no ciclo seguinte (tolerância de atraso de 120 min) e a idempotência na Zernio impede
reenvio. Conferido: `publication_attempts` = 1, `external_publications` = 1, nenhuma publicação pendente.
Limite da evidência: o pg_net guarda respostas por só 6 h, então falhas anteriores às últimas 6 h só aparecem
pela ausência no log de borda (método usado acima). O vigia só alerta após 5 min sem sinal — por desenho,
1 ciclo pulado não alerta.

## Mudança de região da Vercel para gru1 — procedimento (NÃO executado; aguarda autorização)
Situação atual (lida pela API): projeto com região `iad1`; produção `dpl_Dw6UZ7FpiXJxY3Gf6UQ6L9Dmxdqk`
(READY, commit `0356e74`, árvore limpa); variáveis de produção = 3 `NEXT_PUBLIC_*`, alteradas pela última vez
em 21/11 (antes deste deploy → o novo usará os mesmos valores). Banco em `sa-east-1` (São Paulo).
A região é gravada **em cada deploy** (prévias `iad1` e `gru1` do mesmo código coexistiram): mudar de região
exige um novo build, e voltar não exige build.

1. **Preparar** (sem efeito em produção): `git worktree add /tmp/rf-0356e74 0356e74`; copiar `.vercel/project.json`.
2. **Build de produção sem trocar o domínio**: no worktree,
   `vercel deploy --prod --skip-domain --regions gru1 --yes` → cria um deploy de produção (variáveis de
   produção) que **ainda não recebe tráfego**.
3. **Conferir antes de promover**:
   - a API mostra `regions: ["gru1"]`, `target: production`, `gitCommitSha` 0356e74;
   - a lista de arquivos de `apps/`, `packages/`, `supabase/` e `pnpm-lock.yaml` é idêntica à de
     `dpl_Dw6UZ7` (diferem só amostras de teste ignoradas pelo git);
   - na URL única, com o cabeçalho de bypass: `x-vercel-id` contém `gru1`; páginas públicas 200;
     rotas protegidas → login; teste logado com conta temporária (só se autorizada);
   - qualquer falha → **não promover** (produção continua intacta) e parar.
4. **Promover**: `vercel promote <url do deploy gru1>`; conferir `reelsflow-xi.vercel.app` com
   `x-vercel-id` `gru1` e repetir os testes do passo 3.
5. **Observar 30 min**: logs da Vercel sem 5xx; worker/cron inalterados (não dependem da Vercel).
6. **Alinhar a configuração do projeto** (só depois de estável): região padrão do projeto → `gru1`, para que
   um deploy futuro sem `--regions` não volte em silêncio para `iad1`.

**Rollback** (sem build, segundos): `vercel promote dpl_Dw6UZ7FpiXJxY3Gf6UQ6L9Dmxdqk` (ou `vercel rollback`);
o deploy antigo mantém `iad1`. Se o passo 6 já foi feito, voltar a região do projeto para `iad1`.
Não executado aqui: o plano Hobby permite rollback instantâneo para o deploy de produção imediatamente
anterior — que será exatamente o `dpl_Dw6UZ7`. Banco, worker e Zernio não mudam nesta operação.

**Pendência registrada (não alterada):** o envio do CLI inclui arquivos não versionados
(`apps/web/e2e-render/samples/`, fixtures). Não afetam o app, mas convém incluí-los no `.vercelignore` num
deploy futuro autorizado; o worktree limpo do passo 1 já os exclui.
