# PRD — ReelsFlow

Versão 0.1 · Fase 0 · 2026-11-19

## 1. Problema

Quem produz vídeos curtos em volume (criadores, social medias, agências) publica e agenda cada vídeo individualmente, em cada rede, repetindo legenda, hashtags e horário. O trabalho é manual, repetitivo e sujeito a erro (vídeo duplicado, horário esquecido, conta desconectada sem aviso).

## 2. Objetivo

Permitir que o usuário **envie dezenas ou centenas de vídeos uma vez**, aplique um **modelo de publicação reutilizável** e deixe um **motor de agendamento persistente** distribuir as publicações por dias/semanas/meses, com status transparente de cada item.

Fluxo-alvo: **Entrar → Enviar vídeos → Escolher modelo → Gerar calendário → Revisar → Ativar.**

### Métricas de sucesso do produto (a medir, não metas inventadas)

| Métrica | Definição |
|---|---|
| Tempo até a primeira campanha ativa | Do cadastro à primeira campanha com status `active` |
| Taxa de publicação bem-sucedida | `published / (published + failed_permanent)` por janela, excluindo cancelados |
| Taxa de estado incerto | `uncertain / total de tentativas` — indicador de saúde do conector |
| Pontualidade | Percentil 95 de `published_at − scheduled_at` |
| Cobertura de fila | Dias de conteúdo agendado restantes por campanha ativa |

Os valores-alvo serão definidos após medir o baseline no ambiente real; não há dados que sustentem metas agora.

## 3. Público e personas

| Persona | Necessidade central | Implicação de produto |
|---|---|---|
| Criador solo | Manter frequência sem esforço diário | Fluxo simples, 1 conta por rede, modelos prontos |
| Social media freelancer | Vários clientes, pouco tempo | Workspaces separados, troca rápida, calendário |
| Agência | Equipe, aprovação, relatórios | RBAC, múltiplos workspaces, auditoria (Fase 5) |
| PME / produtora | Reaproveitar acervo de vídeos | Biblioteca, coleções, detecção de duplicados |

## 4. Escopo do MVP (Fases 1–4)

### 4.1 Contas e workspaces
- Cadastro, login, confirmação de e-mail, recuperação de senha, logout, perfil, exclusão de conta (Supabase Auth).
- Workspace criado no onboarding; usuário pode pertencer a vários.
- Papéis: `owner`, `admin`, `editor`, `viewer` (RBAC aplicado no banco via RLS).

### 4.2 Upload em massa e biblioteca
- Seleção múltipla e arrastar-e-soltar; progresso individual; cancelamento; retomada (TUS) quando a conexão cair.
- Upload **direto do navegador para o storage** (nunca através do Next.js).
- SHA-256 calculado no cliente (Web Worker) para detectar duplicados **antes** de enviar; duplicado gera aviso, não bloqueio silencioso.
- Pós-processamento assíncrono no worker: `ffprobe` (duração, resolução, proporção, codec, fps, áudio), thumbnail, verificação de compatibilidade por plataforma.
- Biblioteca: grade/lista, filtros por status/compatibilidade, busca por nome, seleção múltipla, coleções, ordenação manual ou por data, painel de detalhes, player, edição de metadados, histórico.
- Exclusão: se houver publicações futuras dependentes, o usuário deve escolher **cancelar**, **substituir** ou **abortar**. Registros históricos de publicações nunca são apagados com o arquivo.

### 4.3 Modelos de publicação
- Campos: nome, redes/contas-alvo, modo (espelhado ou filas independentes), dias da semana, horários, fuso, quantidade por dia, legenda padrão, hashtags padrão, ordem (upload, mais antigo, mais recente, manual, aleatória com semente persistida), data inicial, data final opcional.
- Precedência explícita: **vídeo > campanha > conta > global**. A tela de revisão mostra o **valor efetivo** e a origem de cada campo.

### 4.4 Campanhas e motor de agendamento
- Campanha = modelo aplicado a um conjunto ordenado de vídeos.
- Geração automática dos slots e atribuição dos vídeos (ex.: 90 vídeos × 3/dia = 30 dias).
- Pausar/retomar campanha; pausar conta; pausar fila global do workspace.
- Reordenar, substituir vídeo, excluir publicação futura, editar legenda/horário, adicionar vídeos ao final.
- Bloquear horários no passado; detectar conflitos (mesma conta com publicações em intervalo menor que o espaçamento mínimo configurado); impedir duplicidade (mesmo vídeo, mesma conta, mesma campanha).
- Fuso horário e horário de verão tratados corretamente (ver ARCHITECTURE §4).
- **Política de atraso** (não prevista no prompt, necessária): se o worker ficar indisponível e uma publicação passar da tolerância configurada, ela vai para `needs_review` em vez de ser publicada em rajada.

### 4.5 Fila operacional
- Lista com identificador, vídeo, rede, conta, data prevista, data efetiva, status, tentativas, último erro, ID externo e link.
- Filtros e ações em lote (cancelar, reagendar, reenfileirar falhas, marcar revisão).
- Botão "pausar fila" do workspace.

### 4.6 Contas conectadas
- OAuth oficial; lista de contas autorizadas; permissões concedidas vs. necessárias; status do token; reconectar; desconectar.
- Perda de autorização → pausa automática das publicações da conta + notificação.

### 4.7 Notificações internas
Upload concluído/falho, campanha iniciada/concluída, publicação realizada/com erro, conta desconectada, token expirando, fila com menos de N dias de conteúdo, limite de plano atingido. Arquitetura pronta para e-mail (envio real fora do MVP).

### 4.8 Automações (regras)
MVP com as 5 regras do prompt como **regras pré-definidas configuráveis** (liga/desliga + parâmetros), todas auditadas. Um motor genérico "se X então Y" editável pelo usuário fica para depois — o custo de construí-lo agora não se justifica sem uso real.

## 5. Fora do MVP (Fase 5+)
TikTok e YouTube em produção (conectores são preparados, mas dependem de auditoria/verificação), IA (legendas, hashtags, títulos, similaridade, resumo de desempenho), analytics com métricas das plataformas, cobrança real, equipes avançadas/aprovação, e-mail transacional, transcodificação automática para variantes.

## 6. Requisitos não funcionais
- Nenhuma senha de rede social solicitada; nenhuma automação de navegador; só APIs oficiais.
- Publicação não depende do navegador aberto.
- Isolamento total entre workspaces (RLS em todas as tabelas de domínio).
- Tokens OAuth criptografados, acessíveis apenas pelo servidor/worker.
- Dark mode padrão (grafite + vermelho/coral), light mode opcional, responsivo, WCAG 2.1 AA como alvo.
- Dados demonstrativos apenas em workspace marcado `is_demo = true`, com selo visível em todas as telas.

## 7. Mapa de telas

```
/ (marketing mínimo)            /login  /signup  /forgot-password  /reset-password  /auth/callback
/onboarding                     → criar workspace → conectar conta (opcional) → primeiro upload
/w/[workspace]/
  overview                      KPIs reais, próxima publicação, alertas, calendário resumido, atividade
  library                       grade/lista, filtros, busca, coleções, painel de detalhes (drawer)
  upload                        dropzone, fila de upload com progresso/retomada/cancelamento
  calendar                      dia / semana / mês / lista; drag-and-drop com validação
  queue                         tabela operacional, filtros, ações em lote, pausar fila
  campaigns                     lista · [id] detalhes · new (wizard: vídeos → modelo → revisão → ativar)
  templates                     lista · [id] editor com pré-visualização do valor efetivo
  accounts                      contas conectadas, permissões, reconexão
  history                       publicações concluídas/falhas, links externos
  analytics                     placeholder honesto até haver dados reais (Fase 5)
  automations                   regras pré-definidas + log de execução
  notifications                 central de notificações
  settings                      workspace, membros, fuso padrão, defaults globais, exclusão de dados
  billing                       plano atual e uso medido (sem cobrança real)
/account                        perfil, segurança, exclusão de conta
```

Wizard de campanha (fluxo principal):
1. **Vídeos** — selecionar da biblioteca ou enviar agora; incompatíveis aparecem marcados por rede.
2. **Modelo** — escolher/criar; ajustar exceções.
3. **Revisão** — calendário gerado, valores efetivos, conflitos, avisos de limite de plataforma (ex.: cota diária).
4. **Ativar** — confirmação explícita; a campanha vira `active` e os jobs passam a `scheduled`.

## 8. Critérios de aceitação do MVP

### 8.1 Internos (dependem só do software)
1. Criar conta e entrar.
2. Criar workspace.
3. Enviar ≥ 50 vídeos em lote com progresso e retomada após interrupção.
4. Ver metadados e thumbnails na biblioteca.
5. Criar modelo com frequência diária e múltiplos horários.
6. Gerar calendário automaticamente e ver valores efetivos.
7. Editar, reordenar e cancelar publicações futuras.
8. Pausar e retomar campanhas.
9. Processar a fila persistente com o conector mock, com dois workers concorrentes, sem publicação duplicada.
10. Recuperar falhas simuladas (transitória, permanente, timeout, rate limit, token revogado, incerta).
11. Consultar status e histórico.
12. Teste automatizado comprova que usuário A não acessa dados do workspace de B (banco e storage).

### 8.2 Externos (dependem de autorização de terceiros)
13. Conectar contas Meta — **bloqueado** até existir app Meta com permissões e (para uso por terceiros) App Review aprovado.
14. Publicar conteúdo real em contas elegíveis — **bloqueado** pelo mesmo motivo; validável antes com contas de teste/desenvolvedor do próprio app.

Passar nos testes locais **não** torna o sistema pronto para produção (ver ROADMAP, "Prontidão para produção").
