# Navegação do dashboard — diagnóstico e correção da "pausa" ao trocar de página

Branch: `claude/reelsflow-nav-perf` (a partir de `claude/reelsflow-stability`). **Não integrada, não publicada.**

## Como foi medido
- Build de produção local (`next build` + `next start`), navegador Chromium real, cliques no menu lateral.
- Supabase local com dados sintéticos (workspace de 500 vídeos e ~10 mil publicações); nenhum dado de cliente.
- Um proxy local adiciona atraso a cada chamada **do servidor** ao Supabase, imitando a distância:
  120 ms ≈ Vercel `iad1` → banco em São Paulo (produção hoje); 5 ms ≈ `gru1` (mesma região do banco).
- Rede lenta: latência de 150 ms e 1,6 Mbps no navegador.
- Por página: mediana de 3 rodadas. Medido dentro da página: clique → 1ª mudança na tela, clique → troca de
  URL, clique → título real da página na tela (utilizável); tarefas longas (> 50 ms), CPU, renderizações
  (commits) do React, se o menu foi remontado; chamadas ao Supabase e quantas acontecem **em fila**.
- Scripts (fora do repositório): `nav.cjs` (medição), `sec.cjs` (segurança), `ux.cjs` (experiência),
  `latency-proxy.cjs`.

## Causas encontradas
1. **Nada na tela muda até a página nova estar pronta.** Nenhuma rota autenticada tinha estado de carregamento,
   e o destaque do menu só seguia a URL. Medido: 1ª mudança visual = 520 a 1.700 ms após o clique, praticamente
   igual ao tempo total. É a "pausa/travamento" percebida.
2. **3 idas ao Supabase em fila antes de qualquer dado, em toda página**: validar usuário (`getUser`) →
   workspace pela URL → vínculo do usuário. ≈ 3 × a distância até o banco (≈ 380 ms com `iad1`).
3. **Etapas extras em fila** em páginas específicas: Biblioteca (coleções → vídeos), Configurações
   (membros → perfis → convites/uso), Calendário (publicações → publicações de novo → vídeos → assinatura).
4. **Banco** (não é frontend; fora deste escopo): a consulta de `publication_jobs` leva 490–1.400 ms com
   10 mil publicações por causa do RLS avaliado por linha — tratado pela migration 16 (branch
   `claude/reelsflow-rls-perf`, não aplicada). É o que ainda pesa na Visão Geral, Calendário e Fila.

Descartado com medição (não alterado): tarefas longas = 0 em todas as navegações; CPU 30–145 ms; 4–5
renderizações por troca; o menu e o layout **não** eram remontados; o prefetch do Next (≈ 150 pedidos) não
consulta o banco. Por isso **não** foram aplicados `React.memo`/`useMemo`, virtualização ou divisão de código.

## O que mudou
| Arquivo | Mudança |
|---|---|
| `apps/web/components/app-nav.tsx` | o item clicado fica destacado na hora e mostra um indicador enquanto carrega (`useLinkStatus`); o destaque provisório é descartado quando a URL muda ou a navegação termina/cancela; Ctrl/⌘+clique não mexe no destaque |
| `apps/web/components/page-skeleton.tsx` (novo) | esqueleto da área principal: título fixo da seção + blocos neutros, **sem nenhum dado** |
| `app/w/[workspace]/{overview,calendar,queue,history,analytics}/loading.tsx` (novos) | esqueleto só nas páginas cujo tempo cresce com o volume de dados |
| `apps/web/lib/session.ts` | `requireWorkspace`: `getUser` em paralelo com 1 consulta (workspace + vínculo do próprio usuário); o id usado na consulta vem do JWT com assinatura conferida localmente (ES256) e precisa ser igual ao usuário validado por `getUser` |
| `app/w/[workspace]/library/page.tsx` | coleções e vídeos em paralelo quando não há filtro de coleção (com filtro, comportamento antigo) |
| `app/w/[workspace]/settings/page.tsx` | convites e uso em paralelo com a lista de membros |
| `apps/web/lib/jobs.ts`, `calendar/page.tsx` | `listJobs` devolve também horário local e caminho da miniatura (colunas já consultadas); o Calendário deixa de fazer 2 consultas em fila |

**Por que o esqueleto não está em todas as páginas**: depois de mostrar um estado de carregamento, o React
segura a revelação do conteúdo por ~300 ms. Medido com o servidor perto do banco: com esqueleto em tudo,
Configurações iria de 84 → 325 ms e Criar publicação de 54 → 320 ms. Nas páginas leves o retorno imediato
é o destaque + indicador no menu.

## Antes × depois (mediana, ms)
"Resposta" = clique → 1ª mudança na tela. "Utilizável" = clique → conteúdo real da página.

**Produção hoje (servidor longe do banco, 120 ms por chamada)**
| Página | Resposta antes | Resposta depois | Utilizável antes | Utilizável depois |
|---|---|---|---|---|
| Biblioteca | 846 | 3 | 866 | 476 |
| Calendário | 1.224 | 2 | 1.269 | 1.010 |
| Campanhas | 569 | 2 | 569 | 328 |
| Fila | 1.100 | 2 | 1.118 | 841 |
| Configurações | 769 | 2 | 788 | 405 |
| Criar publicação | 521 | 2 | 521 | 269 |
| Visão Geral | 1.600 | 2 | 1.600 | 1.305 |

**Rede lenta (mesmo servidor)**: resposta 517–1.671 → 2–4 ms; utilizável: Biblioteca 876 → 508,
Campanhas 585 → 314, Configurações 793 → 410, Criar 517 → 275, Fila 1.152 → 873, Visão Geral 1.671 → 1.287;
Calendário 1.900 → 2.045 (faixas 1.798–2.162 × 1.829–2.071: sem diferença real — dominado pelo download).

**Servidor perto do banco (cenário `gru1`, 5 ms)**: resposta 54–1.120 → 2–3 ms; utilizável: Criar 54 → 36,
Configurações 84 → 61, Campanhas 105 → 95, Biblioteca 151 → 136, Fila 568 → 535, Visão Geral 1.120 → 1.122,
Calendário 580 → 668 (faixas 573–723 × 562–684: ruído).

**Outros**: chamadas ao Supabase em fila por página 4–6 → 2–4; total de chamadas do servidor no roteiro
313 → 289; navegação rápida (6 cliques) 1.942 → 1.334 ms; tarefas longas 0 → 0; CPU por troca 42–145 →
36–138 ms; renderizações 4–5 → 4–7; deslocamento de layout 0,000; erros de console 0 → 0.

## Testes de regressão
- Segurança (Supabase local, mesmo teste nas duas versões): sem login → `/login`; não-membro → HTTP 404 sem
  dados; viewer sem ações de admin e 404 no outro workspace; troca de workspace sem estado misturando os dois
  (7 estados intermediários verificados); Biblioteca do workspace novo com os dados certos. **9/10 nas duas
  versões.**
- Experiência: destaque imediato e único; voltar/avançar; 4 cliques rápidos; teclado; Ctrl+clique; menu do
  celular; deslocamento de layout. **10/10 na branch**; a produção atual falha o destaque imediato.
- Suíte e2e do projeto (`pnpm test:e2e`, desktop + celular): **64/64**. `tsc` e `eslint` sem erros.

## Riscos e limitações
- Medido em ambiente local com atraso simulado, não na Vercel; os números absolutos de produção vão
  diferir. A causa (espera sem retorno visual + chamadas em fila) e o ganho relativo são estruturais.
- O que resta de lentidão na Visão Geral/Calendário/Fila é do banco (RLS) com 10 mil publicações; hoje a
  produção tem 1 publicação, então lá essas páginas tendem a ser mais rápidas que aqui.
- `requireWorkspace` usa o JWT para montar a consulta; a validação completa (`getUser`, inclusive sessão
  revogada) continua obrigatória e roda em paralelo. Se um dia o projeto voltar a chaves simétricas (HS256),
  `getClaims` passa a ir à rede e o ganho cai para 1 chamada a menos (continua correto).
- Achado **pré-existente**, igual nas duas versões, não corrigido aqui: com a sessão revogada em outro
  dispositivo (JWT ainda dentro da validade), o middleware considera o usuário logado e a página o manda ao
  login → ele fica em `/w` sem dados. Nenhum dado é exibido; vale corrigir à parte (mexe no middleware).
- Miniaturas: as URLs assinadas mudam a cada visita, então o navegador baixa as mesmas imagens de novo
  (não afeta o tempo até a página ficar utilizável; não alterado).
- `listJobs` agora envia ao navegador, na Fila/Histórico, também o caminho (não assinado) da miniatura e o
  horário local — dados do próprio workspace, sem valor de acesso.

## Rollback
Nada está em produção. Para desfazer na branch: `git revert <commit>`. Depois de integrado/publicado:
promover o deploy anterior na Vercel (instantâneo) ou reverter o commit e publicar. Não há migration nem
mudança no worker, na Zernio ou no RLS.
