# Marca ReelsFlow

Identidade oficial: monograma **R** formado por dois quadros verticais sobrepostos (os vídeos na fila) e
perna diagonal (o avanço no fluxo de publicação), com o nome **ReelsFlow** (R e F maiúsculos).

| Cor | Uso |
|---|---|
| `#FF1734` | símbolo |
| `#F7F7F8` | texto sobre fundo escuro |
| `#0B0B0C` | texto sobre fundo claro |
| `#1C1C1F` / `#FFFFFF` | fundo dos ícones do app (escuro / claro) |

## Fonte única

`apps/web/lib/brand/marks.json` guarda a geometria (paths vetoriais). Dela saem o componente React
(`components/logo.tsx`: `Logo`, `BrandLockup`, `BrandMark`) e os arquivos (`node scripts/brand/build-brand.mjs`):

| Arquivo | Uso |
|---|---|
| `public/brand/reelsflow-logo-horizontal-on-dark.svg` | assinatura, fundo transparente, para fundos escuros |
| `public/brand/reelsflow-logo-horizontal-on-light.svg` | assinatura, fundo transparente, para fundos claros |
| `public/brand/reelsflow-monogram.svg` | monograma isolado |
| `public/brand/reelsflow-monogram-small.svg` | monograma para 16–32 px (espaço interno 32 em vez de 20) |
| `public/brand/reelsflow-app-icon-{dark,light}.svg` + `reelsflow-icon-{192,512}-{dark,light}.png`, `reelsflow-icon-maskable-512.png` | ícones do app |
| `app/icon.svg`, `app/favicon.ico` (16/32/48), `app/apple-icon.png` (180) | favicon e metadados (convenção do Next.js) |

O lettering é **Poppins Bold** (SIL OFL) convertida em contornos (tracking −0,057 em), ajustada à
proporção da referência; os SVGs não dependem de fonte instalada.

## Regras de uso

- Assinatura horizontal quando há espaço para o nome; monograma em espaços compactos ou ao lado de um
  "ReelsFlow" já escrito. Nunca esticar, recortar ou repetir o nome ao lado da assinatura.
- O SVG da marca é decorativo (`aria-hidden`); o nome acessível fica no link ("ReelsFlow…").
- O ícone de play continua só em controles que reproduzem vídeo; ícones das redes sociais não mudam.
