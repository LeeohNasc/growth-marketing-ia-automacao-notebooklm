/**
 * Card Editorial — motor de layout PURO (sem DOM).
 *
 * O mesmo layout alimenta a pré-visualização e o arquivo final: a interface e o exportador chamam
 * `computeCardLayout` com o mesmo medidor de texto (canvas) e desenham com a mesma função.
 * Todas as medidas são definidas para largura 1080 e escaladas por `u = largura / 1080`.
 *
 *  ┌──────────────────────────────────────┐
 *  │ (avatar) Nome da Página  @usuario    │
 *  │          Manchete com quebra natural │
 *  ├──────────────────────────────────────┤
 *  │          FOTO / VÍDEO / 2 FOTOS      │
 *  ├──────────────────────────────────────┤
 *  │          respiro                     │
 *  └──────────────────────────────────────┘
 */

export const EDITORIAL_TEMPLATE_TYPE = "editorial_card" as const;
/** Mudanças que alteram o desenho incrementam a versão (rascunhos antigos continuam renderizando igual). */
export const EDITORIAL_TEMPLATE_VERSION = 2;

/**
 * Área segura dos Reels na versão 2 (canvas 1080×1920, medidas na largura 1080). Referências INICIAIS de
 * projeto, não medidas oficiais: o Instagram amplia o 9:16 para preencher telas mais altas (corta ~96 px de
 * cada lateral num iPhone), sobrepõe abas no topo, a coluna de botões à direita e perfil/legenda/barra na base.
 * `rightRail`: distância mínima da borda direita para o que fica na metade inferior (coluna de botões).
 * `bottom`: nenhum TEXTO/IDENTIDADE abaixo de 1920 − 400; o vídeo pode (e vai) até a base.
 */
export const REELS_SAFE_AREA = { side: 120, top: 285, bottom: 400, rightRail: 220 } as const;
/** No V2 vertical o vídeo ocupa até a base e não há marca-d'água inferior (o @ fica no cabeçalho). */
export const usesReelsLayout = (c: Pick<CardContent, "format" | "templateVersion">) => c.format === "vertical" && (c.templateVersion ?? 1) >= 2;

export const CARD_FORMATS = {
  feed: { width: 1080, height: 1350, label: "Feed 4:5 (1080×1350)" },
  square: { width: 1080, height: 1080, label: "Quadrado 1:1 (1080×1080)" },
  vertical: { width: 1080, height: 1920, label: "Vertical 9:16 (1080×1920)" },
} as const;
export type CardFormat = keyof typeof CARD_FORMATS;
export const CARD_FORMAT_KEYS = Object.keys(CARD_FORMATS) as CardFormat[];

export type CardMediaKind = "image" | "image_pair" | "video";
export type CardFit = "cover" | "contain";
export type FocalPoint = { x: number; y: number };

export const HEADLINE_MAX_CHARS = 280;
export const PAGE_NAME_MAX_CHARS = 60;
export const USERNAME_MAX_CHARS = 30;

export type CardStyle = {
  preset: "classic";
  /** Respiro branco abaixo da mídia, em px na largura 1080 (0–240). */
  bottomPadding: number;
  /** Fonte da manchete: 1 = padrão; o usuário pode reduzir explicitamente até 0.7. */
  headlineScale: number;
  watermark: { kind: "none" | "username" | "logo"; position: "bottom-right" | "bottom-left"; opacity: number };
  /** Guias de área segura na PRÉVIA (nunca no arquivo final). */
  showSafeArea?: boolean;
  /** Selo de identidade visual ao lado do nome (próprio do ReelsFlow; NÃO imita o selo oficial de verificação). */
  badge?: { enabled: boolean };
};

export const DEFAULT_CARD_STYLE: CardStyle = {
  preset: "classic",
  bottomPadding: 64,
  headlineScale: 1,
  watermark: { kind: "none", position: "bottom-right", opacity: 0.7 },
};

/** Paleta do preset Clássico (branco/preto/cinza). */
export const CLASSIC_COLORS = {
  background: "#ffffff",
  name: "#0f1419",
  username: "#536471",
  headline: "#0f1419",
  divider: "#ffffff",
  placeholder: "#eff3f4",
  safeArea: "rgba(255, 0, 80, 0.35)",
} as const;

export type CardContent = {
  format: CardFormat;
  pageName: string;
  username: string;
  headline: string;
  mediaKind: CardMediaKind;
  fit: CardFit;
  /** Versão do desenho gravada no card (ausente = 1). A 2 muda só o formato vertical (área segura dos Reels). */
  templateVersion?: number;
};

/** Medidor de texto injetado (no navegador: CanvasRenderingContext2D.measureText). */
export type TextMeasurer = (text: string, font: string) => number;

export type Rect = { x: number; y: number; w: number; h: number };
export type TextRun = { text: string; x: number; y: number; font: string; color: string; maxWidth: number };

export type CardLayout = {
  width: number;
  height: number;
  u: number;
  fontFamily: string;
  avatar: Rect;
  name: TextRun;
  username: TextRun;
  headline: { lines: TextRun[]; lineHeight: number; font: string; scale: number };
  media: Rect;
  /** Uma área para imagem/vídeo; duas para "Duas imagens lado a lado". */
  slots: Rect[];
  divider: Rect | null;
  /** Selo ao lado do nome (círculo), quando ligado. */
  badge: Rect | null;
  watermarkAnchor: { x: number; y: number; align: "left" | "right"; size: number; maxWidth: number } | null;
  safeArea: Rect;
  /** Problemas que IMPEDEM exportar (nunca truncar em silêncio). */
  blocking: CardIssue[];
  warnings: CardIssue[];
};

export type CardIssue = { code: string; message: string };

export const CARD_FONT_FAMILY = `"Inter", "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;

const M = {
  padX: 48,
  padTop: 44,
  avatar: 104,
  avatarGap: 24,
  nameSize: 40,
  usernameSize: 36,
  nameUserGap: 12,
  headlineSize: 42,
  headlineLine: 1.28,
  headlineTop: 10,
  headerBottomGap: 32,
  dividerWidth: 6,
  watermarkSize: 28,
  /** Selo: diâmetro relativo ao corpo do nome e espaço até o nome (6–8 px na largura 1080). */
  badgeRatio: 0.8,
  badgeGap: 7,
  minMediaRatio: 0.35,
} as const;

/** Área segura para formato vertical (interface dos Reels cobre topo e base). */
const VERTICAL_SAFE = { top: 0.1, bottom: 0.2 };

const graphemes = (s: string): string[] => {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  return Seg ? Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(s), (x) => x.segment) : Array.from(s);
};

/** Corta com reticências respeitando grafemas (emoji compostos não são partidos). */
export function ellipsize(text: string, maxWidth: number, font: string, measure: TextMeasurer): string {
  if (measure(text, font) <= maxWidth) return text;
  const g = graphemes(text);
  let lo = 0;
  let hi = g.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(g.slice(0, mid).join("").trimEnd() + "…", font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "…" : g.slice(0, lo).join("").trimEnd() + "…";
}

/**
 * Quebra de linha natural: respeita quebras explícitas (\n), quebra por palavras e, se uma
 * palavra sozinha não couber, quebra por grafema (nunca no meio de um emoji composto).
 */
export function wrapText(text: string, maxWidth: number, font: string, measure: TextMeasurer): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/(\s+)/).filter((w) => w.length)) {
      const candidate = line + word;
      if (measure(candidate.trimEnd(), font) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = /^\s+$/.test(word) ? "" : word;
      // Palavra maior que a linha inteira: quebra por grafema.
      while (measure(line, font) > maxWidth) {
        const g = graphemes(line);
        let n = g.length - 1;
        while (n > 1 && measure(g.slice(0, n).join(""), font) > maxWidth) n--;
        out.push(g.slice(0, n).join(""));
        line = g.slice(n).join("");
      }
    }
    out.push(line.trimEnd());
  }
  // Remove linhas vazias no fim (evita espaço fantasma).
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "").replace(/\s+/g, "");
}

export function validateCardText(c: Pick<CardContent, "pageName" | "username" | "headline">): CardIssue[] {
  const issues: CardIssue[] = [];
  if (!c.pageName.trim()) issues.push({ code: "page_name_required", message: "Informe o nome da página." });
  if (graphemes(c.pageName).length > PAGE_NAME_MAX_CHARS) issues.push({ code: "page_name_too_long", message: `Nome da página com no máximo ${PAGE_NAME_MAX_CHARS} caracteres.` });
  const user = normalizeUsername(c.username);
  if (!user) issues.push({ code: "username_required", message: "Informe o @usuário." });
  else if (!/^[\p{L}\p{N}._]+$/u.test(user)) issues.push({ code: "username_invalid", message: "O @usuário aceita letras, números, ponto e sublinhado." });
  else if (user.length > USERNAME_MAX_CHARS) issues.push({ code: "username_too_long", message: `@usuário com no máximo ${USERNAME_MAX_CHARS} caracteres.` });
  if (!c.headline.trim()) issues.push({ code: "headline_required", message: "Escreva a manchete." });
  if (graphemes(c.headline).length > HEADLINE_MAX_CHARS) {
    issues.push({ code: "headline_too_long", message: `A manchete tem ${graphemes(c.headline).length} caracteres; o limite é ${HEADLINE_MAX_CHARS}.` });
  }
  return issues;
}

export const headlineLength = (s: string) => graphemes(s).length;

export function computeCardLayout(content: CardContent, styleIn: Partial<CardStyle>, measure: TextMeasurer): CardLayout {
  const style: CardStyle = { ...DEFAULT_CARD_STYLE, ...styleIn, watermark: { ...DEFAULT_CARD_STYLE.watermark, ...(styleIn.watermark ?? {}) } };
  const { width, height } = CARD_FORMATS[content.format];
  const u = width / 1080;
  const f = CARD_FONT_FAMILY;
  const blocking: CardIssue[] = validateCardText(content);
  const warnings: CardIssue[] = [];

  const isVertical = content.format === "vertical";
  // Versão 2 no vertical: tudo que identifica o perfil fica dentro da área segura dos Reels.
  const reels = usesReelsLayout(content);
  const R = { side: REELS_SAFE_AREA.side * u, top: REELS_SAFE_AREA.top * u, bottom: REELS_SAFE_AREA.bottom * u, rail: REELS_SAFE_AREA.rightRail * u };
  const padX = reels ? R.side : M.padX * u;
  const safeArea: Rect = reels
    ? { x: R.side, y: R.top, w: width - 2 * R.side, h: height - R.top - R.bottom }
    : isVertical
      ? { x: M.padX * u, y: height * VERTICAL_SAFE.top, w: width - 2 * M.padX * u, h: height * (1 - VERTICAL_SAFE.top - VERTICAL_SAFE.bottom) }
      : { x: M.padX * u, y: M.padTop * u, w: width - 2 * M.padX * u, h: height - 2 * M.padTop * u };

  const top = isVertical ? safeArea.y : M.padTop * u;
  // V2: o vídeo vai até a base do canvas (pode ficar atrás da legenda do Instagram); só a identidade é protegida.
  const bottomPadding = reels
    ? 0
    : Math.max(clamp(style.bottomPadding, 0, 240) * u, isVertical ? height * VERTICAL_SAFE.bottom : 0);

  const avatarSize = M.avatar * u;
  const avatar: Rect = { x: padX, y: top, w: avatarSize, h: avatarSize };
  const colX = avatar.x + avatarSize + M.avatarGap * u;
  const colW = width - colX - padX;

  const nameFont = `700 ${Math.round(M.nameSize * u)}px ${f}`;
  const userFont = `400 ${Math.round(M.usernameSize * u)}px ${f}`;
  const userText = "@" + normalizeUsername(content.username);
  const nameText = content.pageName.trim();
  const nameBase = top + M.nameSize * u * 1.05; // linha de base do nome
  const gap = M.nameUserGap * u;

  let name: TextRun;
  let username: TextRun;
  let afterHeaderY: number;
  // Selo (opcional) logo depois do nome, na mesma linha: ocupa largura que o nome não pode usar.
  const badgeOn = Boolean(style.badge?.enabled);
  const badgeSize = badgeOn ? Math.round(M.nameSize * u * M.badgeRatio) : 0;
  const badgeGap = badgeOn ? Math.round(M.badgeGap * u) : 0;
  const badgeW = badgeSize + badgeGap;
  const nameW = measure(nameText, nameFont);
  const userW = measure(userText, userFont);
  let nameDrawnW = nameW;
  if (nameW + badgeW + gap + userW <= colW) {
    // Nome e @ lado a lado (padrão das referências).
    name = { text: nameText, x: colX, y: nameBase, font: nameFont, color: CLASSIC_COLORS.name, maxWidth: nameW };
    username = { text: userText, x: colX + nameW + badgeW + gap, y: nameBase, font: userFont, color: CLASSIC_COLORS.username, maxWidth: colW - nameW - badgeW - gap };
    afterHeaderY = nameBase;
  } else {
    // Não cabem juntos: @ vai para a linha de baixo; ambos com reticências se preciso. Nunca sobre a manchete.
    const nameFit = ellipsize(nameText, colW - badgeW, nameFont, measure);
    nameDrawnW = measure(nameFit, nameFont);
    const userFit = ellipsize(userText, colW, userFont, measure);
    if (nameFit !== nameText) warnings.push({ code: "page_name_truncated", message: "O nome da página foi abreviado com reticências para caber." });
    if (userFit !== userText) warnings.push({ code: "username_truncated", message: "O @usuário foi abreviado com reticências para caber." });
    name = { text: nameFit, x: colX, y: nameBase, font: nameFont, color: CLASSIC_COLORS.name, maxWidth: colW - badgeW };
    const userBase = nameBase + M.usernameSize * u * 1.25;
    username = { text: userFit, x: colX, y: userBase, font: userFont, color: CLASSIC_COLORS.username, maxWidth: colW };
    afterHeaderY = userBase;
  }
  // Centro vertical do selo = meio da altura das maiúsculas do nome (~0,72 do corpo).
  const badge: Rect | null = badgeOn
    ? { x: colX + nameDrawnW + badgeGap, y: nameBase - M.nameSize * u * 0.36 - badgeSize / 2, w: badgeSize, h: badgeSize }
    : null;

  // Manchete: tamanho escolhido pelo usuário (redução EXPLÍCITA; nunca automática nem truncada).
  const scale = clamp(style.headlineScale, 0.7, 1);
  const hSize = Math.round(M.headlineSize * u * scale);
  const headlineFont = `400 ${hSize}px ${f}`;
  const lineHeight = Math.round(hSize * M.headlineLine);
  const lines = wrapText(content.headline, colW, headlineFont, measure);
  const firstBase = afterHeaderY + M.headlineTop * u + lineHeight;
  const headlineRuns: TextRun[] = lines.map((text, i) => ({ text, x: colX, y: firstBase + i * lineHeight, font: headlineFont, color: CLASSIC_COLORS.headline, maxWidth: colW }));
  const textBottom = Math.max(avatar.y + avatarSize, (headlineRuns.at(-1)?.y ?? afterHeaderY) + hSize * 0.3);

  const mediaTop = Math.round(textBottom + M.headerBottomGap * u);
  const mediaBottom = Math.round(height - bottomPadding);
  const media: Rect = { x: 0, y: mediaTop, w: width, h: Math.max(0, mediaBottom - mediaTop) };
  if (media.h < height * M.minMediaRatio) {
    blocking.push({
      code: "headline_overflow",
      message:
        scale > 0.7
          ? "A manchete ocupa espaço demais e a mídia ficaria pequena. Encurte o texto ou reduza a fonte da manchete."
          : "A manchete não cabe neste formato mesmo com a fonte mínima. Encurte o texto ou use um formato mais alto.",
    });
  }

  let slots: Rect[] = [media];
  let divider: Rect | null = null;
  if (content.mediaKind === "image_pair") {
    const d = Math.max(2, Math.round(M.dividerWidth * u));
    const half = Math.floor((media.w - d) / 2);
    slots = [
      { x: media.x, y: media.y, w: half, h: media.h },
      { x: media.x + half + d, y: media.y, w: media.w - half - d, h: media.h },
    ];
    divider = { x: media.x + half, y: media.y, w: d, h: media.h };
  }

  let watermarkAnchor: CardLayout["watermarkAnchor"] = null;
  // V2: sem marca-d'água inferior (ficaria atrás da interface do Instagram); o @ já está no cabeçalho.
  if (!reels && style.watermark.kind !== "none") {
    const size = M.watermarkSize * u;
    const inPadding = bottomPadding >= size * 2;
    const y = inPadding ? mediaBottom + bottomPadding / 2 : mediaBottom - size;
    const right = style.watermark.position === "bottom-right";
    watermarkAnchor = { x: right ? width - M.padX * u : M.padX * u, y, align: right ? "right" : "left", size, maxWidth: width / 2 };
  }

  return {
    width,
    height,
    u,
    fontFamily: f,
    avatar,
    name,
    username,
    headline: { lines: headlineRuns, lineHeight, font: headlineFont, scale },
    media,
    slots,
    divider,
    badge,
    watermarkAnchor,
    safeArea,
    blocking,
    warnings,
  };
}

/**
 * Retângulo de origem para desenhar uma mídia num slot sem distorcer.
 * cover: recorta a sobra respeitando o ponto focal; contain: mostra tudo (sobra fica com o fundo).
 */
export function fitMedia(
  src: { width: number; height: number },
  slot: Rect,
  fit: CardFit,
  focal: FocalPoint = { x: 0.5, y: 0.5 },
): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } {
  const sr = src.width / src.height;
  const dr = slot.w / slot.h;
  if (fit === "contain") {
    const dw = sr > dr ? slot.w : slot.h * sr;
    const dh = sr > dr ? slot.w / sr : slot.h;
    return { sx: 0, sy: 0, sw: src.width, sh: src.height, dx: slot.x + (slot.w - dw) / 2, dy: slot.y + (slot.h - dh) / 2, dw, dh };
  }
  const sw = sr > dr ? src.height * dr : src.width;
  const sh = sr > dr ? src.height : src.width / dr;
  const fx = clamp(focal.x, 0, 1);
  const fy = clamp(focal.y, 0, 1);
  return { sx: (src.width - sw) * fx, sy: (src.height - sh) * fy, sw, sh, dx: slot.x, dy: slot.y, dw: slot.w, dh: slot.h };
}

/** Restrições por rede ANTES de agendar (não prometer publicação universal). */
export function cardPublishRestrictions(format: CardFormat, kind: CardMediaKind): CardIssue[] {
  const out: CardIssue[] = [];
  if (kind !== "video" && format === "vertical") {
    out.push({
      code: "ig_feed_image_ratio",
      message: "Imagem 9:16 não é aceita no feed do Instagram (proporção permitida: 4:5 a 1,91:1). Use 4:5 ou 1:1, ou publique como vídeo.",
    });
  }
  if (kind !== "video") {
    out.push({ code: "image_needs_zernio", message: "Cards em imagem são publicados pelas contas conectadas via Zernio; o conector direto do Instagram publica apenas Reels (vídeo)." });
  }
  return out;
}
