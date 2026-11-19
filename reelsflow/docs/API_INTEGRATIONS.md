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
