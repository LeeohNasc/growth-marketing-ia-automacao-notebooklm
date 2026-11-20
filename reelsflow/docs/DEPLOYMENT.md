# Deploy — ambiente atual

> Data: 2026-11-20. Ambiente de **demonstração** (planos gratuitos). Publicação real nas redes
> ainda **não** está habilitada: só o publicador simulado funciona de ponta a ponta.

## Onde está cada parte

| Parte | Onde | Identificador |
|---|---|---|
| App web (Next.js) | Vercel, projeto `reelsflow`, raiz `apps/web`, Node 22 | https://reelsflow-xi.vercel.app |
| Banco, Auth, Storage | Supabase `reelsflow-dev`, região sa-east-1 | ref `mxeazufhstmdvpvhfjhw` |
| Worker | Supabase Edge Function `worker-tick` (Deno), 1 tick/minuto via `pg_cron` + `pg_net` | `functions/v1/worker-tick` |
| Exclusão de conta | Edge Function `delete-account` (JWT obrigatório) | `functions/v1/delete-account` |

## Decisões e motivos

- **Worker sem servidor dedicado.** Os planos gratuitos não incluem um container contínuo. O
  worker roda como Edge Function, um ciclo (`tick`) por minuto; a fila (lease, retry,
  reconciliação) é a mesma do worker Node e está no Postgres, então nada se perde se uma
  invocação for interrompida — o lease expira e o job volta.
- **Sem ffmpeg na Edge Function.** A análise lê só o índice do MP4/MOV por requisições HTTP
  Range (`apps/worker/src/media/mp4.ts`, validado contra o ffprobe nos testes) e a miniatura é
  gerada no navegador durante o envio. Consequência: **WebM deixou de ser aceito** (Instagram e
  Facebook também não o aceitam). Se o navegador não decodificar o vídeo (ex.: HEVC no
  Chrome/Windows), o vídeo fica pronto **sem miniatura**.
- **Sem service role no app web.** A chave fica só no runtime das Edge Functions (injetada pela
  Supabase). O app web usa apenas a chave publicável + RLS.
- **Segredo do cron.** Gerado dentro do banco (`vault`, nome `worker_tick_secret`); nunca aparece
  em código, logs ou variáveis da Vercel. Chamadas sem ele recebem 403.
- **Bundle do worker.** `apps/worker/scripts/build-edge.mjs` gera
  `supabase/functions/worker-tick/worker.bundle.js`. A função publicada importa esse bundle do
  GitHub **fixado num commit** (imutável). Para atualizar: gerar o bundle, commitar, enviar e
  publicar a função com o novo SHA no `import`.

## Validado em produção (2026-11-20)

Com um usuário de teste temporário (`@example.com`, criado e excluído no mesmo dia):

1. login → onboarding → criação de workspace;
2. envio TUS de MP4 1080×1920 (4,9 MB) → miniatura do navegador → análise pelo worker
   (1080×1920, h264/aac, 30 fps, compatível com Instagram Reels) → `ready`;
3. conta simulada → campanha → ativação → publicação `published` no tick seguinte ao horário,
   1 tentativa, ID externo e link registrados;
4. as 12 telas do workspace responderam 200, sem erros no console;
5. exclusão de conta pela Edge Function → usuário, workspace, vídeo, jobs e arquivos removidos.

Suítes locais: RLS 96/96; worker 53/53 com `pg` **e** com `postgres.js` (driver da Edge Function).

## Pendente — exige ação no painel (não feito por mim)

1. **Supabase → Authentication → URL Configuration**: `Site URL` =
   `https://reelsflow-xi.vercel.app` e Redirect URL `https://reelsflow-xi.vercel.app/**`.
   Sem isso, links de confirmação e de redefinição de senha apontam para `localhost`.
2. **E-mail (SMTP)**: o SMTP padrão da Supabase só entrega para membros da organização e tem
   limite baixo. Para cadastro público, configurar SMTP próprio (ex.: Resend, SES) — serviço
   externo, possivelmente pago: decisão sua.
3. **Meta (Instagram/Facebook)**: app Meta, `META_APP_ID`/`META_APP_SECRET`/`TOKEN_ENCRYPTION_KEY`
   na Vercel e `TOKEN_ENCRYPTION_KEY` (mesma chave) nos segredos das Edge Functions; revisão do app
   pela Meta para publicar em contas de terceiros.
4. **Projeto "Peixe Casting CRM"** foi pausado para liberar a vaga do plano gratuito; reative no
   painel se precisar (o plano gratuito permite 2 projetos ativos).

## Limites conhecidos deste ambiente

- Planos gratuitos: Supabase pausa projetos inativos por 7 dias; Storage 1 GB; Edge Functions
  com limite de tempo por invocação (o worker processa até 3 jobs por tick).
- Latência de publicação: até ~1 minuto após o horário (granularidade do cron).
- Horário mínimo para agendar: 5 minutos à frente (regra do planejador).
