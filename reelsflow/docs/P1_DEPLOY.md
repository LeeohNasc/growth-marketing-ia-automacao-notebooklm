# Deploy do P1 — Publicação rápida (25/11/2026)

## O que foi implantado
| Parte | Versão | Origem |
|---|---|---|
| App web (Vercel, gru1) | `dpl_4mNPp6iTHdztefTVQbBogRNad5kN`, promovido às 17:12:47 UTC | commit `cf8e950` (código do app = `9e38b85`) |
| Worker (Edge Function `worker-tick`) | versão 6 | pacote `worker.bundle.js` do commit `cf8e950` (sha256 `00f3323a…`) |

Única mudança no pacote do worker em relação à v5: `composeCaption` não repete no fim as hashtags que já
estão escritas no texto da legenda (`extraHashtags`). Sem repetição, o texto publicado é idêntico ao de antes.
Banco: nenhuma alteração (última migration continua `20261125023702`).

## Reversão
**App:** promover de volta o deploy anterior (P0):
```
POST https://api.vercel.com/v10/projects/prj_vsoymCPJZ0S7b5JDzRrZqFLd4Jur/promote/dpl_AGs32BPvT86fwQs6XyLKKjFj8RaN?teamId=team_6C2jF5mD40rPOnoxRTpOHMju
```
**Worker:** reimplantar `worker-tick` com o mesmo `index.ts`, trocando o commit fixado no import de
`cf8e9501cc3214d559c3258fb9e4ae5550f98683` para `0a9d4c263f8dff396bdf41e3b4d139116815c386` (v5, sha256 `7043ea31…`),
`verify_jwt: false`.

App e worker podem ser revertidos de forma independente: a mudança do worker é compatível com o app anterior
e o app novo funciona com o worker anterior (só a remoção de hashtags repetidas deixaria de valer).

## Backlog técnico (fora deste deploy, por decisão)
- Concorrência: duas abas enviando ao mesmo tempo podem criar duas campanhas (bloqueio completo exige regra no banco).
- Rascunho que sobra quando um rascunho interrompido é encontrado e a publicação já está agendada.
- Lista da Publicação rápida limitada a 1.000 vídeos prontos (com aviso).
