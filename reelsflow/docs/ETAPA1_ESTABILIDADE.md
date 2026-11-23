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
