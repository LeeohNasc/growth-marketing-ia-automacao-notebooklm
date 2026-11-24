# Homologação do conjunto A (navegação) — 24/11/2026

Branch `claude/reelsflow-nav-homolog` = linha de produção (`1e9cb05`) + conjunto A (`796291f`, código idêntico a
`2b60181`) + suíte de testes (`4baff13`). Conjunto B **ausente**. Prévia protegida em gru1:
`dpl_3Gt1Fn4Qdtj52C42yQGcQCqUENtT` (`reelsflow-npowcekzu-leeohnasc.vercel.app`), sem domínio de produção.

## Testes
| Suíte | Resultado |
|---|---|
| lint, typecheck (5 pacotes), build | ok |
| testes unitários (domain 80, connectors 67) | 147/147 |
| e2e do projeto (desktop + celular) | 64/64 |
| `test-homolog/security.cjs` (JWT 1 h e 30 s; getUser +2 s) | 0 falhas; 3 comportamentos conhecidos (ciclo de sessão revogada, igual à produção, sem dados) |
| `test-homolog/ux.cjs` | 10/10 |
| `test-homolog/remote-readonly.cjs` (prévia e produção) | sem falhas |

"Nada sai antes do getUser": com o getUser atrasado 2 s, sessão revogada → 1ª resposta é redirecionamento após
2.038 ms, sem dados; sessão válida → dados da Biblioteca só aparecem após 2.220 ms.

## Medições locais (proxy 18 ms/consulta = mediana real em gru1; mesmos dados sintéticos; mediana de 3 rodadas)
Clique → conteúdo utilizável (ms). Resposta visual ao clique: produção 104–209 → conjunto A 1–3.
| Página | Produção | Conjunto A | A sem os 5 esqueletos (experimento) |
|---|---|---|---|
| Biblioteca | 217 | 142 | 157 |
| Calendário | 219 | **318** | 136 |
| Campanhas | 118 | 72 | 81 |
| Fila | 159 | **317** | 121 |
| Configurações | 156 | 91 | 101 |
| Criar publicação | 104 | 58 | 66 |
| Visão Geral | 166 | **317** | 136 |
Rede lenta: mesmo padrão (Calendário 242 → 318 → 210; Fila 189 → 316 → 194; Visão Geral 188 → 316 → 184).
Causa das regressões: o React segura a revelação do conteúdo por ~300 ms depois de mostrar um estado de
carregamento; em gru1 essas páginas ficaram rápidas o bastante para o esqueleto atrasar o conteúdo.

## Ajuste: conjunto A sem os 5 esqueletos — commit `12d1009`
Removidos os 5 `loading.tsx` e o componente `page-skeleton` (sem uso). Demais otimizações preservadas; conjunto B
ausente. Prévia protegida em gru1: `dpl_FJonTcvBEpRhbeubZzcVWDQH1NpK` (`reelsflow-9cw7yulix-leeohnasc.vercel.app`).

Testes: lint, typecheck (5 pacotes), build ok · unitários 147/147 · e2e 64/64 · `security.cjs` 0 falhas
(getUser +2 s: revogada → redirecionamento após 2.044 ms sem dados; válida → dados após 2.258 ms) ·
`ux.cjs` 10/10 · `remote-readonly.cjs` prévia e produção sem falhas, 0 erros de console (desktop/celular).

Chave de serviço: lida só em `lib/supabase/admin.ts` (`server-only`; regra de lint proíbe outros usos); na Vercel
só no alvo *preview*, tipo sensível. Build com valor-sentinela: 0 de 49 arquivos do cliente contêm a chave
(controle: chave publicável encontrada). O projeto Supabase a que pertence não pode ser confirmado sem ler o valor.

Medição local (18 ms/consulta, mesmos dados, mesma máquina), clique → conteúdo utilizável (ms):
| Página | Produção | Ajustado | | Rede lenta: Produção | Ajustado |
|---|---|---|---|---|---|
| Biblioteca | 279 | 195 | | 282 | 248 |
| Calendário | 267 | 161 | | 287 | 210 |
| Campanhas | 135 | 90 | | 171 | 179 |
| Fila | 185 | 142 | | 201 | 203 |
| Configurações | 202 | 112 | | 204 | 187 |
| Criar publicação | 123 | 74 | | 172 | 172 |
| Visão Geral | 213 | 154 | | 203 | 191 |
Resposta visual ao clique: produção 123–253 → ajustado 2–4 ms.
