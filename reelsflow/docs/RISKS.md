# Riscos e decisões pendentes — ReelsFlow

Escala: Impacto (A/M/B) × Probabilidade (A/M/B).

## 1. Riscos

| # | Risco | Tipo | I | P | Mitigação |
|---|---|---|---|---|---|
| R1 | App Review da Meta atrasado ou negado — sem ele não há publicação para clientes | Externo / negócio | A | M | Iniciar verificação do negócio cedo; preparar screencast e páginas legais na Fase 4; produto útil em modo dev só para contas com papel no app |
| R2 | TikTok e YouTube só publicam como privado até auditoria — promessa "4 redes" não se cumpre no lançamento | Externo / reputacional | A | A | Comunicar como "Instagram e Facebook no lançamento"; conectores desabilitados com explicação |
| R3 | Publicação duplicada após timeout (APIs sem idempotência) | Técnico | A | M | Estado `uncertain` + reconciliação antes de retry; checkpoints persistidos antes de cada efeito externo |
| R4 | Rajada de publicações após indisponibilidade do worker | Operacional / reputacional | M | M | Política `max_lateness` → `needs_review`; espaçamento mínimo por conta |
| R5 | Plataformas reduzem alcance de conteúdo repostado/idêntico em várias redes (ex.: marcas d'água de outra plataforma) | Reputacional | M | M (hipótese, não medida) | Avisar o usuário; recomendar arquivo original sem marca d'água; não é algo que o sistema resolva |
| R6 | Custo de egress/armazenamento cresce com vídeos grandes | Financeiro | M | M | Medir em `usage_records`; limites por plano; alternativa R2 registrada |
| R7 | Limite de tamanho de arquivo do Supabase Free inviabiliza testes reais | Técnico / financeiro | M | A | Testes com arquivos pequenos no Free; Pro antes de beta |
| R8 | Escopo amplo demais para o MVP (13 telas, 4 redes, automações, IA, planos) | Execução | A | A | Fases com critério de saída; analytics/IA/cobrança fora do MVP; regras de automação fixas |
| R9 | Mudanças de API/versão (Graph API versiona e descontinua) | Técnico | M | A | Versão fixada por conector; tabela de especificações versionada; testes de contrato |
| R10 | Vazamento de tokens | Segurança | A | B | Ver SECURITY.md |
| R11 | Responsabilidade por conteúdo publicado por clientes | Jurídico | M | M | Termos de uso; logs de quem agendou; validação jurídica |
| R12 | Vercel Hobby usado comercialmente viola termos | Jurídico / financeiro | B | M | Pro antes de cobrar clientes |
| R13 | Repositório atual não é dedicado ao produto | Organização | B | A | Mover para repositório próprio antes da Fase 1 |

## 2. Premissas frágeis do prompt mestre

1. **"Publicar centenas de vídeos automaticamente"** — tecnicamente possível no motor; na prática limitado por cotas por conta (ex.: Instagram ~50/24 h — suficiente para uso normal) e, principalmente, por autorizações (R1, R2).
2. **"Exatamente uma publicação"** — não é garantível onde a plataforma não oferece idempotência; o compromisso realista é "no máximo uma tentativa ativa + reconciliação".
3. **"Vercel + Supabase gratuitos"** — não é suposto no prompt, mas é comum assumir; para operar com clientes o custo mínimo estimado é ~US$ 50–60/mês.
4. **"Mesmo vídeo em todas as redes sem intervenção"** — o TikTok exige escolhas do criador por publicação na UI; pode não ser compatível com automação total mesmo após auditoria (a confirmar).

## 3. Decisões que dependem de você

| # | Decisão | Minha recomendação |
|---|---|---|
| D1 | Repositório dedicado ou manter em `reelsflow/` aqui? | Dedicado (`reelsflow`), antes da Fase 1 |
| D2 | Storage: Supabase Storage ou Cloudflare R2? | Supabase Storage no MVP (menos peças, RLS nativa); reavaliar com dados de egress |
| D3 | Hospedagem do worker | Decidir na Fase 3; desenvolvimento local até lá |
| D4 | Criar projeto Supabase de desenvolvimento (Free) agora? | Sim, na Fase 1, com sua autorização |
| D5 | Você já tem conta Meta Business verificada / app de desenvolvedor? | Se não, iniciar já — caminho crítico |
| D6 | Instagram via Instagram Login ou Facebook Login? | Suportar Facebook Login primeiro (cobre IG + Páginas num único OAuth); Instagram Login depois |
