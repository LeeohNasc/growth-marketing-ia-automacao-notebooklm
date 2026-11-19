# Relatório — Fase 2 (Biblioteca)

Data: 2026-11-19

## Situação do Supabase
Você escolheu pausar um projeto para eu criar `reelsflow-dev`. Na última verificação, os dois projetos ativos (Peixe Casting CRM e ceo-command-staging) continuavam ativos, então **o projeto não foi criado** e nada foi alterado na sua conta. Não pausei nenhum projeto seu.

## Implementado
**Banco (`20261119000002_media_library.sql`)**
- `media_assets` (com estado de upload), `collections`, `collection_items`, `media_jobs`, `storage_gc`; índice trigram para busca por nome.
- RPCs: `begin_media_upload` (valida papel, formato, tamanho e limite do plano; registra o caminho), `complete_media_upload` (confere objeto e tamanho no storage, enfileira análise, mede uso — idempotente), `cancel_media_upload`, `delete_media` (lixeira de 30 dias), `restore_media`, `retry_media_processing`, `reorder_collection`.
- Bucket privado `media` (50 MB por arquivo) e policies: leitura só por membros; escrita só em caminho pré-registrado, por editor, enquanto o vídeo está em `uploading`; sem update/delete pelo cliente.
- Trigger de transição de status do vídeo; limpeza de storage ao excluir workspace.

**Worker (`apps/worker`)** — processo Node contínuo, fora da Vercel
- Fila com `FOR UPDATE SKIP LOCKED`, lease + heartbeat, backoff exponencial com jitter (30 s → 1 h), máximo de 5 tentativas, recuperação de leases expirados.
- Análise: download em streaming → `ffprobe` (duração, resolução já considerando rotação, fps, codecs, áudio, bitrate) → thumbnail com `ffmpeg` → compatibilidade por rede → `ready`. Arquivo que não é vídeo falha de forma permanente, sem retry.
- Manutenção: expira uploads abandonados (24 h), apaga arquivos da lixeira após 30 dias e os arquivos de workspaces excluídos.
- Notificações: uma por lote concluído (não uma por vídeo) e uma por falha.
- Logs JSON com redação de tokens e URLs assinadas. `Dockerfile` com ffmpeg.

**Web**
- **Upload em massa**: seleção múltipla e arrastar-e-soltar; SHA-256 em streaming no navegador; aviso de duplicado (no workspace e no lote) com "enviar mesmo assim" / "ignorar"; envio TUS direto ao storage (chunks de 6 MB, exigência do Supabase), 3 em paralelo, progresso por arquivo e total; retomada automática após queda de rede e retomada após recarregar a página (ao selecionar o mesmo arquivo); cancelar; tentar novamente; aviso ao fechar a aba durante envio. O token é renovado a cada requisição, então envios longos não quebram com a expiração da sessão.
- **Biblioteca**: grade e lista; busca por nome; filtros por status; ordenação por data, nome ou ordem manual (na coleção); paginação (48); seleção múltipla com ações em lote (adicionar/remover de coleção, reprocessar, excluir, restaurar); coleções (criar, excluir, reordenar com botões acessíveis); lixeira; atualização automática enquanto há vídeos em análise.
- **Painel do vídeo**: player com URL assinada de 10 min, metadados, compatibilidade por rede com motivos, edição de nome/legenda/hashtags, coleções, ações.

## Regras de compatibilidade — atenção
Os limites numéricos (ex.: duração 3 s–15 min no Instagram, 90 s no Facebook, 3 min para Shorts) **não foram confirmados na documentação oficial**. Por isso só geram **aviso**; **erro** apenas para o que certamente impede a publicação (sem trilha de vídeo, contêiner/codec fora do aceito, ex.: WebM/VP9 no Instagram). A versão das regras é gravada em cada vídeo (`2026-11-19-preliminar`) para reavaliação na Fase 4.

## Testes executados
| Suíte | Resultado |
|---|---|
| Typecheck (4 pacotes) e lint | sem erros |
| Domínio (validação, parsing de ffprobe real, compatibilidade, hashtags) | 31/31 |
| Banco / RLS / storage (inclui 21 novos de mídia) | 60/60 |
| Integração do worker (Postgres real + ffmpeg real + storage em disco) | 16/16 |
| Build de produção | OK (20 rotas) |
| E2E Playwright desktop + mobile | 36/36 |

Destaques do worker: 3 workers concorrentes nunca pegam o mesmo job (40 jobs); worker que "morre" no meio do processamento é recuperado; erro transitório reagenda e, na última tentativa, marca o vídeo como falho; vídeo restaurado não é apagado pela limpeza.

## O que NÃO foi validado (e por quê)
- **Envio real ao Supabase Storage (TUS)**, policies no storage real, URLs assinadas, player e thumbnails no navegador: sem projeto Supabase. As policies foram testadas contra uma emulação de `storage.objects`; o servidor real de storage pode ter comportamento adicional (ex.: exigências de policy no fluxo TUS) que só o teste real revela.
- **Interface de upload e biblioteca com sessão real**: compilam, passam no lint/typecheck, mas não foram abertas no navegador logado.
- **Docker do worker**: Docker indisponível neste ambiente; o `Dockerfile` não foi construído.
- **Hash no navegador** roda na thread principal (cedendo o event loop entre blocos); com centenas de arquivos grandes pode deixar a interface lenta. Mover para Web Worker se a medição mostrar problema.

## Pendências
1. Projeto Supabase (bloqueador para validar Fases 1 e 2 de ponta a ponta).
2. Hospedagem do worker (custo ~US$ 5–10/mês; exige sua autorização).
3. Arquivos > 50 MB exigem Supabase Pro ou outro storage (decisão D2).
4. Herdadas da Fase 1: termos/privacidade, CSP, convites de membros.

## Riscos
- Limite de 50 MB por arquivo inviabiliza vídeos reais longos/alta qualidade no plano Free.
- Download do vídeo inteiro pelo worker para analisar consome egress; para vídeos grandes, avaliar ffprobe por range request.
- Tipos do banco seguem escritos à mão até gerar com o projeto real.

## Próxima fase recomendada
Antes da Fase 3: liberar um slot no Supabase → eu crio `reelsflow-dev`, aplico as 2 migrations, rodo as suítes de RLS contra o banco real e testo cadastro → upload → análise de ponta a ponta. Depois, Fase 3 (agendamento com conector mock).
