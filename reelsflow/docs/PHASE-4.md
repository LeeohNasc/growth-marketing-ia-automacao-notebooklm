# Relatório — Fase 4 (Integração Meta: Instagram e Facebook)

Data: 2026-11-19

## Situação — leia primeiro
| Item | Estado |
|---|---|
| Código de OAuth, contas, conectores Instagram/Facebook, criptografia de tokens, exclusão de dados | **Implementado** |
| Testes contra respostas simuladas montadas a partir da documentação oficial (v27.0) | **Aprovados** |
| Qualquer chamada real à Meta | **Não feita** — não há app Meta, credenciais nem Supabase real |
| Publicação real em conta própria (modo desenvolvimento) | **Bloqueada** (precisa de app Meta + domínio HTTPS + Supabase + worker hospedado) |
| Publicação para clientes | **Bloqueada** por App Review (acesso avançado) e verificação do negócio |

**A integração NÃO deve ser considerada funcional** até o roteiro de validação abaixo ser executado com contas reais.

Avancei a seu pedido, apesar da recomendação contrária (pré-requisitos ausentes). Decisão assumida: D6 = Facebook Login (um único OAuth cobre Páginas e Instagram profissional vinculado).

## Implementado
**Pesquisa** — leitura da documentação oficial (content publishing, ig-container, media_publish, content_publishing_limit, Reels Publishing API, manual OAuth flow, long-lived tokens, data deletion callback, rate limiting). Fatos e contradições registrados em API_INTEGRATIONS.md. Regras de compatibilidade do Instagram/Facebook passaram de “preliminares” para **confirmadas** (violações agora bloqueiam).

**`packages/connectors/server`**
- `TokenCipher`: AES-256-GCM, rotação por versão, contexto por conta.
- `GraphClient`: versão fixa (v27.0, configurável), timeout, token no cabeçalho, erros estruturados; classificação: limites (4/17/32/613/80001/80002, com tempo de espera do cabeçalho BUC), autorização (190/102/10/2xx), transitórios (1/2/is_transient/5xx), permanentes (resto).
- OAuth: URL do diálogo, code → token curto → longa duração, descoberta de Páginas + Instagram vinculado, permissões concedidas/faltantes por conta, tarefa CREATE_CONTENT.
- `InstagramConnector`: cota → container REELS → espera FINISHED → checkpoint → media_publish → permalink; retomada sem recriar container; ERROR = rejeição; falha incerta no publish → reconciliação pelo `status_code` (PUBLISHED).
- `FacebookConnector`: start → upload por `file_url` → checkpoint → finish PUBLISHED → acompanha status; reconciliação por `fields=status`.
- `parseSignedRequest`: verificação HMAC-SHA256 do callback de exclusão.

**Banco (`20261119000004_meta_integration.sql`)** — tokens cifrados, capacidades por conta, `oauth_states` (uso único), pedidos de exclusão; RPCs begin/check/complete/get/finalize OAuth, desconectar, exclusão (só service role) e status público por código.

**Worker** — decifra o token só na hora de publicar; URL assinada de 2 h para a Meta baixar o vídeo; chave ausente = espera (não desconecta a conta); conectores Meta registrados.

**Web** — botão “Conectar Instagram ou Facebook”, retorno do OAuth, tela de seleção de contas (com motivo quando não pode publicar), permissões por conta, reconectar/desconectar, callback de exclusão de dados (`/api/meta/data-deletion`), status (`/data-deletion/<código>`), **rascunhos** de Política de Privacidade e Termos (com aviso de revisão jurídica), links no cadastro e na página inicial.

## Testes executados
| Suíte | Resultado |
|---|---|
| Typecheck (5 pacotes), lint | sem erros |
| Domínio | 58/58 |
| Conectores (inclui 22 Meta: OAuth, cifra, signed_request, erros, Instagram, Facebook) | 27/27 |
| Banco/RLS (inclui 6 Meta) | 86/86 |
| Worker (inclui 4 Instagram ponta a ponta com Graph simulada) | 43/43 |
| Build | OK |
| E2E desktop + mobile | 60/60 |

Destaques: token decifrado nunca aparece em registros do banco; timeout no `media_publish` vira incerto e é reconciliado **sem segundo `media_publish`**; token revogado (190) marca a conta e segura as publicações; nenhum usuário (nem owner) lê tokens ou estados OAuth.

**Defeito encontrado na revisão e corrigido:** o callback trocava o `code` com a Meta antes de validar o `state`. Agora valida primeiro.

## Limitação dos testes
As respostas simuladas foram escritas por mim a partir da documentação. Se a API real diferir da documentação (que tem inconsistências conhecidas: limite 50 vs 100, `complete` vs `completed`, token de Página vs de usuário para Instagram), os testes não detectam. Só o teste real valida.

## Roteiro de validação real (quando houver pré-requisitos)
1. Você: conta de desenvolvedor Meta, app do tipo Business, produto Facebook Login, redirect URI `https://<domínio>/api/oauth/meta/callback`, URL de exclusão de dados `https://<domínio>/api/meta/data-deletion`, URLs de privacidade e termos (revisados).
2. Eu: Supabase real (migrations 1–4), deploy de preview autorizado, worker hospedado autorizado, `TOKEN_ENCRYPTION_KEY` igual nos dois.
3. Com uma Página e um Instagram profissional **seus** (papel no app, modo desenvolvimento): conectar → agendar 1 Reel de 10–30 s 1080×1920 para cada → conferir publicação, permalink, status e histórico → simular revogação no Facebook → conferir “requer reconexão” → solicitar exclusão de dados.
4. Gravar screencast para o App Review; pedir acesso avançado às 5 permissões; verificação do negócio.

## Pendências
- Tudo do roteiro acima; Supabase real (bloqueador desde a Fase 1).
- Preparo antecipado do container do Instagram (hoje o processamento começa no horário e pode atrasar a publicação alguns minutos).
- Aviso de expiração de token: tokens de Página não têm expiração fixa segundo a doc; não implementado aviso proativo.
- Upload resumável direto (sem URL pública) para quando a URL assinada não for aceita pela Meta.
- Revisão jurídica dos textos legais; dados do controlador/DPO.

## Riscos
- **Doc da Meta inconsistente** em pontos que afetam o comportamento (ver acima).
- A Meta pode recusar a URL assinada do Supabase (doc: URLs que exigem autenticação não são suportadas; a nossa é pública por token na query — a confirmar).
- App Review pode exigir ajustes de fluxo/telas; prazo fora do nosso controle.

## Próxima fase
Não recomendo a Fase 5 (TikTok/YouTube/IA/planos). O valor do produto depende de validar Instagram/Facebook de verdade; TikTok e YouTube também ficam bloqueados por auditorias externas.
