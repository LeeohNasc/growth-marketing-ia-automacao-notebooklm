# Relatório — Fase 3 (Agendamento)

Data: 2026-11-19

## Contexto e trade-off registrado
Você pediu para avançar sem validar as Fases 1–2 no Supabase real (o slot do plano Free continuava ocupado). Recomendei o contrário; seguimos com o risco aceito: **se o Supabase real revelar diferença (auth, storage, RLS), pode haver retrabalho nas fases anteriores e nesta.** Nenhum projeto Supabase foi criado ou alterado.

## Implementado
**Domínio (`packages/domain/src/scheduling`)** — funções puras
- Geração de slots por dias da semana × horários × fuso, com datas inicial/final, bloqueio de passado e política explícita de horário de verão (horário inexistente → avança e sinaliza; ambíguo → primeira ocorrência), via Temporal.
- Ordem: primeiro enviado, mais antigo, mais recente, personalizada e aleatória com semente persistida (determinística).
- Planejador nos modos espelhado (com deslocamento por conta) e filas independentes (horários e vídeos por conta); incompatíveis pulados só na rede afetada e listados; anexar ao fim da fila.
- Precedência vídeo > campanha > conta > global com origem do valor; composição de legenda + hashtags.
- Máquina de estados (13 estados) e política de retry (backoff exponencial com jitter; Retry-After tem precedência).

**Conectores (`packages/connectors`)**
- Contrato comum de publicação (publicar com checkpoints, consultar status, classificar erros). Métodos de OAuth entram na Fase 4 com o primeiro conector real.
- Conector **simulado** persistido em banco, sem idempotência (como algumas APIs reais), com 10 comportamentos: sucesso, lento, falha na 1ª tentativa, falha temporária, rejeição, timeout antes/depois de publicar, limite de requisições, token revogado, resultado nunca confirmado.
- Instagram/Facebook/TikTok/YouTube marcados como indisponíveis, com o motivo exibido.

**Banco (`20261119000003_scheduling.sql`)**
- Contas sociais, modelos, campanhas, alvos, itens, `publication_jobs`, tentativas, publicações externas, automações, execuções e heartbeats.
- Máquina de estados imposta por trigger — **teste compara as 169 transições com o domínio**.
- Índice único: mesmo vídeo/conta/campanha só uma vez; **no máximo uma publicação em andamento por conta**.
- RPCs com validação: gravar plano (só horários futuros, objetos da própria campanha), ativar/pausar/retomar/arquivar, cancelar, reagendar (fixa a publicação), editar legenda, confirmar publicação manual, regras de automação, conta simulada.

**Worker**
- Scheduler: promove publicações vencidas; política de atraso (passou da tolerância → revisão, sem rajada); respeita pausas de campanha, conta e fila.
- Claim com `SKIP LOCKED`, uma por conta, espaçamento mínimo, lease + heartbeat.
- Execução com checkpoint gravado **antes** de cada efeito externo; erros classificados: transitório/limite → retry com backoff; permanente/esgotado → falha definitiva (dead-letter) + aviso; auth → conta “requer reconexão”, publicações aguardam, admins avisados; timeout/erro **após** efeito externo → **estado incerto** (nunca repetido às cegas).
- Reconciliador: consulta a plataforma pelo checkpoint → publicado / retry seguro / revisão humana após 5 consultas.
- Reaper: lease expirado sem checkpoint → volta à fila; com checkpoint → incerto.
- Automações (as 5 do prompt, configuráveis e auditadas): coleção → fim da fila; retry; aviso de pouco conteúdo (1×/dia); conclusão com resumo; pausa por perda de autorização.

**Web**
- Contas Conectadas (contas simuladas com seletor de comportamento; pausar; espaçamento; remover), Modelos, Campanhas (assistente vídeos → contas/modelo → calendário em rascunho → revisão → ativar; detalhe com valores efetivos e origem, conflitos, vídeos sem publicação e o motivo, contas, vídeos com ordem manual e exceção de legenda, configuração com recálculo, adicionar vídeos ao fim), Calendário (dia/semana/mês/lista, arrastar entre dias com validação de horário/elegibilidade/conflito, painel acessível para reagendar), Fila (filtros, ações em lote, pausar fila, tentativas e erros), Histórico, Automações e Visão Geral com métricas reais e alertas (worker parado, contas sem autorização, itens em revisão).

## Testes executados
| Suíte | Resultado |
|---|---|
| Typecheck (5 pacotes), lint | sem erros |
| Domínio (inclui 23 de agendamento) + conectores | 56 + 5 |
| Banco / RLS (inclui 20 de agendamento) | 80/80 |
| Worker: mídia + publicação (23 novos) | 39/39 |
| Stress de concorrência: 15 rodadas × 30 publicações × 3 workers | 0 duplicadas |
| Build | OK |
| E2E Playwright desktop + mobile | 48/48 |

Cenários cobertos com o conector simulado, como exige a seção 18: um e três por dia, horários personalizados, mudança de fuso, horário de verão, campanha pausada/retomada, reagendamento, conflitos, concorrência entre workers, sucesso, erro transitório, erro permanente, timeout (antes e depois do envio), rate limit, token revogado, resultado incerto e reconciliação.

**Bug real encontrado pelos testes e corrigido:** na reivindicação de publicações, a checagem de status estava num subquery e não no nível do lock; sob concorrência, um segundo worker podia reivindicar uma publicação já reivindicada (risco de **publicação duplicada**). Corrigido revalidando status no nível do lock e no `UPDATE`; o índice único por conta é a segunda barreira.

## O que NÃO foi validado
- **Nada com o Supabase real** (Fases 1–3). Os testes rodam em Postgres 16 local com emulação mínima de auth/storage.
- **Telas desta fase com sessão real**: compilam, passam no lint/typecheck e na proteção de rotas, mas não foram usadas logadas no navegador. A camada que junta dados do banco ao planejador (`lib/planning.ts`) não tem teste automatizado próprio — suas partes (planejador e RPC) têm.
- **Publicação real**: nenhuma. O conector simulado não acessa redes.

## Pendências
1. Projeto Supabase para validar Fases 1–3 de ponta a ponta (bloqueador).
2. Hospedagem do worker (exige autorização de custo).
3. Janela de congelamento de 2 min deve ser revista por conector na Fase 4 (Instagram precisa preparar o container antes).
4. Herdadas: termos/privacidade, CSP, convites, limite de 50 MB.

## Riscos
- Mudanças em campanha ativa recalculam o futuro: datas de publicações não fixadas podem mudar (comportamento esperado, mas pode surpreender; a tela avisa).
- Calendário com fuso da publicação diferente do fuso do workspace: arrastar usa a data exibida e o horário local da publicação.
- Sem Supabase real, tipos do banco seguem escritos à mão.

## Próxima fase recomendada
Antes da Fase 4: validação real (Supabase). A Fase 4 (Meta) depende ainda de: conta Meta Business verificada, app de desenvolvedor, domínio, política de privacidade e termos — itens que só você pode providenciar.
