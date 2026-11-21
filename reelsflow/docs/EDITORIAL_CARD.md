# Card Editorial

> Estado em 2026-11-21: **implementado e testado localmente; NÃO aplicado nem implantado em produção.**
> Branch: `claude/reelsflow-editorial-card`.

## O que é

Novo tipo de conteúdo em **Criar publicação → Modelos → Card Editorial**: fundo branco, avatar redondo,
nome da página + `@usuário`, manchete e, abaixo, foto, duas fotos lado a lado ou vídeo. Formatos
1080×1350 (4:5), 1080×1080 (1:1) e 1080×1920 (9:16). O card inteiro faz parte do arquivo final.

## Arquitetura (reaproveitando o pipeline existente)

```
editor (navegador) ── rascunho ──► editorial_cards (RLS) + origens em {ws}/cards/{card}/…
      │
      └─ Renderizar: drawCard (MESMA função da prévia) → JPEG | MP4 (WebCodecs)
             └─► begin_media_upload → upload → complete_media_upload → attach_card_render
                    └─► worker analisa o arquivo FINAL (tipo real, dimensões, codec, duração)
                           └─► card "pronto" → Agendar (campanha com o render pré-selecionado)
                                  └─► publicação usa a mídia do render (nunca as origens)
```

- **Renderização no navegador** (canvas + WebCodecs + `mediabunny@1.65.2`): o worker do ReelsFlow roda
  em Edge Function (Deno, sem FFmpeg) e não pode codificar vídeo; não há serviço pago. Prévia e arquivo
  final usam o **mesmo `drawCard`** e o mesmo tipo de canvas → idênticos pixel a pixel (testado).
- **Imagem**: JPEG (publicação) e PNG (download), na resolução exata.
- **Vídeo**: MP4 H.264 **yuv420p faixa TV, BT.709** (a conversão RGB→YUV é feita pelo app; os codificadores
  WebCodecs gerariam faixa cheia/`yuvj420p`), `faststart`, duração da origem, **áudio AAC original copiado**
  sem recodificar (sincronia e qualidade preservadas). A aba precisa ficar aberta durante a renderização.
- **Fonte**: Inter (OFL) servida pelo próprio app (`public/fonts`); emoji pela fonte do sistema.

## Banco — migration `20261121000011_editorial_cards.sql` (só acrescenta)

| Mudança | Por quê |
|---|---|
| `media_assets` aceita `image/jpeg`; coluna gerada `kind` (video/image); `source_card_id` | o render final em imagem entra na Biblioteca/campanhas como qualquer mídia |
| `begin_media_upload` aceita JPEG (`.jpg`) | upload verificado do render final |
| bucket aceita PNG/WebP (origens do card) | avatar/fotos de origem |
| `editorial_cards` + RLS (viewer lê; editor cria/edita) | rascunhos com só o necessário |
| caminhos de origem obrigatoriamente em `{workspace}/cards/` (CHECK) | nada de outro workspace |
| policy de storage para origens de card existente do workspace | upload direto do navegador, isolado |
| `render_status`/`rendered_media_id` fora do grant de UPDATE; `set_card_render_state`, `attach_card_render` | o cliente não declara "pronto" nem aponta render arbitrário |
| trigger: análise do worker → card `ready`/`error`; edição de conteúdo → volta a `draft` | estado real, sem render desatualizado |
| `duplicate_editorial_card`, `delete_editorial_card` (limpa origens órfãs pelo job `purge` existente) | duplicar/excluir sem vazar arquivos |

## Publicação

- Card em **vídeo**: publicado como Reel (qualquer conector de vídeo).
- Card em **imagem**: post de feed **somente por contas via Zernio** (Instagram/Facebook). O conector direto
  da Meta só publica Reels: recusa imagem com mensagem clara, e o planejador nem cria a publicação.
- Imagem **9:16** não é aceita no feed do Instagram: aviso no editor e erro de compatibilidade.
- A legenda da postagem é um campo separado do texto impresso no card (botão "copiar a manchete").

## Testes

| Suíte | Resultado |
|---|---|
| Domínio (layout, quebra por grafema, overflow, enquadramento, YUV BT.709, compatibilidade de imagem) | 79/79 |
| Conectores (Zernio imagem, Meta recusa imagem) | 67/67 |
| Banco (RLS, storage, caminhos, render só por RPC/trigger, duplicar/excluir) | 119/119 |
| Worker (análise de JPEG real/progressivo/falso, modo remoto, **agendador publica o render final**) — `pg` e `postgres.js` | 78/78 |
| Renderização real no Chromium (PNG/JPEG/MP4 inspecionados por pixel e `ffprobe`) | 11/11 |
| Editor real (interface) com Supabase falso: 3 formatos, salvar, render, envio do arquivo final, falha/nova tentativa, vídeo, celular | 5/5 |
| E2E existentes do app (regressão, desktop + celular) | 64/64 |

Não executado: editor contra o Supabase real (a migration 11 não está em produção) e publicação real.

## Limites conhecidos

- Renderização de vídeo depende do navegador: precisa de WebCodecs (Chrome/Edge/Safari atuais). HEVC
  (comum em `.MOV` de iPhone) só funciona onde o navegador decodifica HEVC; caso contrário, mensagem clara.
- Áudio precisa ser AAC na origem (padrão de câmeras/celulares); outro codec é recusado com mensagem.
- Origens: tipo real verificado pelos bytes no navegador; o servidor confere MIME declarado e tamanho
  (bucket) e o caminho (banco). O arquivo **final** é verificado pelo servidor (worker) antes de agendar.
- Arquivos até 50 MB (limite atual do armazenamento).

## Colocar em produção (exige autorização)

1. Aplicar `supabase/migrations/20261121000011_editorial_cards.sql`.
2. Republicar o worker (`worker-tick`) com o bundle desta branch (análise de imagem).
3. Deploy do app na Vercel.
4. Homologação: criar um card em imagem e um em vídeo, renderizar, conferir na Biblioteca e agendar
   um deles para a Pipocou (via Zernio).
