#!/usr/bin/env node
/**
 * Gera os assets oficiais da marca ReelsFlow a partir de lib/brand/marks.json (fonte única da geometria).
 *   node scripts/brand/build-brand.mjs
 * Saídas:
 *   public/brand/*.svg            logos horizontais (fundo escuro/claro), monograma, monograma pequeno, ícones do app
 *   public/brand/*.png            ícones do app 192/512 (escuro e claro) e maskable 512
 *   app/icon.svg, app/favicon.ico, app/apple-icon.png   (convenções de metadados do Next.js)
 * PNG/ICO são renderizados no Chromium do Playwright a partir dos SVGs (nada é recortado de imagem).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const M = JSON.parse(readFileSync(path.join(root, "lib/brand/marks.json"), "utf8"));
const C = M.colors;
const out = (p) => path.join(root, p);
mkdirSync(out("public/brand"), { recursive: true });

const svg = (viewBox, body, extra = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${extra}>${body}</svg>\n`;
const mono = (back = M.monogram.back) =>
  `<path fill="${C.symbol}" d="${back}"/><path fill="${C.symbol}" fill-rule="evenodd" d="${M.monogram.front}"/>`;

// --- logos e monogramas (fundo transparente) ---
const files = {
  "public/brand/reelsflow-logo-horizontal-on-dark.svg": svg(M.lockup.viewBox, `<title>ReelsFlow</title>${mono()}<path fill="${C.textOnDark}" d="${M.lockup.wordmark}"/>`),
  "public/brand/reelsflow-logo-horizontal-on-light.svg": svg(M.lockup.viewBox, `<title>ReelsFlow</title>${mono()}<path fill="${C.textOnLight}" d="${M.lockup.wordmark}"/>`),
  "public/brand/reelsflow-monogram.svg": svg(M.monogram.viewBox, `<title>ReelsFlow</title>${mono()}`),
  "public/brand/reelsflow-monogram-small.svg": svg(M.monogramSmall.viewBox, `<title>ReelsFlow</title>${mono(M.monogramSmall.back)}`),
};

// --- ícones do app: quadrado cheio (o sistema aplica a máscara), monograma centralizado ---
// O monograma ocupa `scale` da largura do ícone (maskable: zona segura de 80% → 52%).
function appIcon(bg, scale) {
  const S = 1024, w = S * scale, h = (w * 312) / 334;
  const x = (S - w) / 2, y = (S - h) / 2, k = w / 334;
  return svg(`0 0 ${S} ${S}`, `<rect width="${S}" height="${S}" fill="${bg}"/><g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${k.toFixed(5)})">${mono()}</g>`);
}
files["public/brand/reelsflow-app-icon-dark.svg"] = appIcon(C.iconDark, 0.62);
files["public/brand/reelsflow-app-icon-light.svg"] = appIcon(C.iconLight, 0.62);
files["app/icon.svg"] = files["public/brand/reelsflow-monogram-small.svg"];

for (const [p, content] of Object.entries(files)) writeFileSync(out(p), content);

// --- PNGs e ICO ---
const browser = await chromium.launch();
const page = await browser.newPage();
async function png(svgText, size, transparent) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;display:grid;place-items:center">${svgText.replace("<svg ", `<svg width="${size}" height="${size}" `)}</div></body></html>`,
  );
  return page.screenshot({ omitBackground: transparent, clip: { x: 0, y: 0, width: size, height: size } });
}
const pngs = {
  "public/brand/reelsflow-icon-192-dark.png": [appIcon(C.iconDark, 0.62), 192],
  "public/brand/reelsflow-icon-512-dark.png": [appIcon(C.iconDark, 0.62), 512],
  "public/brand/reelsflow-icon-192-light.png": [appIcon(C.iconLight, 0.62), 192],
  "public/brand/reelsflow-icon-512-light.png": [appIcon(C.iconLight, 0.62), 512],
  "public/brand/reelsflow-icon-maskable-512.png": [appIcon(C.iconDark, 0.52), 512],
  "app/apple-icon.png": [appIcon(C.iconDark, 0.62), 180],
};
for (const [p, [s, size]] of Object.entries(pngs)) writeFileSync(out(p), await png(s, size, false));

// favicon.ico: PNGs 16/32/48 do monograma pequeno, fundo transparente
const small = files["public/brand/reelsflow-monogram-small.svg"];
const icoImgs = [];
for (const size of [16, 32, 48]) icoImgs.push({ size, data: await png(small, size, true) });
const header = Buffer.alloc(6 + 16 * icoImgs.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(icoImgs.length, 4);
let offset = header.length;
icoImgs.forEach((img, i) => {
  const e = 6 + i * 16;
  header.writeUInt8(img.size, e); header.writeUInt8(img.size, e + 1); header.writeUInt8(0, e + 2); header.writeUInt8(0, e + 3);
  header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(img.data.length, e + 8); header.writeUInt32LE(offset, e + 12);
  offset += img.data.length;
});
writeFileSync(out("app/favicon.ico"), Buffer.concat([header, ...icoImgs.map((i) => i.data)]));
await browser.close();
console.log("Assets gerados:", [...Object.keys(files), ...Object.keys(pngs), "app/favicon.ico"].join("\n  "));
