# Suíte de homologação — navegação e autenticação

Testes que exigem login real, revogação de sessão ou medição de navegação — por isso rodam contra o
**Supabase local com dados sintéticos** (nunca contra produção). Complementam a suíte `e2e/`
(`pnpm test:e2e`), que roda sem backend.

| Script | O que verifica | Onde roda |
|---|---|---|
| `security.cjs` | sem login, cookie inválido, 4 papéis, outro workspace, sem vínculo, vínculo removido, papel rebaixado, JWT adulterado, sessão revogada (outro dispositivo, bloqueio, exclusão), revogado + sem vínculo, **nada sai antes do `getUser`** (Auth lento), expiração com e sem renovação | local |
| `ux.cjs` | destaque do menu, voltar/avançar, cliques rápidos, teclado, Ctrl+clique, celular, deslocamento de layout, erros de console | local |
| `nav-bench.cjs` | clique → resposta visual / URL / conteúdo utilizável, tarefas longas, CPU, renderizações, chamadas ao Supabase em fila | local |
| `remote-readonly.cjs` | rotas protegidas, tempos, região da função, desktop/celular, console — **só GET, sem login** | prévia ou produção |
| `seed.cjs` / `latency-proxy.cjs` | dados sintéticos / atraso servidor → Supabase | local |

Trava: `config.cjs` recusa rodar os scripts locais se site, Supabase ou Postgres não forem `127.0.0.1`/`localhost`.
Usuários criados pelo `security.cjs` são removidos no fim. Estado da execução (senha aleatória, seed,
resultados) fica em `test-homolog/.homolog/`, ignorado pelo git.

## Roteiro
```bash
# 1. Supabase local rodando (54321/54322) e apps/web/.env.local apontando para ele
SUPABASE_SERVICE_ROLE_KEY=<chave LOCAL> node test-homolog/seed.cjs

# 2. proxy que imita a distância até o banco (120 ≈ iad1, 5 ≈ gru1); AUTH_DELAY_MS para o teste do getUser
DELAY_MS=5 AUTH_DELAY_MS=2000 node test-homolog/latency-proxy.cjs &

# 3. build de produção apontando para o proxy
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54331 pnpm build
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54331 pnpm exec next start -p 3100 -H 127.0.0.1 &

# 4. testes
HOMOLOG_AUTH_DELAY_MS=2000 node test-homolog/security.cjs   # + HOMOLOG_SESSION_FIX=1 com o conjunto B
node test-homolog/ux.cjs
node test-homolog/nav-bench.cjs depois         # (reinicie o proxy sem AUTH_DELAY_MS para medir)

# 5. deploy remoto (somente leitura)
HOMOLOG_BYPASS=<token> node test-homolog/remote-readonly.cjs https://<deploy>.vercel.app previa
```
Expiração: rode o Auth local com `GOTRUE_JWT_EXP=30` e use `HOMOLOG_SHORT_JWT=1`.

Sem o conjunto B (correção de sessões revogadas), o ciclo `/login ↔ /w` com sessão revogada é registrado
como **CONHECIDO** (comportamento atual de produção); o teste falha se qualquer dado aparecer.
