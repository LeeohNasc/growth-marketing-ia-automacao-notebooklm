# Instagram — publicação real (Instagram API with Instagram Login)

> Estado em 2026-11-20: **implementado e testado contra respostas simuladas; NÃO homologado.**
> Nenhuma publicação real foi feita. A integração só será declarada funcional depois de um
> Reel publicado de verdade numa conta autorizada, com ID e permalink conferidos no Instagram.

## 1. Auditoria (antes desta etapa)

| Item | Estado encontrado | Classificação |
|---|---|---|
| Publicador simulado (`mock`) | Funciona em produção; única "publicação" feita até hoje | **Simulador** — não prova nada sobre o Instagram |
| Instagram via *Facebook Login* (`graph.facebook.com`, `instagram_basic`/`instagram_content_publish`, exige Página do Facebook) | Código completo + testes com Graph simulada | **Implementação real não homologada** — e é outro produto da Meta |
| Facebook Pages (Reels) | Código completo + testes simulados | Implementação real não homologada (fora do escopo desta etapa) |
| Fila, lease, checkpoint, estado incerto, reconciliação, cifra de tokens, state OAuth | Testados (banco real + Graph simulada) | Reaproveitados sem mudança de conceito |
| Funcionalidade homologada com publicação real | Nenhuma | — |

## 2. O que mudou

- **Instagram usa só o Instagram Login** (`www.instagram.com/oauth/authorize` → `api.instagram.com/oauth/access_token` → `graph.instagram.com`).
  Escopos: `instagram_business_basic`, `instagram_business_content_publish`. Sem Página do Facebook.
  O Facebook Login ficou restrito a Páginas do Facebook.
- **Token**: curto (1 h) → longo (60 dias), cifrado (AES-256-GCM) com contexto `instagram:<id da conta>`;
  renovado pelo worker quando faltam ≤ 15 dias (regra da doc: token com ≥ 24 h); aviso aos admins
  com ≤ 7 dias; vencido ou negado → conta "Requer reconexão" + notificação.
- **Nunca publicar em outra conta**: antes de qualquer chamada que crie conteúdo, o worker faz
  `GET /me` com o token e exige `user_id` = conta escolhida. Na conexão e na renovação, a mesma checagem.
- **IDs de 17 dígitos** preservados como texto (o `JSON.parse` padrão arredondaria `user_id`).
- **Publicação**: cota (`content_publishing_limit`) → container `REELS` com `video_url` assinado (2 h)
  → espera `FINISHED` → checkpoint → `media_publish` → `permalink`.
  Processamento lento não gasta tentativas (retoma o mesmo container a cada ~1 min; desiste após 30 min).
  Falha depois de `media_publish` sem resposta → "incerto" → reconciliação pelo status do container
  (`PUBLISHED`) — nunca um segundo `media_publish` às cegas.
- **Telas**: Contas conectadas (foto, nome, @, status, validade, desconectar/reconectar); @ no
  assistente de campanha; histórico com filtro por conta, ID e permalink.

Testes: conectores 39, banco 103, worker 60 (com `pg` e com `postgres.js`), domínio 58.

## 3. O que você precisa fazer no Meta for Developers

Baseado na documentação oficial consultada em 2026-11-20 (Graph API v27.0). Os nomes de menus
podem variar; onde a documentação não deixa claro, está marcado **(confirmar no painel)**.

1. **Conta do Instagram**: profissional (Empresa ou Criador de conteúdo). A página de criação do app
   indica que a conta adicionada deve ser **pública**.
2. **Criar o app**: <https://developers.facebook.com/apps> → *Criar app* → tipo **Business**
   (a doc: "Your app must be a business type app to be able to add the Instagram product").
3. **Adicionar o produto Instagram** → **API setup with Instagram login**.
4. **Adicionar a sua conta do Instagram** ao app nessa tela (passo *Generate access tokens* / *Add account*).
   Para contas que você possui ou gerencia e adicionou no painel basta **Standard Access**;
   contas de terceiros exigem **Advanced Access + App Review**. Se for pedido um convite/aceite
   no app do Instagram, aceite-o **(confirmar no painel)**.
5. **Set up Instagram business login → Business login settings**:
   - **OAuth redirect URIs**: `https://reelsflow-xi.vercel.app/api/oauth/instagram/callback`
     (exatamente assim, sem barra final).
   - **Deauthorize callback URL** e **Data deletion request URL**: ainda **não implementados** para o
     Instagram Login. Se o painel exigir, me avise antes de preencher qualquer valor.
6. **Copiar** o **Instagram App ID** e o **Instagram App Secret** dessa mesma tela
   (são diferentes do App ID do Facebook).
7. **Permissões**: `instagram_business_basic` e `instagram_business_content_publish` (nenhuma outra).
8. **Não** é preciso publicar o app (modo Live) nem App Review para publicar na **sua** conta
   adicionada no passo 4 **(confirmar no painel: a doc diz que App Review é necessário para "live data" de contas de terceiros)**.

## 4. Credenciais — onde inserir (nunca no chat, nunca no código)

| Variável | Onde | Valor |
|---|---|---|
| `INSTAGRAM_APP_ID` | Vercel → projeto `reelsflow` → Settings → Environment Variables → **Production** | Instagram App ID (passo 6) |
| `INSTAGRAM_APP_SECRET` | Vercel, **Production**, marcar **Sensitive** | Instagram App Secret (passo 6) |
| `TOKEN_ENCRYPTION_KEY` | Vercel, **Production**, **Sensitive** | 32 bytes em base64: `openssl rand -base64 32` |
| `TOKEN_ENCRYPTION_KEY` | Supabase → projeto `reelsflow-dev` → Edge Functions → **Secrets** | **o mesmo valor** da linha acima |

- O worker **não** precisa do App Secret (a renovação de token não usa o segredo).
- Perder ou trocar `TOKEN_ENCRYPTION_KEY` invalida os tokens guardados: as contas precisam ser reconectadas.
- Para a linha da Supabase posso abrir o formulário seguro do painel (o valor não passa por mim).

## 5. Homologação (depois da sua autorização de deploy)

1. Aplicar a migration `20261120000009_instagram_login.sql` no banco de produção.
2. Republicar a função `worker-tick` com o novo bundle (fixado no commit) e o app na Vercel.
3. Você conecta a conta em **Contas conectadas → Conectar conta do Instagram** (login no instagram.com).
4. Enviar um vídeo **seu**, MP4 vertical 9:16, 3 s a 15 min, H.264/AAC, ≤ 300 MB (o ReelsFlow
   limita a 50 MB no plano atual), e agendar uma campanha só para essa conta, ≥ 5 min à frente.
5. Evidência exigida para declarar funcional: status `published`; `external_id` (ID da mídia) e
   `permalink` gravados; o link abre o Reel na conta certa; tentativas registradas sem `media_publish` duplicado.

## 6. Limites e pendências conhecidas

- Plano `starter` = **1 conta do Instagram por workspace**. Para várias contas é preciso plano
  `pro` (5) / `agency` (50) — cobrança não existe; dá para liberar por workspace em `subscriptions.limits`.
- Limite da Meta: 100 publicações por API em 24 h por conta (a doc também cita 50 em outro trecho —
  conflito não resolvido; o ReelsFlow lê o valor real em `content_publishing_limit`) e 400 containers/24 h.
- O vídeo precisa estar acessível publicamente quando a Meta o baixa: usamos URL assinada de 2 h.
- Exclusão de dados/desautorização via callback do Instagram: não implementado (seção 3, passo 5).
- A foto de perfil vem do CDN da Meta e expira; é atualizada a cada renovação de token.
