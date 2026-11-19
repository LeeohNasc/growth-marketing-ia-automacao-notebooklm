# Integrações oficiais — ReelsFlow

Versão 0.1 · Fase 0 · pesquisa feita em 2026-11-19.

**Regra:** nenhum dado abaixo substitui a leitura da documentação oficial no momento da implementação de cada conector. Números marcados *(a confirmar)* divergem entre fontes ou vieram de material de terceiros.

Proibições permanentes: pedir senhas, usar cookies capturados, automação de navegador, contornar CAPTCHA, burlar limites.

## Resumo de viabilidade

| Plataforma | API | Publicação pública automática no MVP? | Principal bloqueio |
|---|---|---|---|
| Instagram Reels | Instagram Platform (Content Publishing) | **Sim, para contas profissionais**, após App Review do app Meta | App Review + verificação do negócio; cota de publicações/24 h |
| Facebook Reels (Páginas) | Video API — Reels Publishing | **Sim, para Páginas administradas**, após App Review | App Review; sem chave de idempotência |
| TikTok | Content Posting API (Direct Post) | **Não** até auditoria — apps não auditados só publicam como privado (`SELF_ONLY`) | Auditoria do app pelo TikTok |
| YouTube Shorts | YouTube Data API v3 (`videos.insert`) | **Não** até auditoria — projetos não verificados criados após 28/07/2020 têm uploads restritos a privado | Verificação OAuth + auditoria de conformidade da API |

## Atualização 2026-11-19 (Fase 4) — fatos lidos na documentação oficial, Graph API v27.0

| Item | Instagram (Facebook Login) | Facebook Reels (Página) |
|---|---|---|
| Permissões | instagram_basic, instagram_content_publish, pages_read_engagement (+ ads_management/ads_read se a Página está em Business Manager) | pages_show_list, pages_read_engagement, pages_manage_posts; token de Página de usuário com tarefa CREATE_CONTENT |
| Limite | **50 publicações / 24 h** (content_publishing_limit e media_publish; a página geral cita 100 — conflito na própria doc); 400 containers / 24 h | **30 Reels / 24 h** por Página |
| Fluxo | POST /{ig}/media (media_type=REELS, video_url público) → status_code → POST /{ig}/media_publish | POST /{page}/video_reels start → rupload (file_url) → finish (video_state=PUBLISHED) |
| Status | EXPIRED, ERROR, FINISHED, IN_PROGRESS, PUBLISHED; consultar ~1/min por até 5 min; container expira em 24 h | video_status + fases uploading/processing/publishing; publish_status draft/error/published/scheduled |
| Idempotência | **Não documentada** para media_publish; doc recomenda consultar o container (PUBLISHED) antes de repetir | Não há chave de idempotência |
| Especificação | MOV/MP4, H.264/HEVC, AAC, 23–60 fps, largura ≤ 1920, 3 s–15 min, ≤ 300 MB | MP4 recomendado, H.264/H.265/VP9/AV1, AAC, 24–60 fps, ≥ 540×960, 3–90 s |
| Erros de limite | 4, 17, 32, 613, 80001 (Páginas), 80002 (Instagram); `X-Business-Use-Case-Usage.estimated_time_to_regain_access` | idem |

Não confirmados (best-effort no código): campo `permalink` do IG Media e `permalink_url` do vídeo (não constam nas páginas lidas); token de Página vs. de usuário para o Instagram (a própria doc é inconsistente — o código usa o token de Página).

## 1. Instagram (Meta)

Fatos (documentação oficial):
- Fluxo em dois passos: criar container (`POST /{ig-user-id}/media` com `media_type=REELS` e `video_url`) → aguardar processamento (`GET /{container-id}?fields=status_code`) → publicar (`POST /{ig-user-id}/media_publish`).
- `video_url` precisa estar acessível publicamente pela Meta → usaremos URL assinada de curta duração.
- Endpoint `GET /{ig-user-id}/content_publishing_limit` informa uso e cota da conta. A referência oficial indica **50 publicações por 24 h móveis**; outras páginas citam 100 *(a confirmar — o conector deve ler o endpoint, nunca fixar o número)*. A cota vale para todos os tipos de mídia, não só Reels.
- Containers não publicados expiram (fontes indicam 24 h *(a confirmar)*) → o container é criado perto do horário (`prep_lead`, ex.: 30 min), nunca dias antes.
- Duas variantes de acesso: *Instagram API with Instagram Login* (não exige Página do Facebook) e *with Facebook Login* (conta profissional vinculada a uma Página). Permissões diferem (`instagram_business_content_publish` vs `instagram_content_publish` *(nomes a confirmar na implementação)*).
- Publicar para contas de terceiros exige **Advanced Access** via App Review; antes disso, só contas com papel no app (desenvolvedor/testador).

Reconciliação: o `status_code` do container (ex.: `FINISHED`, `PUBLISHED`, `ERROR`, `EXPIRED`, `IN_PROGRESS`) permite saber, após um timeout em `media_publish`, se a publicação ocorreu. **O `container_id` é salvo como checkpoint antes de qualquer chamada de publicação.**

## 2. Facebook Pages (Meta)

Fatos (documentação oficial do Reels Publishing API):
- Três fases: `POST /{page-id}/video_reels` `upload_phase=start` → retorna `video_id` e URL de upload; envio de bytes para `rupload.facebook.com/video-upload/{video_id}` (retomável por offset; alternativa `file_url`); `POST /{page-id}/video_reels` `upload_phase=finish` com `video_state=PUBLISHED` (ou agendado/rascunho) e descrição.
- Status consultável em `GET /{video-id}?fields=status` (fases de upload, processamento e publicação).
- Requer token de Página com permissões de publicação (`pages_manage_posts`, `pages_read_engagement`, etc. *(lista exata a confirmar)*).
- Um material de terceiros cita limite de ~30 Reels/24 h por Página *(não confirmado em fonte oficial)*.
- **Não há chave de idempotência**: retry só depois de consultar o status do `video_id` salvo.

## 3. TikTok

Fatos (TikTok for Developers):
- Content Posting API com Direct Post (`/v2/post/publish/video/init/`) e upload por `FILE_UPLOAD` (partes) ou `PULL_FROM_URL` (exige verificação de propriedade do domínio/prefixo de URL).
- Antes de publicar é obrigatório consultar `/v2/post/publish/creator_info/query/`; `privacy_level` deve ser uma das opções retornadas. As diretrizes exigem UI específica de consentimento (escolha de privacidade pelo usuário, aviso de conteúdo comercial, etc.).
- **Apps não auditados**: conteúdo só em modo privado (`SELF_ONLY`); diretrizes citam limite de até 5 usuários publicando em 24 h; erro típico `unaudited_client_can_only_post_to_private_accounts`.
- Status por `publish_id` (`/v2/post/publish/status/fetch/`) → base da reconciliação.
- Implicação de produto: o modelo "publicar automaticamente sem intervenção" pode conflitar com a exigência de que o criador escolha privacidade e configurações **por publicação**. Isso precisa ser lido na auditoria; o design da UI do TikTok será feito a partir das diretrizes, não do modelo genérico.

Estado no MVP: conector preparado, **desabilitado** na UI com explicação até a auditoria.

## 4. YouTube

Fatos (Google):
- Upload via `videos.insert` (protocolo resumível). Não existe endpoint específico de Shorts; a classificação como Short é feita pelo YouTube (vídeo vertical/quadrado e duração dentro do limite de Shorts — limite exato *(a confirmar)*). A UI dirá "enviado como vídeo; pode ser classificado como Short".
- Projetos de API não verificados criados após 28/07/2020: vídeos ficam **restritos a privado** e não podem ser liberados depois — é preciso reenviar após verificação. Isso exige concluir a auditoria antes de qualquer uso real.
- Custo de cota de `videos.insert`: fontes divergem — histórico de 1.600 unidades em cota diária padrão de 10.000; documentação recente menciona um bucket separado de uploads *(a confirmar na tabela oficial de custos antes de implementar)*.
- Sem idempotência; após timeout, reconciliar listando uploads recentes do canal e casando por título + duração + horário. Opcional: tag técnica `rf-{hash}` no vídeo (visível em metadados — exige consentimento do usuário).

Estado no MVP: conector preparado, **desabilitado** até verificação + auditoria.

## 5. Pré-requisitos externos (ações do responsável pelo produto)

| Item | Quem | Bloqueia |
|---|---|---|
| Conta de desenvolvedor Meta + app + verificação do negócio | Você | Fase 4 em produção |
| Domínio próprio, política de privacidade, termos de uso, URL de exclusão de dados (callback) | Você + eu (páginas) | App Review Meta/TikTok/Google |
| Screencast do fluxo para App Review | Eu preparo, você envia | Advanced Access Meta |
| App TikTok + auditoria | Você | TikTok público |
| Projeto Google Cloud + tela de consentimento verificada + auditoria da YouTube API | Você | YouTube público |

**Recomendação:** iniciar os cadastros Meta (verificação do negócio) já durante as Fases 1–3. É o caminho crítico do MVP e o prazo depende de terceiros.

## Fontes
- [Instagram Content Publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/)
- [IG User Content Publishing Limit](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit)
- [Facebook Reels Publishing API](https://developers.facebook.com/docs/video-api/guides/reels-publishing)
- [TikTok Direct Post reference](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post)
- [TikTok Query Creator Info](https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info)
- [TikTok Content Sharing Guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines)
- [YouTube videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert)
- [YouTube quota cost](https://developers.google.com/youtube/v3/determine_quota_cost)
